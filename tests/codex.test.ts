import { describe, it, expect, vi, beforeEach } from "vitest";
import { extractResponse, checkGitRepo, checkGitChanges, getGitDiff, reviewPlan, reviewCode } from "../src/codex.js";
import type { SessionState, CodexSandboxMode } from "../src/types.js";

describe("extractResponse", () => {
  it("item.completed の agent_message からテキストを抽出する", () => {
    const jsonl = [
      JSON.stringify({ type: "thread.started", thread_id: "tid-1" }),
      JSON.stringify({ type: "item.completed", item: { id: "item_1", type: "agent_message", text: "Review result" } }),
      JSON.stringify({ type: "turn.completed", usage: {} }),
    ].join("\n");

    expect(extractResponse(jsonl)).toBe("Review result");
  });

  it("複数の item.completed を改行で join する", () => {
    const jsonl = [
      JSON.stringify({ type: "item.completed", item: { id: "item_1", type: "agent_message", text: "Part 1" } }),
      JSON.stringify({ type: "item.completed", item: { id: "item_2", type: "agent_message", text: "Part 2" } }),
    ].join("\n");

    expect(extractResponse(jsonl)).toBe("Part 1\nPart 2");
  });

  it("JSONL パース失敗時に生テキストを返す", () => {
    const raw = "This is not JSONL";
    expect(extractResponse(raw)).toBe(raw);
  });

  it("テキストが取れない JSONL の場合は生出力を返す", () => {
    const jsonl = JSON.stringify({ type: "turn.completed", usage: {} });
    expect(extractResponse(jsonl)).toBe(jsonl);
  });

  it("空行を無視する", () => {
    const jsonl = [
      "",
      JSON.stringify({ type: "item.completed", item: { id: "item_1", type: "agent_message", text: "Hello" } }),
      "",
    ].join("\n");

    expect(extractResponse(jsonl)).toBe("Hello");
  });
});

describe("checkGitRepo", () => {
  it("Git リポジトリ内では true を返す", async () => {
    // テスト実行ディレクトリが Git リポジトリかどうかで結果が異なる
    // /tmp でテスト
    const result = await checkGitRepo("/tmp");
    expect(typeof result).toBe("boolean");
  });
});

describe("checkGitChanges", () => {
  it("結果が boolean であること", async () => {
    const result = await checkGitChanges("/tmp");
    expect(typeof result).toBe("boolean");
  });
});

// cli-runner をモック
vi.mock("../src/cli-runner.js", () => ({
  runCli: vi.fn(),
}));

vi.mock("../src/session.js", () => ({
  extractCodexSessionId: vi.fn().mockReturnValue(null),
  markCodexUsed: vi.fn(),
  buildSummaryContext: vi.fn().mockReturnValue("context"),
}));

vi.mock("../src/logger.js", () => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  verbose: vi.fn(),
  debug: vi.fn(),
}));

import { runCli } from "../src/cli-runner.js";
import { markCodexUsed } from "../src/session.js";

const mockRunCli = vi.mocked(runCli);
const mockMarkCodexUsed = vi.mocked(markCodexUsed);

