import { runCli } from "./cli-runner.js";

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
