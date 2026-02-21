import { runCli } from "../cli-runner.js";
import type { CliRunResult } from "../types.js";
import type {
  CliBackend,
  CliBackendConfig,
  RunOptions,
  BackendRunResult,
} from "./backend.js";
import {
  StreamJsonLineBuffer,
  extractTextFromCodexEvent,
  extractFromCodexStreamEvents,
  type StreamJsonEvent,
  type StreamJsonResult,
} from "../stream-json-parser.js";
import * as logger from "../logger.js";

/**
 * Codex の JSONL 出力からレスポンステキストを抽出する。
 */
export function extractCodexResponse(stdout: string): string {
  try {
    const lines = stdout.trim().split("\n");
    const texts: string[] = [];

    for (const line of lines) {
      if (!line.trim()) continue;
      const parsed = JSON.parse(line);
      if (
        parsed.type === "item.completed" &&
        parsed.item?.type === "agent_message" &&
        typeof parsed.item.text === "string"
      ) {
        texts.push(parsed.item.text);
      }
    }

    if (texts.length > 0) {
      return texts.join("\n");
    }

    return stdout;
  } catch {
    logger.debug("Codex の JSONL パースに失敗、生テキストにフォールバック");
    return stdout;
  }
}

/**
 * Codex の JSONL 出力からセッション ID を抽出する。
 */
export function extractCodexSessionId(jsonlOutput: string): string | null {
  const lines = jsonlOutput.trim().split("\n");
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line);
      if (parsed.type === "thread.started" && typeof parsed.thread_id === "string") {
        return parsed.thread_id;
      }
      if (typeof parsed.session_id === "string") {
        return parsed.session_id;
      }
    } catch {
      continue;
    }
  }
  return null;
}

export class CodexCliBackend implements CliBackend {
  private readonly config: CliBackendConfig;

  constructor(config: CliBackendConfig) {
    this.config = config;
  }

  async run(options: RunOptions): Promise<BackendRunResult> {
    const args = this.buildArgs(options);
    const { result, streamResult } = await this.runWithStreaming(args);

    // 一次ソース: streamResult
    if (streamResult?.response?.trim()) {
      return {
        raw: result,
        response: streamResult.response,
        sessionId: streamResult.sessionId,
        extractionSucceeded: true,
      };
    }

    // フォールバック: stdout の JSONL パース
    const response = extractCodexResponse(result.stdout);
    const sessionId = streamResult?.sessionId ?? extractCodexSessionId(result.stdout);
    // agent_message が見つからず生 stdout を返した場合は false
    const extractionSucceeded = response !== result.stdout;
    return { raw: result, response, sessionId, extractionSucceeded };
  }

  private buildArgs(options: RunOptions): string[] {
    if (options.resumeSessionId) {
      const args = ["exec", "resume", options.resumeSessionId, "--json"];
      if (this.config.model) args.push("--model", this.config.model);
      args.push(options.prompt);
      return args;
    }

    // operation 別の sandbox 決定
    let sandbox: string;
    switch (options.hints.operation) {
      case "generatePlan":
      case "generateCode":
        sandbox = options.hints.dangerous
          ? "danger-full-access"
          : "workspace-write";
        break;
      case "reviewPlan":
      case "judge":
        sandbox = "read-only";
        break;
      case "reviewCode":
        sandbox = options.hints.sandboxMode ?? "workspace-write";
        break;
    }

    const args = ["exec", "--sandbox", sandbox, "--json"];
    if (this.config.model) args.push("--model", this.config.model);
    args.push(options.prompt);
    return args;
  }

  private async runWithStreaming(
    args: string[],
  ): Promise<{ result: CliRunResult; streamResult?: StreamJsonResult }> {
    if (!this.config.streaming) {
      const result = await runCli("codex", {
        args,
        cwd: this.config.cwd,
        onStdout: this.config.onStdout,
        onStderr: this.config.onStderr,
      });
      return { result };
    }

    const lineBuffer = new StreamJsonLineBuffer();
    const allEvents: StreamJsonEvent[] = [];
    const itemTexts = new Map<string, string>();
    const itemOrder: string[] = [];
    let cumulativeText = "";
    let prevEmittedLength = 0;

    const processEvent = (event: StreamJsonEvent) => {
      allEvents.push(event);
      const text = extractTextFromCodexEvent(event);
      if (text === null) return;

      const itemId = event.item?.id;
      if (typeof itemId !== "string") return;

      if (!itemTexts.has(itemId)) {
        itemOrder.push(itemId);
      }
      itemTexts.set(itemId, text);

      cumulativeText = itemOrder
        .map(id => itemTexts.get(id)!)
        .filter(t => t)
        .join("\n");

      if (cumulativeText.length < prevEmittedLength) {
        prevEmittedLength = 0;
      }

      const delta = cumulativeText.slice(prevEmittedLength);
      if (delta) {
        this.config.onStdout?.(delta);
        prevEmittedLength = cumulativeText.length;
      }
    };

    const result = await runCli("codex", {
      args,
      cwd: this.config.cwd,
      onStdout: (chunk: string) => {
        const events = lineBuffer.feed(chunk);
        for (const event of events) {
          processEvent(event);
        }
      },
      onStderr: this.config.onStderr,
    });

    const flushed = lineBuffer.flush();
    for (const event of flushed) {
      processEvent(event);
    }

    const streamResult = extractFromCodexStreamEvents(allEvents);
    return { result, streamResult };
  }
}