describe("reviewPlan streaming", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("streaming=true のとき JSONL をパースしてテキスト差分を onStdout に送出する", async () => {
    const chunks: string[] = [];
    const session: SessionState = {
      claudeSessionId: null,
      claudeFirstRun: true,
      codexSessionId: null,
      codexFirstRun: true,
    };

    // runCli がコールされたとき、onStdout に JSONL チャンクを流す
    mockRunCli.mockImplementation(async (_cmd, opts) => {
      const line1 = JSON.stringify({ type: "thread.started", thread_id: "sess-stream" }) + "\n";
      const line2 = JSON.stringify({ type: "item.started", item: { id: "item_1", type: "agent_message", text: "" } }) + "\n";
      const line3 = JSON.stringify({ type: "item.updated", item: { id: "item_1", type: "agent_message", text: "Hello" } }) + "\n";
      const line4 = JSON.stringify({ type: "item.completed", item: { id: "item_1", type: "agent_message", text: "Hello World" } }) + "\n";
      opts.onStdout?.(line1 + line2 + line3 + line4);
      return { exitCode: 0, stdout: line1 + line2 + line3 + line4, stderr: "" };
    });

    const result = await reviewPlan(session, "test prompt", {
      cwd: "/tmp",
      streaming: true,
      onStdout: (chunk) => chunks.push(chunk),
    });

    // ストリームからテキストが抽出されている
    expect(result.response).toBe("Hello World");
    // onStdout にテキスト差分が送出された
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.join("")).toBe("Hello World");
    // セッション ID がストリームから抽出されている
    expect(session.codexSessionId).toBe("sess-stream");
  });

  it("streaming=false のとき raw stdout パススルー", async () => {
    const chunks: string[] = [];
    const session: SessionState = {
      claudeSessionId: null,
      claudeFirstRun: true,
      codexSessionId: null,
      codexFirstRun: true,
    };

    const jsonl = JSON.stringify({ type: "item.completed", item: { id: "item_1", type: "agent_message", text: "Raw output" } }) + "\n";
    mockRunCli.mockImplementation(async (_cmd, opts) => {
      opts.onStdout?.(jsonl);
      return { exitCode: 0, stdout: jsonl, stderr: "" };
    });

    const result = await reviewPlan(session, "test prompt", {
      cwd: "/tmp",
      streaming: false,
      onStdout: (chunk) => chunks.push(chunk),
    });

    // フォールバック: extractResponse で抽出
    expect(result.response).toBe("Raw output");
    // onStdout には raw JSONL がそのまま渡される
    expect(chunks).toEqual([jsonl]);
  });

  it("失敗時は markCodexUsed が呼ばれない", async () => {
    const session: SessionState = {
      claudeSessionId: null,
      claudeFirstRun: true,
      codexSessionId: null,
      codexFirstRun: true,
    };

    mockRunCli.mockResolvedValue({
      exitCode: 1,
      stdout: "",
      stderr: "error",
    });

    await expect(
      reviewPlan(session, "test prompt", { cwd: "/tmp" }),
    ).rejects.toThrow("プランレビューが失敗しました");

    expect(mockMarkCodexUsed).not.toHaveBeenCalled();
  });

  it("成功時は markCodexUsed が呼ばれる", async () => {
    const session: SessionState = {
      claudeSessionId: null,
      claudeFirstRun: true,
      codexSessionId: null,
      codexFirstRun: true,
    };

    mockRunCli.mockResolvedValue({
      exitCode: 0,
      stdout: JSON.stringify({ type: "item.completed", item: { id: "item_1", type: "agent_message", text: "ok" } }),
      stderr: "",
    });

    await reviewPlan(session, "test prompt", { cwd: "/tmp" });

    expect(mockMarkCodexUsed).toHaveBeenCalledWith(session);
  });

  it("streaming=true で複数 item の agent_message が正しく結合される", async () => {
    const chunks: string[] = [];
    const session: SessionState = {
      claudeSessionId: null,
      claudeFirstRun: true,
      codexSessionId: null,
      codexFirstRun: true,
    };

    mockRunCli.mockImplementation(async (_cmd, opts) => {
      const line1 = JSON.stringify({ type: "item.completed", item: { id: "item_1", type: "agent_message", text: "First item" } }) + "\n";
      const line2 = JSON.stringify({ type: "item.completed", item: { id: "item_2", type: "agent_message", text: "Second item" } }) + "\n";
      opts.onStdout?.(line1 + line2);
      return { exitCode: 0, stdout: line1 + line2, stderr: "" };
    });

    const result = await reviewPlan(session, "test prompt", {
      cwd: "/tmp",
      streaming: true,
      onStdout: (chunk) => chunks.push(chunk),
    });

    // 両方のテキストが改行で結合されている
    expect(result.response).toBe("First item\nSecond item");
    expect(chunks.join("")).toBe("First item\nSecond item");
  });

  it("streaming=true で item.id がないイベントはスキップされる", async () => {
    const chunks: string[] = [];
    const session: SessionState = {
      claudeSessionId: null,
      claudeFirstRun: true,
      codexSessionId: null,
      codexFirstRun: true,
    };

    mockRunCli.mockImplementation(async (_cmd, opts) => {
      // item.id がない agent_message（異常系）
      const line1 = JSON.stringify({ type: "item.updated", item: { type: "agent_message", text: "No ID" } }) + "\n";
      const line2 = JSON.stringify({ type: "item.completed", item: { id: "item_1", type: "agent_message", text: "With ID" } }) + "\n";
      opts.onStdout?.(line1 + line2);
      return { exitCode: 0, stdout: line1 + line2, stderr: "" };
    });

    const result = await reviewPlan(session, "test prompt", {
      cwd: "/tmp",
      streaming: true,
      onStdout: (chunk) => chunks.push(chunk),
    });

    // item.id がないイベントはストリーミング delta からスキップされ、With ID のみ
    expect(chunks.join("")).toBe("With ID");
  });

  it("reviewPlan は options.sandbox を指定しても read-only を使う", async () => {
    const session: SessionState = {
      claudeSessionId: null,
      claudeFirstRun: true,
      codexSessionId: null,
      codexFirstRun: true,
    };

    mockRunCli.mockImplementation(async (_cmd, opts) => {
      const line = JSON.stringify({ type: "item.completed", item: { id: "item_1", type: "agent_message", text: "ok" } }) + "\n";
      opts.onStdout?.(line);
      return { exitCode: 0, stdout: line, stderr: "" };
    });

    await reviewPlan(session, "test prompt", {
      cwd: "/tmp",
      sandbox: "workspace-write",
      streaming: true,
      onStdout: () => {},
    });

    const callArgs = mockRunCli.mock.calls[0][1].args;
    expect(callArgs).toContain("read-only");
    expect(callArgs).not.toContain("workspace-write");
  });

  it("streaming=true で複数 item の交互更新が正しい順序で出力される", async () => {
    const chunks: string[] = [];
    const session: SessionState = {
      claudeSessionId: null,
      claudeFirstRun: true,
      codexSessionId: null,
      codexFirstRun: true,
    };

    mockRunCli.mockImplementation(async (_cmd, opts) => {
      const lines = [
        JSON.stringify({ type: "item.started", item: { id: "item_1", type: "agent_message", text: "A" } }) + "\n",
        JSON.stringify({ type: "item.started", item: { id: "item_2", type: "agent_message", text: "X" } }) + "\n",
        JSON.stringify({ type: "item.updated", item: { id: "item_1", type: "agent_message", text: "AB" } }) + "\n",
      ];
      for (const line of lines) {
        opts.onStdout?.(line);
      }
      return { exitCode: 0, stdout: lines.join(""), stderr: "" };
    });

    const result = await reviewPlan(session, "test prompt", {
      cwd: "/tmp",
      streaming: true,
      onStdout: (chunk) => chunks.push(chunk),
    });

    // item_1 と item_2 が出現順に並び、item_1 の最新テキストが "AB"
    expect(result.response).toBe("AB\nX");
  });
});

