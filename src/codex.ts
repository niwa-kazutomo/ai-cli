import { runCli } from "./cli-runner.js";
import type { CliRunResult, SessionState } from "./types.js";
import { extractCodexSessionId, markCodexUsed, buildSummaryContext } from "./session.js";
import * as logger from "./logger.js";

export interface CodexOptions {
  cwd: string;
  model?: string;
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

  const result = await runCli("codex", {
    args,
    cwd: options.cwd,
    onStdout: options.onStdout,
    onStderr: options.onStderr,
  });

  // 初回時にセッション ID 抽出を試行
  if (session.codexFirstRun) {
    const extractedId = extractCodexSessionId(result.stdout);
    if (extractedId) {
      session.codexSessionId = extractedId;
      logger.debug(`Codex セッション ID 抽出成功: ${extractedId}`);
    } else {
      logger.verbose("Codex セッション ID の抽出に失敗しました。フォールバックモードで継続します。");
    }
  }

  markCodexUsed(session);

  if (result.exitCode !== 0) {
    throw new Error(
      `Codex のプランレビューが失敗しました (exit code: ${result.exitCode})\n${result.stderr}`,
    );
  }

  return { response: extractResponse(result.stdout), raw: result };
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

  const result = await runCli("codex", {
    args,
    cwd: options.cwd,
    onStdout: options.onStdout,
    onStderr: options.onStderr,
  });

  if (result.exitCode !== 0) {
    throw new Error(
      `Codex のコードレビューが失敗しました (exit code: ${result.exitCode})\n${result.stderr}`,
    );
  }

  return { response: extractResponse(result.stdout), raw: result };
}
