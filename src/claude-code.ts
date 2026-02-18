import { runCli } from "./cli-runner.js";
import type { CliRunResult, SessionState } from "./types.js";
import { markClaudeUsed } from "./session.js";
import * as logger from "./logger.js";
import {
  StreamJsonLineBuffer,
  extractTextFromEvent,
  extractFromStreamEvents,
  type StreamJsonEvent,
} from "./stream-json-parser.js";

export interface ClaudeCodeOptions {
  cwd: string;
  model?: string;
  dangerous?: boolean;
  streaming?: boolean;
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
}

function buildSessionArgs(session: SessionState): string[] {
  if (session.claudeFirstRun) {
    // 初回は --session-id を渡さない（レスポンスから session_id を取得する）
    return [];
  }
  if (!session.claudeSessionId) {
    throw new Error(
      "claudeFirstRun=false ですが claudeSessionId が未設定です。セッション管理に不整合があります。",
    );
  }
  return ["--resume", session.claudeSessionId];
}

/**
 * Claude Code の JSON レスポンスから session_id フィールドを抽出する。
 * 抽出失敗時は null を返す。
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
 * JSON パース失敗時は stdout をそのまま返す。
 */
export function extractResponse(stdout: string): string {
  try {
    const parsed = JSON.parse(stdout);
    // --output-format json の応答形式
    if (typeof parsed === "object" && parsed !== null) {
      // result フィールドがある場合
      if (typeof parsed.result === "string") {
        return parsed.result;
      }
      // content が配列の場合（会話形式）
      if (Array.isArray(parsed.content)) {
        return parsed.content
          .filter(
            (block: { type: string; text?: string }) => block.type === "text",
          )
          .map((block: { text: string }) => block.text)
          .join("\n");
      }
      // text フィールドがある場合
      if (typeof parsed.text === "string") {
        return parsed.text;
      }
    }
    // パースはできたが既知のフィールドがない → 文字列化して返す
    return typeof parsed === "string" ? parsed : JSON.stringify(parsed);
  } catch {
    logger.debug("Claude Code の JSON パースに失敗、生テキストにフォールバック");
    return stdout;
  }
}

/**
 * stream-json / json 形式を切り替えて Claude CLI を実行するヘルパー。
 * streaming: true 時は stream-json + --verbose + --include-partial-messages を使い、
 * onStdout に差分テキストのみをリアルタイム転送する。
 */
async function runClaudeWithFormat(
  args: string[],
  options: ClaudeCodeOptions,
): Promise<{ result: CliRunResult; streamResult?: { response: string; sessionId: string | null } }> {
  if (!options.streaming) {
    // 非ストリーミング: 既存の json パス
    const result = await runCli("claude", {
      args,
      cwd: options.cwd,
      onStdout: options.onStdout,
      onStderr: options.onStderr,
    });
    return { result };
  }

  // ストリーミング: stream-json に差し替え
  const streamArgs = args.map((arg, i) => {
    // --output-format の次の引数 "json" を "stream-json" に差し替え
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

    // テキストの連続性を判定: 前回テキストの prefix でなければ内容変化
    if (prevExtractedText !== "" && !currentText.startsWith(prevExtractedText)) {
      // 新セクション開始: 改行セパレータを挿入
      options.onStdout?.("\n");
      hasEmittedText = true;
      lastEmittedEndsWithNewline = true;
      prevEmittedLength = 0;
    }

    const delta = currentText.slice(prevEmittedLength);
    if (delta.length > 0) {
      options.onStdout?.(delta);
      prevEmittedLength = currentText.length;
      hasEmittedText = true;
      lastEmittedEndsWithNewline = delta.endsWith("\n");
    }
    prevExtractedText = currentText;
  };

  const result = await runCli("claude", {
    args: streamArgs,
    cwd: options.cwd,
    onStdout: (chunk: string) => {
      const events = lineBuffer.feed(chunk);
      allEvents.push(...events);
      for (const event of events) {
        processEvent(event);
      }
    },
    onStderr: options.onStderr,
  });

  // プロセス終了時に残バッファを処理（差分出力も適用）
  const remaining = lineBuffer.flush();
  allEvents.push(...remaining);
  for (const event of remaining) {
    processEvent(event);
  }

  // ストリーミング出力が改行で終わっていない場合、改行を追加（後続の表示との分離）
  if (hasEmittedText && !lastEmittedEndsWithNewline) {
    options.onStdout?.("\n");
  }

  const streamResult = extractFromStreamEvents(allEvents);
  return { result, streamResult };
}

/**
 * プラン生成（初回または修正）
 */
export async function generatePlan(
  session: SessionState,
  prompt: string,
  options: ClaudeCodeOptions,
): Promise<{ response: string; raw: CliRunResult }> {
  const args = [
    "--print",
    "--output-format",
    "json",
    ...buildSessionArgs(session),
  ];

  if (options.model) {
    args.push("--model", options.model);
  }

  args.push(prompt);

  const { result, streamResult } = await runClaudeWithFormat(args, options);

  if (result.exitCode !== 0) {
    throw new Error(
      `Claude Code のプラン生成が失敗しました (exit code: ${result.exitCode})\n${result.stderr}`,
    );
  }

  // 初回実行時: レスポンスから session_id を取得
  if (session.claudeFirstRun) {
    const sessionId = streamResult?.sessionId ?? extractSessionId(result.stdout);
    if (!sessionId) {
      throw new Error(
        "Claude Code のレスポンスから session_id を取得できませんでした。セッション継続が必要なワークフローのため停止します。",
      );
    }
    session.claudeSessionId = sessionId;
  }

  markClaudeUsed(session);

  const response = streamResult?.response ?? extractResponse(result.stdout);

  if (!response.trim()) {
    const summary = `exitCode: ${result.exitCode}, stdout(${result.stdout.length}chars): ${result.stdout.slice(0, 200)}${result.stdout.length > 200 ? "..." : ""}\nstderr(${result.stderr.length}chars): ${result.stderr.slice(-200)}`;
    logger.debug("generatePlan: 空レスポンス検出", summary);
  }

  return { response, raw: result };
}

/**
 * コード生成（初回または修正）
 */
export async function generateCode(
  session: SessionState,
  prompt: string,
  options: ClaudeCodeOptions,
): Promise<{ response: string; raw: CliRunResult }> {
  const args = [
    "--print",
    "--output-format",
    "json",
    ...buildSessionArgs(session),
  ];

  if (options.dangerous) {
    args.push("--dangerously-skip-permissions");
  } else {
    args.push("--permission-mode", "acceptEdits");
  }

  if (options.model) {
    args.push("--model", options.model);
  }

  args.push(prompt);

  const { result, streamResult } = await runClaudeWithFormat(args, options);

  if (result.exitCode !== 0) {
    throw new Error(
      `Claude Code のコード生成が失敗しました (exit code: ${result.exitCode})\n${result.stderr}`,
    );
  }

  // 初回実行時（通常ありえないが防御的に）: session_id を取得
  if (session.claudeFirstRun) {
    const sessionId = streamResult?.sessionId ?? extractSessionId(result.stdout);
    if (!sessionId) {
      throw new Error(
        "Claude Code のレスポンスから session_id を取得できませんでした。セッション継続が必要なワークフローのため停止します。",
      );
    }
    session.claudeSessionId = sessionId;
  }

  markClaudeUsed(session);

  const response = streamResult?.response ?? extractResponse(result.stdout);
  return { response, raw: result };
}
