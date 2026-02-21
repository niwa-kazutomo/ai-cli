import { runCli } from "../cli-runner.js";
import type { CliRunResult } from "../types.js";
import type {
  CliBackend,
  CliBackendConfig,
  RunOptions,
  BackendRunResult,
  OperationHints,
} from "./backend.js";
import {
  StreamJsonLineBuffer,
  extractTextFromEvent,
  extractFromStreamEvents,
  type StreamJsonEvent,
} from "../stream-json-parser.js";
import * as logger from "../logger.js";

/**
 * Claude Code の JSON レスポンスから session_id フィールドを抽出する。
 */
export function extractSessionId(stdout: string): string | null {
  try {
    const parsed = JSON.parse(stdout);
    if (typeof parsed === "object" && parsed !== null && typeof parsed.session_id === "string") {
      return parsed.session_id;
    }
  } catch {
    logger.debug("Claude Code の session_id 抽出: JSON パース失敗");
  }
  return null;
}

/**
 * Claude Code の JSON 出力からレスポンステキスト抽出を試行する。
 * parsed フラグで JSON パース成否を正確に返す。
 */
function tryExtractResponse(stdout: string): { response: string; parsed: boolean } {
  try {
    const obj = JSON.parse(stdout);
    if (typeof obj === "object" && obj !== null) {
      if (typeof obj.result === "string") return { response: obj.result, parsed: true };
      if (Array.isArray(obj.content)) {
        const text = obj.content
          .filter((b: { type: string }) => b.type === "text")
          .map((b: { text: string }) => b.text)
          .join("\n");
        return { response: text, parsed: true };
      }
      if (typeof obj.text === "string") return { response: obj.text, parsed: true };
    }
    return { response: typeof obj === "string" ? obj : JSON.stringify(obj), parsed: true };
  } catch {
    return { response: stdout, parsed: false };
  }
}

/**
 * Claude Code の JSON 出力からレスポンステキストを抽出する。
 * 互換ラッパー: 内部で tryExtractResponse().response を返す。
 */
export function extractResponse(stdout: string): string {
  return tryExtractResponse(stdout).response;
}

export class ClaudeCliBackend implements CliBackend {
  private readonly config: CliBackendConfig;

  constructor(config: CliBackendConfig) {
    this.config = config;
  }

  async run(options: RunOptions): Promise<BackendRunResult> {
    const args = this.buildArgs(options);

    if (options.hints.operation === "judge") {
      // Judge: 非ストリーミング、プレーンテキスト
      const result = await runCli("claude", {
        args,
        cwd: this.config.cwd,
        onStdout: this.config.onStdout,
        onStderr: this.config.onStderr,
      });
      return {
        raw: result,
        response: result.stdout,
        sessionId: null,
        extractionSucceeded: true,
      };
    }

    const { result, streamResult } = await this.runWithFormat(args);

    // 一次ソース: streamResult（ストリーミング有効かつ実質的な内容がある場合）
    if (streamResult && (streamResult.response.trim().length > 0 || streamResult.sessionId !== null)) {
      return {
        raw: result,
        response: streamResult.response,
        sessionId: streamResult.sessionId,
        extractionSucceeded: true,
      };
    }

    // フォールバック: stdout の JSON パース
    const { response, parsed } = tryExtractResponse(result.stdout);
    const sessionId = extractSessionId(result.stdout);
    return { raw: result, response, sessionId, extractionSucceeded: parsed };
  }

  private buildArgs(options: RunOptions): string[] {
    const args: string[] = ["--print"];

    // Judge: --output-format json を付けない（プレーンテキスト出力）
    if (options.hints.operation !== "judge") {
      args.push("--output-format", "json");
    }

    // セッション再開
    if (options.resumeSessionId) {
      args.push("--resume", options.resumeSessionId);
    }

    // operation 別の引数
    switch (options.hints.operation) {
      case "generateCode":
        if (options.hints.dangerous) {
          args.push("--dangerously-skip-permissions");
        } else {
          args.push("--permission-mode", "acceptEdits");
        }
        break;
      case "judge":
        args.push("--no-session-persistence");
        break;
      // generatePlan, reviewPlan, reviewCode: 追加引数なし
    }

    if (this.config.model) args.push("--model", this.config.model);
    args.push(options.prompt);
    return args;
  }

  private async runWithFormat(
    args: string[],
  ): Promise<{ result: CliRunResult; streamResult?: { response: string; sessionId: string | null } }> {
    if (!this.config.streaming) {
      const result = await runCli("claude", {
        args,
        cwd: this.config.cwd,
        onStdout: this.config.onStdout,
        onStderr: this.config.onStderr,
      });
      return { result };
    }

    // ストリーミング: stream-json に差し替え
    const streamArgs = args.map((arg, i) => {
      if (arg === "json" && i > 0 && args[i - 1] === "--output-format") {
        return "stream-json";
      }
      return arg;
    });
    streamArgs.push("--verbose", "--include-partial-messages");

    const lineBuffer = new StreamJsonLineBuffer();
    const allEvents: StreamJsonEvent[] = [];
    let prevEmittedLength = 0;
    let prevExtractedText = "";
    let hasEmittedText = false;
    let lastEmittedEndsWithNewline = false;

    const processEvent = (event: StreamJsonEvent) => {
      const currentText = extractTextFromEvent(event);
      if (currentText === null) return;

      if (prevExtractedText !== "" && !currentText.startsWith(prevExtractedText)) {
        this.config.onStdout?.("\n");
        hasEmittedText = true;
        lastEmittedEndsWithNewline = true;
        prevEmittedLength = 0;
      }

      const delta = currentText.slice(prevEmittedLength);
      if (delta.length > 0) {
        this.config.onStdout?.(delta);
        prevEmittedLength = currentText.length;
        hasEmittedText = true;
        lastEmittedEndsWithNewline = delta.endsWith("\n");
      }
      prevExtractedText = currentText;
    };

    const result = await runCli("claude", {
      args: streamArgs,
      cwd: this.config.cwd,
      onStdout: (chunk: string) => {
        const events = lineBuffer.feed(chunk);
        allEvents.push(...events);
        for (const event of events) {
          processEvent(event);
        }
      },
      onStderr: this.config.onStderr,
    });

    const remaining = lineBuffer.flush();
    allEvents.push(...remaining);
    for (const event of remaining) {
      processEvent(event);
    }

    if (hasEmittedText && !lastEmittedEndsWithNewline) {
      this.config.onStdout?.("\n");
    }

    const streamResult = extractFromStreamEvents(allEvents);
    return { result, streamResult };
  }

  /**
   * buildArgs() と同一の分岐ロジックで必要フラグを導出。
   */
  static getRequiredFlags(operations: OperationHints[], dangerous: boolean): string[] {
    const flags = new Set<string>(["--print"]);
    for (const op of operations) {
      switch (op.operation) {
        case "generatePlan":
        case "reviewPlan":
        case "reviewCode":
          flags.add("--output-format");
          flags.add("--resume");
          break;
        case "generateCode":
          flags.add("--output-format");
          flags.add("--resume");
          if (dangerous) {
            flags.add("--dangerously-skip-permissions");
          } else {
            flags.add("--permission-mode");
          }
          break;
        case "judge":
          flags.add("--no-session-persistence");
          break;
      }
    }
    return [...flags];
  }
}
