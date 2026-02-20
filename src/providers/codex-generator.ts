import { runCli } from "../cli-runner.js";
import type { CliRunResult } from "../types.js";
import type { Generator, ProviderResult } from "./types.js";
import {
  StreamJsonLineBuffer,
  extractTextFromCodexEvent,
  extractFromCodexStreamEvents,
  type StreamJsonEvent,
  type StreamJsonResult,
} from "../stream-json-parser.js";
import { extractCodexResponse, extractCodexSessionId } from "./codex-reviewer.js";
import * as logger from "../logger.js";

export interface CodexGeneratorConfig {
  cwd: string;
  model?: string;
  dangerous?: boolean;
  streaming?: boolean;
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
}

export class CodexGenerator implements Generator {
  private sessionId: string | null = null;
  private readonly config: CodexGeneratorConfig;
  private readonly sandboxMode: string;

  constructor(config: CodexGeneratorConfig) {
    this.config = config;
    this.sandboxMode = config.dangerous ? "danger-full-access" : "workspace-write";
  }

  async generatePlan(prompt: string): Promise<ProviderResult> {
    let args: string[];

    if (this.sessionId) {
      args = ["exec", "resume", this.sessionId, "--json"];
    } else {
      args = ["exec", "--sandbox", this.sandboxMode, "--json"];
    }

    if (this.config.model) {
      args.push("--model", this.config.model);
    }

    args.push(prompt);

    const { result, streamResult } = await this.runWithStreaming(args);

    if (result.exitCode !== 0) {
      throw new Error(
        `Codex のプラン生成が失敗しました (exit code: ${result.exitCode})\n${result.stderr}`,
      );
    }

    // セッション ID 未取得時に抽出を試行
    if (!this.sessionId) {
      const extractedId = streamResult?.sessionId ?? extractCodexSessionId(result.stdout);
      if (extractedId) {
        this.sessionId = extractedId;
        logger.debug(`Codex Generator セッション ID 抽出成功: ${extractedId}`);
      } else {
        logger.verbose("Codex Generator セッション ID の抽出に失敗しました。次回は新規セッションで実行します。");
      }
    }

    const response = streamResult?.response?.trim()
      ? streamResult.response
      : extractCodexResponse(result.stdout);

    if (!response.trim()) {
      const summary = `exitCode: ${result.exitCode}, stdout(${result.stdout.length}chars): ${result.stdout.slice(0, 200)}${result.stdout.length > 200 ? "..." : ""}\nstderr(${result.stderr.length}chars): ${result.stderr.slice(-200)}`;
      logger.debug("CodexGenerator.generatePlan: 空レスポンス検出", summary);
    }

    return { response, raw: result };
  }

  async generateCode(prompt: string): Promise<ProviderResult> {
    let args: string[];

    if (this.sessionId) {
      args = ["exec", "resume", this.sessionId, "--json"];
    } else {
      // セッション未確立時は新規
      args = ["exec", "--sandbox", this.sandboxMode, "--json"];
    }

    if (this.config.model) {
      args.push("--model", this.config.model);
    }

    args.push(prompt);

    const { result, streamResult } = await this.runWithStreaming(args);

    if (result.exitCode !== 0) {
      throw new Error(
        `Codex のコード生成が失敗しました (exit code: ${result.exitCode})\n${result.stderr}`,
      );
    }

    // セッション ID 未取得時に抽出を試行（防御的）
    if (!this.sessionId) {
      const extractedId = streamResult?.sessionId ?? extractCodexSessionId(result.stdout);
      if (extractedId) {
        this.sessionId = extractedId;
        logger.debug(`Codex Generator セッション ID 抽出成功: ${extractedId}`);
      }
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
