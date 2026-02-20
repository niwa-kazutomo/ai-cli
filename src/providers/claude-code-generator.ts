import { runCli } from "../cli-runner.js";
import type { CliRunResult } from "../types.js";
import type { Generator, ProviderResult } from "./types.js";
import {
  StreamJsonLineBuffer,
  extractTextFromEvent,
  extractFromStreamEvents,
  type StreamJsonEvent,
} from "../stream-json-parser.js";
import * as logger from "../logger.js";

export interface ClaudeCodeGeneratorConfig {
  cwd: string;
  model?: string;
  dangerous?: boolean;
  streaming?: boolean;
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
}

export class ClaudeCodeGenerator implements Generator {
  private sessionId: string | null = null;
  private firstRun = true;
  private readonly config: ClaudeCodeGeneratorConfig;

  constructor(config: ClaudeCodeGeneratorConfig) {
    this.config = config;
  }

  async generatePlan(prompt: string): Promise<ProviderResult> {
    const args = [
      "--print",
      "--output-format",
      "json",
      ...this.buildSessionArgs(),
    ];

    if (this.config.model) {
      args.push("--model", this.config.model);
    }

    args.push(prompt);

    const { result, streamResult } = await this.runWithFormat(args);

    if (result.exitCode !== 0) {
      throw new Error(
        `Claude Code のプラン生成が失敗しました (exit code: ${result.exitCode})\n${result.stderr}`,
      );
    }

    // 初回実行時: レスポンスから session_id を取得
    if (this.firstRun) {
      const sessionId = streamResult?.sessionId ?? extractSessionId(result.stdout);
      if (!sessionId) {
        throw new Error(
          "Claude Code のレスポンスから session_id を取得できませんでした。セッション継続が必要なワークフローのため停止します。",
        );
      }
      this.sessionId = sessionId;
    }

    this.firstRun = false;

    const response = streamResult?.response ?? extractResponse(result.stdout);

    if (!response.trim()) {
      const summary = `exitCode: ${result.exitCode}, stdout(${result.stdout.length}chars): ${result.stdout.slice(0, 200)}${result.stdout.length > 200 ? "..." : ""}\nstderr(${result.stderr.length}chars): ${result.stderr.slice(-200)}`;
      logger.debug("generatePlan: 空レスポンス検出", summary);
    }

    return { response, raw: result };
  }

  async generateCode(prompt: string): Promise<ProviderResult> {
    const args = [
      "--print",
      "--output-format",
      "json",
      ...this.buildSessionArgs(),
    ];

    if (this.config.dangerous) {
      args.push("--dangerously-skip-permissions");
    } else {
      args.push("--permission-mode", "acceptEdits");
    }

    if (this.config.model) {
      args.push("--model", this.config.model);
    }

    args.push(prompt);

    const { result, streamResult } = await this.runWithFormat(args);

    if (result.exitCode !== 0) {
      throw new Error(
        `Claude Code のコード生成が失敗しました (exit code: ${result.exitCode})\n${result.stderr}`,
      );
    }

    // 初回実行時（通常ありえないが防御的に）: session_id を取得
    if (this.firstRun) {
      const sessionId = streamResult?.sessionId ?? extractSessionId(result.stdout);
      if (!sessionId) {
        throw new Error(
          "Claude Code のレスポンスから session_id を取得できませんでした。セッション継続が必要なワークフローのため停止します。",
        );
      }
      this.sessionId = sessionId;
    }

    this.firstRun = false;

    const response = streamResult?.response ?? extractResponse(result.stdout);
    return { response, raw: result };
  }

  private buildSessionArgs(): string[] {
    if (this.firstRun) {
      return [];
    }
    if (!this.sessionId) {
      throw new Error(
        "firstRun=false ですが sessionId が未設定です。セッション管理に不整合があります。",
      );
    }
    return ["--resume", this.sessionId];
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
}

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
 * Claude Code の JSON 出力からレスポンステキストを抽出する。
 */
export function extractResponse(stdout: string): string {
  try {
    const parsed = JSON.parse(stdout);
    if (typeof parsed === "object" && parsed !== null) {
      if (typeof parsed.result === "string") {
        return parsed.result;
      }
      if (Array.isArray(parsed.content)) {
        return parsed.content
          .filter(
            (block: { type: string; text?: string }) => block.type === "text",
          )
          .map((block: { text: string }) => block.text)
          .join("\n");
      }
      if (typeof parsed.text === "string") {
        return parsed.text;
      }
    }
    return typeof parsed === "string" ? parsed : JSON.stringify(parsed);
  } catch {
    logger.debug("Claude Code の JSON パースに失敗、生テキストにフォールバック");
    return stdout;
  }
}
