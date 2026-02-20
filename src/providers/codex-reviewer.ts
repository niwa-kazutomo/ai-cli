import { runCli } from "../cli-runner.js";
import type { CliRunResult, CodexSandboxMode } from "../types.js";
import type { Reviewer, ProviderResult } from "./types.js";
import {
  StreamJsonLineBuffer,
  extractTextFromCodexEvent,
  extractFromCodexStreamEvents,
  type StreamJsonEvent,
  type StreamJsonResult,
} from "../stream-json-parser.js";
import * as logger from "../logger.js";

export interface CodexReviewerConfig {
  cwd: string;
  model?: string;
  sandbox?: CodexSandboxMode;
  streaming?: boolean;
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
}

export class CodexReviewer implements Reviewer {
  private sessionId: string | null = null;
  private firstRun = true;
  private readonly config: CodexReviewerConfig;

  constructor(config: CodexReviewerConfig) {
    this.config = config;
  }

  async reviewPlan(
    prompt: string,
    fallbackContext?: { planSummary: string; reviewSummary: string },
  ): Promise<ProviderResult> {
    let args: string[];

    if (this.firstRun) {
      args = ["exec", "--sandbox", "read-only", "--json"];
    } else if (this.sessionId) {
      args = ["exec", "resume", this.sessionId, "--json"];
    } else if (fallbackContext) {
      // セッション ID 抽出失敗: 要約コンテキストを付加
      const context = buildSummaryContext(
        fallbackContext.planSummary,
        fallbackContext.reviewSummary,
      );
      prompt = `${context}\n\n${prompt}`;
      args = ["exec", "--sandbox", "read-only", "--json"];
    } else {
      args = ["exec", "--sandbox", "read-only", "--json"];
    }

    if (this.config.model) {
      args.push("--model", this.config.model);
    }

    args.push(prompt);

    const { result, streamResult } = await this.runWithStreaming(args);

    if (result.exitCode !== 0) {
      throw new Error(
        `Codex のプランレビューが失敗しました (exit code: ${result.exitCode})\n${result.stderr}`,
      );
    }

    // 初回時にセッション ID 抽出を試行
    if (this.firstRun) {
      const extractedId = streamResult?.sessionId ?? extractCodexSessionId(result.stdout);
      if (extractedId) {
        this.sessionId = extractedId;
        logger.debug(`Codex セッション ID 抽出成功: ${extractedId}`);
      } else {
        logger.verbose("Codex セッション ID の抽出に失敗しました。フォールバックモードで継続します。");
      }
    }

    this.firstRun = false;

    const response = streamResult?.response?.trim()
      ? streamResult.response
      : extractCodexResponse(result.stdout);
    return { response, raw: result };
  }

  async reviewCode(prompt: string): Promise<ProviderResult> {
    const sandboxMode = this.config.sandbox ?? "workspace-write";
    const args = ["exec", "--sandbox", sandboxMode, "--json"];

    if (this.config.model) {
      args.push("--model", this.config.model);
    }

    args.push(prompt);

    const { result, streamResult } = await this.runWithStreaming(args);

    if (result.exitCode !== 0) {
      throw new Error(
        `Codex のコードレビューが失敗しました (exit code: ${result.exitCode})\n${result.stderr}`,
      );
    }

    const response = streamResult?.response?.trim()
      ? streamResult.response
      : extractCodexResponse(result.stdout);
    return { response, raw: result };
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

/**
 * セッション ID 抽出失敗時のフォールバック用要約コンテキストを生成する。
 */
export function buildSummaryContext(
  planSummary: string,
  reviewSummary: string,
): string {
  return `## これまでの経緯\n\n### 計画の要約\n${planSummary}\n\n### レビューの要約\n${reviewSummary}`;
}
