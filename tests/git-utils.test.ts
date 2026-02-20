import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/cli-runner.js", () => ({
  runCli: vi.fn(),
}));

vi.mock("../src/logger.js", () => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  verbose: vi.fn(),
  debug: vi.fn(),
}));

import { runCli } from "../src/cli-runner.js";
import { checkGitRepo, checkGitChanges, getGitDiff } from "../src/git-utils.js";

const mockRunCli = vi.mocked(runCli);

describe("checkGitRepo", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("Git リポジトリ内では true を返す", async () => {
    mockRunCli.mockResolvedValue({
      exitCode: 0,
      stdout: "true\n",
      stderr: "",
    });
    expect(await checkGitRepo("/tmp")).toBe(true);
  });

  it("Git リポジトリ外では false を返す", async () => {
    mockRunCli.mockResolvedValue({
      exitCode: 128,
      stdout: "",
      stderr: "fatal: not a git repository",
    });
    expect(await checkGitRepo("/tmp")).toBe(false);
  });

  it("コマンド失敗時は false を返す", async () => {
    mockRunCli.mockRejectedValue(new Error("command not found"));
    expect(await checkGitRepo("/tmp")).toBe(false);
  });
});

describe("checkGitChanges", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("変更がある場合は true を返す", async () => {
    mockRunCli.mockResolvedValue({
      exitCode: 0,
      stdout: "M file.ts\n",
      stderr: "",
    });
    expect(await checkGitChanges("/tmp")).toBe(true);
  });

  it("変更がない場合は false を返す", async () => {
    mockRunCli.mockResolvedValue({
      exitCode: 0,
      stdout: "",
      stderr: "",
    });
    expect(await checkGitChanges("/tmp")).toBe(false);
  });

  it("コマンド失敗時は false を返す", async () => {
    mockRunCli.mockRejectedValue(new Error("command not found"));
    expect(await checkGitChanges("/tmp")).toBe(false);
  });
});

describe("getGitDiff", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("staged + unstaged の diff を結合する", async () => {
    mockRunCli
      // unstaged (git diff)
      .mockResolvedValueOnce({ exitCode: 0, stdout: "unstaged diff", stderr: "" })
      // staged (git diff --cached)
      .mockResolvedValueOnce({ exitCode: 0, stdout: "staged diff", stderr: "" })
      // untracked (git ls-files)
      .mockResolvedValueOnce({ exitCode: 0, stdout: "", stderr: "" });

    const result = await getGitDiff("/tmp");

    expect(result).toContain("## Staged Changes");
    expect(result).toContain("staged diff");
    expect(result).toContain("## Unstaged Changes");
    expect(result).toContain("unstaged diff");
  });

  it("untracked ファイルの差分が含まれる（exitCode=1 を正常扱い）", async () => {
    mockRunCli
      // unstaged
      .mockResolvedValueOnce({ exitCode: 0, stdout: "", stderr: "" })
      // staged
      .mockResolvedValueOnce({ exitCode: 0, stdout: "", stderr: "" })
      // untracked list
      .mockResolvedValueOnce({ exitCode: 0, stdout: "new-file.ts\n", stderr: "" })
      // git diff --no-index for new-file.ts (exitCode=1 is normal)
      .mockResolvedValueOnce({ exitCode: 1, stdout: "diff --git a/dev/null b/new-file.ts\n+content", stderr: "" });

    const result = await getGitDiff("/tmp");

    expect(result).toContain("## Untracked Files");
    expect(result).toContain("new-file.ts");
  });

  it("untracked ファイルが MAX_UNTRACKED_FILES を超える場合に打ち切り・省略メッセージが出る", async () => {
    const files = Array.from({ length: 55 }, (_, i) => `file-${i}.ts`).join("\n");

    mockRunCli
      // unstaged
      .mockResolvedValueOnce({ exitCode: 0, stdout: "", stderr: "" })
      // staged
      .mockResolvedValueOnce({ exitCode: 0, stdout: "", stderr: "" })
      // untracked list
      .mockResolvedValueOnce({ exitCode: 0, stdout: files, stderr: "" });

    // Mock 50 diff calls (MAX_UNTRACKED_FILES)
    for (let i = 0; i < 50; i++) {
      mockRunCli.mockResolvedValueOnce({ exitCode: 1, stdout: `diff for file-${i}`, stderr: "" });
    }

    const result = await getGitDiff("/tmp");

    expect(result).toContain("50/55 files, remaining omitted");
    // file-50 以降は処理されていない
    expect(result).not.toContain("diff for file-50");
  });

  it("maxLength 超過時に切り詰められる", async () => {
    const longDiff = "x".repeat(60_000);
    mockRunCli
      // unstaged
      .mockResolvedValueOnce({ exitCode: 0, stdout: longDiff, stderr: "" })
      // staged
      .mockResolvedValueOnce({ exitCode: 0, stdout: "", stderr: "" })
      // untracked
      .mockResolvedValueOnce({ exitCode: 0, stdout: "", stderr: "" });

    const result = await getGitDiff("/tmp", 100);

    expect(result.length).toBeLessThan(200);
    expect(result).toContain("差分が長すぎるため省略されました");
  });

  it("全 git コマンド失敗時に空文字を返す", async () => {
    mockRunCli
      // unstaged
      .mockResolvedValueOnce({ exitCode: 1, stdout: "", stderr: "error" })
      // staged
      .mockResolvedValueOnce({ exitCode: 1, stdout: "", stderr: "error" })
      // untracked
      .mockResolvedValueOnce({ exitCode: 1, stdout: "", stderr: "error" });

    const result = await getGitDiff("/tmp");

    expect(result).toBe("");
  });
});
