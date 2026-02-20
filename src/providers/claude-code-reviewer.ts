import { runCli } from "../cli-runner.js";
import type { CliRunResult } from "../types.js";
import type { Reviewer, ProviderResult } from "./types.js";
import {
  StreamJsonLineBuffer,
  extractTextFromEvent,
  extractFromStreamEvents,
  type StreamJsonEvent,
} from "../stream-json-parser.js";
import { extractResponse, extractSessionId } from "./claude-code-generator.js";
import { buildSummaryContext } from "./codex-reviewer.js";
import * as logger from "../logger.js";

export interface ClaudeCodeReviewerConfig {
  cwd: string;
  model?: string;
  streaming?: boolean;
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
}

export class ClaudeCodeReviewer implements Reviewer {
  private sessionId: string | null = null;
  private firstRun = true;
  private readonly config: ClaudeCodeReviewerConfig;

  constructor(config: ClaudeCodeReviewerConfig) {
    this.config = config;
  }

  async reviewPlan(
    prompt: string,
    fallbackContext?: { planSummary: string; reviewSummary: string },
  ): Promise<ProviderResult> {
    const args = [
      "--print",
      "--output-format",
      "json",
    ];

    if (this.firstRun) {
      // 初回: 新規セッション
    } else if (this.sessionId) {
      args.push("--resume", this.sessionId);
    } else if (fallbackContext) {
      // セッション ID 抽出失敗: 要約コンテキストを付加
      const context = buildSummaryContext(
        fallbackContext.planSummary,
        fallbackContext.reviewSummary,
      );
      prompt = `${context}\n\n${prompt}`;
    }

    if (this.config.model) {
      args.push("--model", this.config.model);
    }

    args.push(prompt);

    const { result, streamResult } = await this.runWithFormat(args);

    if (result.exitCode !== 0) {
      throw new Error(
        `Claude Code のプランレビューが失敗しました (exit code: ${result.exitCode})\n${result.stderr}`,
      );
    }

    // 初回時にセッション ID 抽出を試行
    if (this.firstRun) {
      const sid = streamResult?.sessionId ?? extractSessionId(result.stdout);
      if (sid) {
        this.sessionId = sid;
        logger.debug(`Claude Reviewer セッション ID 抽出成功: ${sid}`);
      } else {
        logger.verbose("Claude Reviewer セッション ID の抽出に失敗しました。フォールバックモードで継続します。");
      }
    }

    this.firstRun = false;

    const response = streamResult?.response ?? extractResponse(result.stdout);
    return { response, raw: result };
  }

  async reviewCode(prompt: string): Promise<ProviderResult> {
    const args = [
      "--print",
      "--output-format",
      "json",
      "--no-session-persistence",
    ];

    if (this.config.model) {
      args.push("--model", this.config.model);
    }

    args.push(prompt);

    const { result, streamResult } = await this.runWithFormat(args);

    if (result.exitCode !== 0) {
      throw new Error(
        `Claude Code のコードレビューが失敗しました (exit code: ${result.exitCode})\n${result.stderr}`,
      );
    }

    const response = streamResult?.response ?? extractResponse(result.stdout);
    return { response, raw: result };
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