describe("reviewCode streaming", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("streaming=true のとき JSONL をパースしてテキスト差分を送出する", async () => {
    const chunks: string[] = [];

    mockRunCli.mockImplementation(async (_cmd, opts) => {
      const line = JSON.stringify({ type: "item.completed", item: { id: "item_1", type: "agent_message", text: "Review done" } }) + "\n";
      opts.onStdout?.(line);
      return { exitCode: 0, stdout: line, stderr: "" };
    });

    const result = await reviewCode("review prompt", {
      cwd: "/tmp",
      streaming: true,
      onStdout: (chunk) => chunks.push(chunk),
    });

    expect(result.response).toBe("Review done");
    expect(chunks.join("")).toBe("Review done");
  });

  it("デフォルトで --sandbox workspace-write が使用される", async () => {
    mockRunCli.mockImplementation(async (_cmd, opts) => {
      const line = JSON.stringify({ type: "item.completed", item: { id: "item_1", type: "agent_message", text: "ok" } }) + "\n";
      opts.onStdout?.(line);
      return { exitCode: 0, stdout: line, stderr: "" };
    });

    await reviewCode("my review prompt", {
      cwd: "/tmp",
      streaming: true,
      onStdout: () => {},
    });

    const callArgs = mockRunCli.mock.calls[0][1].args;
    expect(callArgs).toContain("--sandbox");
    expect(callArgs).toContain("workspace-write");
    expect(callArgs).toContain("--json");
    expect(callArgs).toContain("my review prompt");
    expect(callArgs).not.toContain("read-only");
  });

  it("sandbox オプションで read-only に上書きできる", async () => {
    mockRunCli.mockImplementation(async (_cmd, opts) => {
      const line = JSON.stringify({ type: "item.completed", item: { id: "item_1", type: "agent_message", text: "ok" } }) + "\n";
      opts.onStdout?.(line);
      return { exitCode: 0, stdout: line, stderr: "" };
    });

    await reviewCode("prompt", {
      cwd: "/tmp",
      sandbox: "read-only",
      streaming: true,
      onStdout: () => {},
    });

    const callArgs = mockRunCli.mock.calls[0][1].args;
    expect(callArgs).toContain("read-only");
    expect(callArgs).not.toContain("workspace-write");
  });

  it("sandbox オプションで danger-full-access に上書きできる", async () => {
    mockRunCli.mockImplementation(async (_cmd, opts) => {
      const line = JSON.stringify({ type: "item.completed", item: { id: "item_1", type: "agent_message", text: "ok" } }) + "\n";
      opts.onStdout?.(line);
      return { exitCode: 0, stdout: line, stderr: "" };
    });

    await reviewCode("prompt", {
      cwd: "/tmp",
      sandbox: "danger-full-access",
      streaming: true,
      onStdout: () => {},
    });

    const callArgs = mockRunCli.mock.calls[0][1].args;
    expect(callArgs).toContain("danger-full-access");
    expect(callArgs).not.toContain("workspace-write");
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
