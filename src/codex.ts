import { runCli } from "./cli-runner.js";
import type { CliRunResult, SessionState } from "./types.js";
import { extractCodexSessionId, markCodexUsed, buildSummaryContext } from "./session.js";
import {
  StreamJsonLineBuffer,
  extractTextFromCodexEvent,
  extractFromCodexStreamEvents,
  type StreamJsonResult,
} from "./stream-json-parser.js";
import * as logger from "./logger.js";

export interface CodexOptions {
  cwd: string;
  model?: string;
  streaming?: boolean;
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
}

/**
 * Codex の JSONL 出力からレスポンステキストを抽出する。
 * JSONL パース失敗時は stdout をそのまま返す。
 */
export function extractResponse(stdout: string): string {
  try {
    const lines = stdout.trim().split("\n");
    const texts: string[] = [];

    for (const line of lines) {
      if (!line.trim()) continue;
      const parsed = JSON.parse(line);
      // message 形式
      if (parsed.type === "message" && parsed.content) {
        if (typeof parsed.content === "string") {
          texts.push(parsed.content);
        } else if (Array.isArray(parsed.content)) {
          for (const block of parsed.content) {
            if (block.type === "text" && block.text) {
              texts.push(block.text);
            }
          }
        }
      }
      // output_text フィールド
      if (typeof parsed.output_text === "string") {
        texts.push(parsed.output_text);
      }
    }

    if (texts.length > 0) {
      return texts.join("\n");
    }

    // テキストが取れなかった場合は生出力
    return stdout;
  } catch {
    logger.debug("Codex の JSONL パースに失敗、生テキストにフォールバック");
    return stdout;
  }
}

/**
 * Git リポジトリ内かどうかを判定する。
 */
export async function checkGitRepo(cwd: string): Promise<boolean> {
  try {
    const result = await runCli("git", {
      args: ["rev-parse", "--is-inside-work-tree"],
      cwd,
      timeoutMs: 10_000,
    });
    return result.exitCode === 0 && result.stdout.trim() === "true";
  } catch {
    return false;
  }
}

/**
 * Git の変更があるかどうかを判定する（未追跡ファイル含む）。
 */
export async function checkGitChanges(cwd: string): Promise<boolean> {
  try {
    const result = await runCli("git", {
      args: ["status", "--porcelain"],
      cwd,
      timeoutMs: 10_000,
    });
    return result.exitCode === 0 && result.stdout.trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * Codex CLI をストリーミングモード対応で実行する。
 * streaming: true → JSONL をインターセプトしてテキスト差分のみ onStdout に送出
 * streaming: false → 現行動作（raw onStdout パススルー）
 */
async function runCodexWithStreaming(
  args: string[],
  options: CodexOptions,
): Promise<{ result: CliRunResult; streamResult?: StreamJsonResult }> {
  if (!options.streaming) {
    const result = await runCli("codex", {
      args,
      cwd: options.cwd,
      onStdout: options.onStdout,
      onStderr: options.onStderr,
    });
    return { result };
  }

  // ストリーミングモード: JSONL をインターセプトしてテキスト差分を送出
  const lineBuffer = new StreamJsonLineBuffer();
  const allEvents: import("./stream-json-parser.js").StreamJsonEvent[] = [];
  let cumulativeText = "";
  let prevEmittedLength = 0;

  const result = await runCli("codex", {
    args,
    cwd: options.cwd,
    onStdout: (chunk: string) => {
      const events = lineBuffer.feed(chunk);
      for (const event of events) {
        allEvents.push(event);
        const text = extractTextFromCodexEvent(event);
        if (text !== null) {
          if (cumulativeText.length > 0) {
            cumulativeText += "\n" + text;
          } else {
            cumulativeText = text;
          }
          const delta = cumulativeText.slice(prevEmittedLength);
          if (delta) {
            options.onStdout?.(delta);
            prevEmittedLength = cumulativeText.length;
          }
        }
      }
    },
    onStderr: options.onStderr,
  });

  // 残バッファ処理
  const flushed = lineBuffer.flush();
  for (const event of flushed) {
    allEvents.push(event);
    const text = extractTextFromCodexEvent(event);
    if (text !== null) {
      if (cumulativeText.length > 0) {
        cumulativeText += "\n" + text;
      } else {
        cumulativeText = text;
      }
      const delta = cumulativeText.slice(prevEmittedLength);
      if (delta) {
        options.onStdout?.(delta);
        prevEmittedLength = cumulativeText.length;
      }
    }
  }

  const streamResult = extractFromCodexStreamEvents(allEvents);
  return { result, streamResult };
}

/**
 * プランレビュー
 */
export async function reviewPlan(
  session: SessionState,
  prompt: string,
  options: CodexOptions,
  fallbackContext?: { planSummary: string; reviewSummary: string },
): Promise<{ response: string; raw: CliRunResult }> {
  let args: string[];

  if (session.codexFirstRun) {
    args = ["exec", "--sandbox", "read-only", "--json"];
  } else if (session.codexSessionId) {
    args = ["exec", "resume", session.codexSessionId, "--json"];
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

  if (options.model) {
    args.push("--model", options.model);
  }

  args.push(prompt);

  const { result, streamResult } = await runCodexWithStreaming(args, options);

  // exitCode チェック（失敗時は markCodexUsed を呼ばない）
  if (result.exitCode !== 0) {
    throw new Error(
      `Codex のプランレビューが失敗しました (exit code: ${result.exitCode})\n${result.stderr}`,
    );
  }

  // 初回時にセッション ID 抽出を試行
  if (session.codexFirstRun) {
    const extractedId = streamResult?.sessionId ?? extractCodexSessionId(result.stdout);
    if (extractedId) {
      session.codexSessionId = extractedId;
      logger.debug(`Codex セッション ID 抽出成功: ${extractedId}`);
    } else {
      logger.verbose("Codex セッション ID の抽出に失敗しました。フォールバックモードで継続します。");
    }
  }

  markCodexUsed(session);

  const response = streamResult?.response ?? extractResponse(result.stdout);
  return { response, raw: result };
}

/**
 * コードレビュー
 */
export async function reviewCode(
  options: CodexOptions,
): Promise<{ response: string; raw: CliRunResult }> {
  const args = ["exec", "review", "--uncommitted", "--json"];

  if (options.model) {
    args.push("--model", options.model);
  }

  const { result, streamResult } = await runCodexWithStreaming(args, options);

  if (result.exitCode !== 0) {
    throw new Error(
      `Codex のコードレビューが失敗しました (exit code: ${result.exitCode})\n${result.stderr}`,
    );
  }

  const response = streamResult?.response ?? extractResponse(result.stdout);
  return { response, raw: result };
}
