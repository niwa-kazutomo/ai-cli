import { runCli } from "./cli-runner.js";
import type { CliRunResult, SessionState } from "./types.js";
import { markClaudeUsed } from "./session.js";
import * as logger from "./logger.js";

export interface ClaudeCodeOptions {
  cwd: string;
  model?: string;
  dangerous?: boolean;
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
    "--permission-mode",
    "plan",
  ];

  if (options.model) {
    args.push("--model", options.model);
  }

  args.push(prompt);

  const result = await runCli("claude", {
    args,
    cwd: options.cwd,
    onStdout: options.onStdout,
    onStderr: options.onStderr,
  });

  if (result.exitCode !== 0) {
    throw new Error(
      `Claude Code のプラン生成が失敗しました (exit code: ${result.exitCode})\n${result.stderr}`,
    );
  }

  // 初回実行時: レスポンスから session_id を取得
  if (session.claudeFirstRun) {
    const sessionId = extractSessionId(result.stdout);
    if (!sessionId) {
      throw new Error(
        "Claude Code のレスポンスから session_id を取得できませんでした。セッション継続が必要なワークフローのため停止します。",
      );
    }
    session.claudeSessionId = sessionId;
  }

  markClaudeUsed(session);

  return { response: extractResponse(result.stdout), raw: result };
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

  const result = await runCli("claude", {
    args,
    cwd: options.cwd,
    onStdout: options.onStdout,
    onStderr: options.onStderr,
  });

  if (result.exitCode !== 0) {
    throw new Error(
      `Claude Code のコード生成が失敗しました (exit code: ${result.exitCode})\n${result.stderr}`,
    );
  }

  // 初回実行時（通常ありえないが防御的に）: session_id を取得
  if (session.claudeFirstRun) {
    const sessionId = extractSessionId(result.stdout);
    if (!sessionId) {
      throw new Error(
        "Claude Code のレスポンスから session_id を取得できませんでした。セッション継続が必要なワークフローのため停止します。",
      );
    }
    session.claudeSessionId = sessionId;
  }

  markClaudeUsed(session);

  return { response: extractResponse(result.stdout), raw: result };
}
