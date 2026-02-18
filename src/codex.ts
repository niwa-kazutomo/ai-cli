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
 * item.completed の agent_message テキストを結合して返す。
 * JSONL パース失敗時や抽出失敗時は stdout をそのまま返す。
 */
export function extractResponse(stdout: string): string {
  try {
    const lines = stdout.trim().split("\n");
    const texts: string[] = [];

    for (const line of lines) {
      if (!line.trim()) continue;
      const parsed = JSON.parse(line);
      // item.completed の agent_message からテキスト抽出
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
 * staged + unstaged + untracked の差分を収集する。
 */
export async function getGitDiff(cwd: string, maxLength = 50_000): Promise<string> {
  const unstaged = await runCli("git", { args: ["diff"], cwd, timeoutMs: 30_000 });
  const staged = await runCli("git", { args: ["diff", "--cached"], cwd, timeoutMs: 30_000 });

  const parts: string[] = [];
  if (staged.exitCode === 0 && staged.stdout.trim()) {
    parts.push("## Staged Changes\n" + staged.stdout);
  }
  if (unstaged.exitCode === 0 && unstaged.stdout.trim()) {
    parts.push("## Unstaged Changes\n" + unstaged.stdout);
  }

  // Untracked files: git diff では拾えないため個別に差分化
  const MAX_UNTRACKED_FILES = 50;
  const untrackedList = await runCli("git", {
    args: ["ls-files", "--others", "--exclude-standard"],
    cwd,
    timeoutMs: 30_000,
  });
  if (untrackedList.exitCode === 0 && untrackedList.stdout.trim()) {
    const allFiles = untrackedList.stdout.trim().split("\n").filter(Boolean);
    const files = allFiles.slice(0, MAX_UNTRACKED_FILES);
    const untrackedDiffs: string[] = [];
    for (const file of files) {
      const diff = await runCli("git", {
        args: ["diff", "--no-index", "--", "/dev/null", file],
        cwd,
        timeoutMs: 10_000,
      });
      // git diff --no-index は差分ありで exitCode=1 が正常
      if ((diff.exitCode === 0 || diff.exitCode === 1) && diff.stdout.trim()) {
        untrackedDiffs.push(diff.stdout);
      }
    }
    if (untrackedDiffs.length > 0) {
      const header = allFiles.length > MAX_UNTRACKED_FILES
        ? `## Untracked Files (${MAX_UNTRACKED_FILES}/${allFiles.length} files, remaining omitted)\n`
        : "## Untracked Files\n";
      parts.push(header + untrackedDiffs.join("\n"));
    }
  }

  let combined = parts.join("\n\n");
  if (combined.length > maxLength) {
    combined = combined.slice(0, maxLength) + "\n\n... (差分が長すぎるため省略されました)";
  }
  return combined;
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
  // item ID ごとに最新テキストを Map で管理し、全 item のテキストを join して delta を算出
  const lineBuffer = new StreamJsonLineBuffer();
  const allEvents: import("./stream-json-parser.js").StreamJsonEvent[] = [];
  const itemTexts = new Map<string, string>();
  const itemOrder: string[] = [];
  let cumulativeText = "";
  let prevEmittedLength = 0;

  const processEvent = (event: import("./stream-json-parser.js").StreamJsonEvent) => {
    allEvents.push(event);
    const text = extractTextFromCodexEvent(event);
    if (text === null) return;

    // item.id がないイベントは無視（衝突防止）
    const itemId = event.item?.id;
    if (typeof itemId !== "string") return;

    if (!itemTexts.has(itemId)) {
      itemOrder.push(itemId);
    }
    itemTexts.set(itemId, text);

    // 全 item のテキストを結合して cumulativeText を再構築
    cumulativeText = itemOrder
      .map(id => itemTexts.get(id)!)
      .filter(t => t)
      .join("\n");

    // 縮退ガード: item.updated でテキストが短くなった場合に対応
    if (cumulativeText.length < prevEmittedLength) {
      prevEmittedLength = 0;
    }

    const delta = cumulativeText.slice(prevEmittedLength);
    if (delta) {
      options.onStdout?.(delta);
      prevEmittedLength = cumulativeText.length;
    }
  };

  const result = await runCli("codex", {
    args,
    cwd: options.cwd,
    onStdout: (chunk: string) => {
      const events = lineBuffer.feed(chunk);
      for (const event of events) {
        processEvent(event);
      }
    },
    onStderr: options.onStderr,
  });

  // 残バッファ処理
  const flushed = lineBuffer.flush();
  for (const event of flushed) {
    processEvent(event);
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

  const response = streamResult?.response?.trim()
    ? streamResult.response
    : extractResponse(result.stdout);
  return { response, raw: result };
}

/**
 * コードレビュー
 */
export async function reviewCode(
  prompt: string,
  options: CodexOptions,
): Promise<{ response: string; raw: CliRunResult }> {
  const args = ["exec", "--sandbox", "read-only", "--json"];

  if (options.model) {
    args.push("--model", options.model);
  }

  args.push(prompt);

  const { result, streamResult } = await runCodexWithStreaming(args, options);

  if (result.exitCode !== 0) {
    throw new Error(
      `Codex のコードレビューが失敗しました (exit code: ${result.exitCode})\n${result.stderr}`,
    );
  }

  const response = streamResult?.response?.trim()
    ? streamResult.response
    : extractResponse(result.stdout);
  return { response, raw: result };
}
