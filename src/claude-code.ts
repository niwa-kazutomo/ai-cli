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
    return ["--session-id", session.claudeSessionId];
  }
  return ["--resume", session.claudeSessionId];
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

  markClaudeUsed(session);

  if (result.exitCode !== 0) {
    throw new Error(
      `Claude Code のプラン生成が失敗しました (exit code: ${result.exitCode})\n${result.stderr}`,
    );
  }

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

  markClaudeUsed(session);

  if (result.exitCode !== 0) {
    throw new Error(
      `Claude Code のコード生成が失敗しました (exit code: ${result.exitCode})\n${result.stderr}`,
    );
  }

  return { response: extractResponse(result.stdout), raw: result };
}
