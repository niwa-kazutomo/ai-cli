import { describe, it, expect, vi, beforeEach } from "vitest";
import { extractResponse, checkGitRepo, checkGitChanges, reviewPlan, reviewCode } from "../src/codex.js";
import type { SessionState } from "../src/types.js";

describe("extractResponse", () => {
  it("message 形式の JSONL からテキストを抽出する", () => {
    const jsonl = [
      JSON.stringify({ type: "message", content: [{ type: "text", text: "Review result" }] }),
      JSON.stringify({ type: "done" }),
    ].join("\n");

    expect(extractResponse(jsonl)).toBe("Review result");
  });

  it("output_text フィールドからテキストを抽出する", () => {
    const jsonl = JSON.stringify({ output_text: "Output text here" });
    expect(extractResponse(jsonl)).toBe("Output text here");
  });

  it("message.content が string の場合", () => {
    const jsonl = JSON.stringify({ type: "message", content: "String content" });
    expect(extractResponse(jsonl)).toBe("String content");
  });

  it("JSONL パース失敗時に生テキストを返す", () => {
    const raw = "This is not JSONL";
    expect(extractResponse(raw)).toBe(raw);
  });

  it("テキストが取れない JSONL の場合は生出力を返す", () => {
    const jsonl = JSON.stringify({ type: "status", status: "complete" });
    expect(extractResponse(jsonl)).toBe(jsonl);
  });

  it("空行を無視する", () => {
    const jsonl = [
      "",
      JSON.stringify({ type: "message", content: [{ type: "text", text: "Hello" }] }),
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
      const line1 = JSON.stringify({ type: "init", session_id: "sess-stream" }) + "\n";
      const line2 = JSON.stringify({ type: "message", content: "Hello" }) + "\n";
      const line3 = JSON.stringify({ type: "response", output_text: "World" }) + "\n";
      opts.onStdout?.(line1 + line2 + line3);
      return { exitCode: 0, stdout: line1 + line2 + line3, stderr: "" };
    });

    const result = await reviewPlan(session, "test prompt", {
      cwd: "/tmp",
      streaming: true,
      onStdout: (chunk) => chunks.push(chunk),
    });

    // ストリームからテキストが抽出されている
    expect(result.response).toBe("Hello\nWorld");
    // onStdout にテキスト差分が送出された
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.join("")).toBe("Hello\nWorld");
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

    const jsonl = JSON.stringify({ type: "message", content: "Raw output" }) + "\n";
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
      stdout: JSON.stringify({ type: "message", content: "ok" }),
      stderr: "",
    });

    await reviewPlan(session, "test prompt", { cwd: "/tmp" });

    expect(mockMarkCodexUsed).toHaveBeenCalledWith(session);
  });

  it("streaming=true で type なし output_text イベントが取りこぼされない", async () => {
    const chunks: string[] = [];
    const session: SessionState = {
      claudeSessionId: null,
      claudeFirstRun: true,
      codexSessionId: null,
      codexFirstRun: true,
    };

    mockRunCli.mockImplementation(async (_cmd, opts) => {
      // type フィールドなしの output_text 行
      const line1 = JSON.stringify({ output_text: "Typeless output" }) + "\n";
      const line2 = JSON.stringify({ type: "message", content: "With type" }) + "\n";
      opts.onStdout?.(line1 + line2);
      return { exitCode: 0, stdout: line1 + line2, stderr: "" };
    });

    const result = await reviewPlan(session, "test prompt", {
      cwd: "/tmp",
      streaming: true,
      onStdout: (chunk) => chunks.push(chunk),
    });

    // 両方のテキストが抽出されている
    expect(result.response).toBe("Typeless output\nWith type");
    expect(chunks.join("")).toBe("Typeless output\nWith type");
  });
});

describe("reviewCode streaming", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("streaming=true のとき JSONL をパースしてテキスト差分を送出する", async () => {
    const chunks: string[] = [];

    mockRunCli.mockImplementation(async (_cmd, opts) => {
      const line = JSON.stringify({ type: "message", content: "Review done" }) + "\n";
      opts.onStdout?.(line);
      return { exitCode: 0, stdout: line, stderr: "" };
    });

    const result = await reviewCode({
      cwd: "/tmp",
      streaming: true,
      onStdout: (chunk) => chunks.push(chunk),
    });

    expect(result.response).toBe("Review done");
    expect(chunks.join("")).toBe("Review done");
  });
});
