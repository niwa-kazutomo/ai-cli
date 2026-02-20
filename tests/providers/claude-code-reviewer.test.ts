import { describe, it, expect, vi, beforeEach } from "vitest";
import { ClaudeCodeReviewer } from "../../src/providers/claude-code-reviewer.js";

vi.mock("../../src/cli-runner.js", () => ({
  runCli: vi.fn(),
}));

vi.mock("../../src/logger.js", () => ({
  error: vi.fn(),
  warn: vi.fn(),
  verbose: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
}));

import { runCli } from "../../src/cli-runner.js";
const mockRunCli = vi.mocked(runCli);

describe("ClaudeCodeReviewer reviewPlan セッション管理", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("初回 reviewPlan で --print, --output-format json が引数に含まれる", async () => {
    mockRunCli.mockResolvedValue({
      exitCode: 0,
      stdout: JSON.stringify({ session_id: "sess-abc", result: "review" }),
      stderr: "",
    });

    const reviewer = new ClaudeCodeReviewer({ cwd: "/tmp" });
    await reviewer.reviewPlan("test prompt");

    const calledArgs = mockRunCli.mock.calls[0][1].args as string[];
    expect(calledArgs).toContain("--print");
    expect(calledArgs).toContain("--output-format");
    expect(calledArgs).toContain("json");
  });

  it("初回 reviewPlan で --resume が引数に含まれない", async () => {
    mockRunCli.mockResolvedValue({
      exitCode: 0,
      stdout: JSON.stringify({ session_id: "sess-abc", result: "review" }),
      stderr: "",
    });

    const reviewer = new ClaudeCodeReviewer({ cwd: "/tmp" });
    await reviewer.reviewPlan("test prompt");

    const calledArgs = mockRunCli.mock.calls[0][1].args as string[];
    expect(calledArgs).not.toContain("--resume");
  });

  it("初回レスポンスから session_id を保存し、2回目で --resume を使う", async () => {
    mockRunCli.mockResolvedValue({
      exitCode: 0,
      stdout: JSON.stringify({ session_id: "sess-abc", result: "review" }),
      stderr: "",
    });

    const reviewer = new ClaudeCodeReviewer({ cwd: "/tmp" });
    await reviewer.reviewPlan("first prompt");

    mockRunCli.mockResolvedValue({
      exitCode: 0,
      stdout: JSON.stringify({ session_id: "sess-abc", result: "second review" }),
      stderr: "",
    });

    await reviewer.reviewPlan("second prompt");

    const secondArgs = mockRunCli.mock.calls[1][1].args as string[];
    expect(secondArgs).toContain("--resume");
    expect(secondArgs).toContain("sess-abc");
  });

  it("session_id 抽出失敗時に fallbackContext で buildSummaryContext を使用する", async () => {
    // 1回目: session_id なし → 抽出失敗
    mockRunCli.mockResolvedValue({
      exitCode: 0,
      stdout: JSON.stringify({ result: "review without session_id" }),
      stderr: "",
    });

    const reviewer = new ClaudeCodeReviewer({ cwd: "/tmp" });
    await reviewer.reviewPlan("first");

    // 2回目: fallbackContext 付き
    mockRunCli.mockResolvedValue({
      exitCode: 0,
      stdout: JSON.stringify({ result: "second review" }),
      stderr: "",
    });
    await reviewer.reviewPlan("second", {
      planSummary: "plan summary",
      reviewSummary: "review summary",
    });

    // prompt に fallbackContext が含まれる
    const secondArgs = mockRunCli.mock.calls[1][1].args as string[];
    const prompt = secondArgs[secondArgs.length - 1];
    expect(prompt).toContain("計画の要約");
    expect(prompt).toContain("plan summary");
    expect(prompt).toContain("レビューの要約");
    expect(prompt).toContain("review summary");
  });

  it("exit code 非ゼロ時にエラーを投げる", async () => {
    mockRunCli.mockResolvedValue({
      exitCode: 1,
      stdout: "",
      stderr: "error",
    });

    const reviewer = new ClaudeCodeReviewer({ cwd: "/tmp" });
    await expect(reviewer.reviewPlan("test")).rejects.toThrow("プランレビューが失敗しました");
  });

  it("model オプションで --model 引数が渡される", async () => {
    mockRunCli.mockResolvedValue({
      exitCode: 0,
      stdout: JSON.stringify({ session_id: "sess-1", result: "review" }),
      stderr: "",
    });

    const reviewer = new ClaudeCodeReviewer({ cwd: "/tmp", model: "claude-sonnet-4-20250514" });
    await reviewer.reviewPlan("test prompt");

    const calledArgs = mockRunCli.mock.calls[0][1].args as string[];
    expect(calledArgs).toContain("--model");
    expect(calledArgs).toContain("claude-sonnet-4-20250514");
  });
});

describe("ClaudeCodeReviewer reviewPlan ストリーミング", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("streaming: true で --output-format stream-json, --verbose, --include-partial-messages が渡される", async () => {
    mockRunCli.mockImplementation(async (_cmd, opts) => {
      const events = [
        '{"type":"system","session_id":"stream-sess"}\n',
        '{"type":"result","result":"streamed review","session_id":"stream-sess"}\n',
      ];
      for (const event of events) {
        opts.onStdout?.(event);
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    });

    const reviewer = new ClaudeCodeReviewer({ cwd: "/tmp", streaming: true });
    await reviewer.reviewPlan("test");

    const calledArgs = mockRunCli.mock.calls[0][1].args as string[];
    expect(calledArgs).toContain("stream-json");
    expect(calledArgs).not.toContain("json");
    expect(calledArgs).toContain("--verbose");
    expect(calledArgs).toContain("--include-partial-messages");
  });

  it("streaming: false で --output-format json が維持される", async () => {
    mockRunCli.mockResolvedValue({
      exitCode: 0,
      stdout: JSON.stringify({ session_id: "sess-1", result: "review" }),
      stderr: "",
    });

    const reviewer = new ClaudeCodeReviewer({ cwd: "/tmp", streaming: false });
    await reviewer.reviewPlan("test");

    const calledArgs = mockRunCli.mock.calls[0][1].args as string[];
    expect(calledArgs).toContain("json");
    expect(calledArgs).not.toContain("stream-json");
    expect(calledArgs).not.toContain("--verbose");
  });

  it("stream-json 出力から response と sessionId を正しく抽出する", async () => {
    mockRunCli.mockImplementation(async (_cmd, opts) => {
      const events = [
        '{"type":"system","session_id":"stream-sess-abc"}\n',
        '{"type":"assistant","message":{"content":[{"type":"text","text":"partial"}]}}\n',
        '{"type":"result","result":"final review text","session_id":"stream-sess-abc"}\n',
      ];
      for (const event of events) {
        opts.onStdout?.(event);
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    });

    const reviewer = new ClaudeCodeReviewer({ cwd: "/tmp", streaming: true });
    const result = await reviewer.reviewPlan("test");

    expect(result.response).toBe("final review text");
  });

  it("onStdout が差分テキストのみ受け取る（重複表示防止）", async () => {
    const receivedChunks: string[] = [];

    mockRunCli.mockImplementation(async (_cmd, opts) => {
      const events = [
        '{"type":"system","session_id":"sess-delta"}\n',
        '{"type":"assistant","message":{"content":[{"type":"text","text":"Hello"}]}}\n',
        '{"type":"assistant","message":{"content":[{"type":"text","text":"Hello World"}]}}\n',
        '{"type":"result","result":"Hello World","session_id":"sess-delta"}\n',
      ];
      for (const event of events) {
        opts.onStdout?.(event);
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    });

    const reviewer = new ClaudeCodeReviewer({
      cwd: "/tmp",
      streaming: true,
      onStdout: (chunk: string) => receivedChunks.push(chunk),
    });
    await reviewer.reviewPlan("test");

    expect(receivedChunks).toEqual(["Hello", " World", "\n"]);
  });

  it("テキスト長縮退時に prevEmittedLength がリセットされる", async () => {
    const receivedChunks: string[] = [];

    mockRunCli.mockImplementation(async (_cmd, opts) => {
      const events = [
        '{"type":"system","session_id":"sess-shrink"}\n',
        '{"type":"assistant","message":{"content":[{"type":"text","text":"Long text here"}]}}\n',
        '{"type":"assistant","message":{"content":[{"type":"text","text":"Short"}]}}\n',
        '{"type":"result","result":"Short","session_id":"sess-shrink"}\n',
      ];
      for (const event of events) {
        opts.onStdout?.(event);
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    });

    const reviewer = new ClaudeCodeReviewer({
      cwd: "/tmp",
      streaming: true,
      onStdout: (chunk: string) => receivedChunks.push(chunk),
    });
    await reviewer.reviewPlan("test");

    expect(receivedChunks).toEqual(["Long text here", "\n", "Short", "\n"]);
  });

  it("複数 assistant メッセージが response に蓄積される", async () => {
    mockRunCli.mockImplementation(async (_cmd, opts) => {
      const events = [
        '{"type":"system","session_id":"sess-multi-msg"}\n',
        '{"type":"assistant","message":{"content":[{"type":"text","text":"# Review\\nIssue 1: Fix X"}]}}\n',
        '{"type":"tool_result","tool_use_id":"t1","content":"file content"}\n',
        '{"type":"assistant","message":{"content":[{"type":"text","text":"以上がレビュー結果です。"}]}}\n',
        '{"type":"result","result":"以上がレビュー結果です。","session_id":"sess-multi-msg"}\n',
      ];
      for (const event of events) {
        opts.onStdout?.(event);
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    });

    const reviewer = new ClaudeCodeReviewer({ cwd: "/tmp", streaming: true });
    const result = await reviewer.reviewPlan("test");

    expect(result.response).toContain("# Review");
    expect(result.response).toContain("Issue 1: Fix X");
    expect(result.response).toContain("以上がレビュー結果です。");
  });

  it("ストリーミングで session_id を抽出し 2回目で --resume を使う", async () => {
    // 1回目: ストリーミングで session_id 取得
    mockRunCli.mockImplementation(async (_cmd, opts) => {
      const events = [
        '{"type":"system","session_id":"stream-sess-resume"}\n',
        '{"type":"result","result":"first review","session_id":"stream-sess-resume"}\n',
      ];
      for (const event of events) {
        opts.onStdout?.(event);
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    });

    const reviewer = new ClaudeCodeReviewer({ cwd: "/tmp", streaming: true });
    await reviewer.reviewPlan("first");

    // 2回目: --resume を使う
    mockRunCli.mockImplementation(async (_cmd, opts) => {
      const events = [
        '{"type":"result","result":"second review","session_id":"stream-sess-resume"}\n',
      ];
      for (const event of events) {
        opts.onStdout?.(event);
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    });
    await reviewer.reviewPlan("second");

    const secondArgs = mockRunCli.mock.calls[1][1].args as string[];
    expect(secondArgs).toContain("--resume");
    expect(secondArgs).toContain("stream-sess-resume");
  });
});

describe("ClaudeCodeReviewer reviewCode", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("reviewCode で --no-session-persistence が引数に含まれない", async () => {
    mockRunCli.mockResolvedValue({
      exitCode: 0,
      stdout: JSON.stringify({ result: "code review" }),
      stderr: "",
    });

    const reviewer = new ClaudeCodeReviewer({ cwd: "/tmp" });
    await reviewer.reviewCode("review prompt");

    const calledArgs = mockRunCli.mock.calls[0][1].args as string[];
    expect(calledArgs).toContain("--print");
    expect(calledArgs).toContain("--output-format");
    expect(calledArgs).toContain("json");
    expect(calledArgs).not.toContain("--no-session-persistence");
  });

  it("reviewCode で exit code 非ゼロ時にエラーを投げる", async () => {
    mockRunCli.mockResolvedValue({
      exitCode: 1,
      stdout: "",
      stderr: "error",
    });

    const reviewer = new ClaudeCodeReviewer({ cwd: "/tmp" });
    await expect(reviewer.reviewCode("test")).rejects.toThrow("コードレビューが失敗しました");
  });

  it("reviewCode で model オプションが渡される", async () => {
    mockRunCli.mockResolvedValue({
      exitCode: 0,
      stdout: JSON.stringify({ result: "code review" }),
      stderr: "",
    });

    const reviewer = new ClaudeCodeReviewer({ cwd: "/tmp", model: "claude-sonnet-4-20250514" });
    await reviewer.reviewCode("review prompt");

    const calledArgs = mockRunCli.mock.calls[0][1].args as string[];
    expect(calledArgs).toContain("--model");
    expect(calledArgs).toContain("claude-sonnet-4-20250514");
  });

  it("reviewCode streaming: true で stream-json が使用される", async () => {
    const chunks: string[] = [];

    mockRunCli.mockImplementation(async (_cmd, opts) => {
      const events = [
        '{"type":"assistant","message":{"content":[{"type":"text","text":"Code looks good"}]}}\n',
        '{"type":"result","result":"Code looks good"}\n',
      ];
      for (const event of events) {
        opts.onStdout?.(event);
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    });

    const reviewer = new ClaudeCodeReviewer({
      cwd: "/tmp",
      streaming: true,
      onStdout: (chunk) => chunks.push(chunk),
    });
    const result = await reviewer.reviewCode("review prompt");

    expect(result.response).toBe("Code looks good");
    const calledArgs = mockRunCli.mock.calls[0][1].args as string[];
    expect(calledArgs).toContain("stream-json");
    expect(calledArgs).not.toContain("--no-session-persistence");
  });

  it("reviewCode streaming: false で raw stdout からレスポンスを抽出する", async () => {
    mockRunCli.mockResolvedValue({
      exitCode: 0,
      stdout: JSON.stringify({ result: "Code review result" }),
      stderr: "",
    });

    const reviewer = new ClaudeCodeReviewer({ cwd: "/tmp", streaming: false });
    const result = await reviewer.reviewCode("review prompt");

    expect(result.response).toBe("Code review result");
  });

  it("2回目以降でセッション ID がある場合は --resume を使う", async () => {
    // 1回目: セッション ID 取得
    mockRunCli.mockResolvedValue({
      exitCode: 0,
      stdout: JSON.stringify({ session_id: "code-sess-1", result: "first review" }),
      stderr: "",
    });

    const reviewer = new ClaudeCodeReviewer({ cwd: "/tmp" });
    await reviewer.reviewCode("first");

    // 2回目: --resume を使う
    mockRunCli.mockResolvedValue({
      exitCode: 0,
      stdout: JSON.stringify({ session_id: "code-sess-1", result: "second review" }),
      stderr: "",
    });
    await reviewer.reviewCode("second", {
      diffSummary: "diff",
      reviewSummary: "review",
    });

    const secondArgs = mockRunCli.mock.calls[1][1].args as string[];
    expect(secondArgs).toContain("--resume");
    expect(secondArgs).toContain("code-sess-1");
  });

  it("セッション ID 抽出失敗時に fallbackContext を使用する", async () => {
    // 1回目: session_id なし → 抽出失敗
    mockRunCli.mockResolvedValue({
      exitCode: 0,
      stdout: JSON.stringify({ result: "review without session_id" }),
      stderr: "",
    });

    const reviewer = new ClaudeCodeReviewer({ cwd: "/tmp" });
    await reviewer.reviewCode("first");

    // 2回目: fallbackContext 付き
    mockRunCli.mockResolvedValue({
      exitCode: 0,
      stdout: JSON.stringify({ result: "second review" }),
      stderr: "",
    });
    await reviewer.reviewCode("second", {
      diffSummary: "diff summary",
      reviewSummary: "review summary",
    });

    // prompt に fallbackContext が含まれる
    const secondArgs = mockRunCli.mock.calls[1][1].args as string[];
    const prompt = secondArgs[secondArgs.length - 1];
    expect(prompt).toContain("前回の差分要約");
    expect(prompt).toContain("diff summary");
    expect(prompt).toContain("前回のレビュー要約");
    expect(prompt).toContain("review summary");
  });

  it("1回目抽出失敗→2回目抽出成功→3回目で --resume 使用", async () => {
    // 1回目: session_id なし
    mockRunCli.mockResolvedValue({
      exitCode: 0,
      stdout: JSON.stringify({ result: "review" }),
      stderr: "",
    });

    const reviewer = new ClaudeCodeReviewer({ cwd: "/tmp" });
    await reviewer.reviewCode("first");

    // 2回目: session_id あり → 抽出成功
    mockRunCli.mockResolvedValue({
      exitCode: 0,
      stdout: JSON.stringify({ session_id: "code-sess-late", result: "review" }),
      stderr: "",
    });
    await reviewer.reviewCode("second", {
      diffSummary: "diff",
      reviewSummary: "review",
    });

    // 3回目: --resume を使う
    mockRunCli.mockResolvedValue({
      exitCode: 0,
      stdout: JSON.stringify({ session_id: "code-sess-late", result: "resumed" }),
      stderr: "",
    });
    await reviewer.reviewCode("third", {
      diffSummary: "diff2",
      reviewSummary: "review2",
    });

    const thirdArgs = mockRunCli.mock.calls[2][1].args as string[];
    expect(thirdArgs).toContain("--resume");
    expect(thirdArgs).toContain("code-sess-late");
  });

  it("reviewCode のストリーミングで session_id を抽出し 2回目で --resume を使う", async () => {
    // 1回目: ストリーミングで session_id 取得
    mockRunCli.mockImplementation(async (_cmd, opts) => {
      const events = [
        '{"type":"system","session_id":"code-stream-sess"}\n',
        '{"type":"result","result":"first code review","session_id":"code-stream-sess"}\n',
      ];
      for (const event of events) {
        opts.onStdout?.(event);
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    });

    const reviewer = new ClaudeCodeReviewer({ cwd: "/tmp", streaming: true });
    await reviewer.reviewCode("first");

    // 2回目: --resume を使う
    mockRunCli.mockImplementation(async (_cmd, opts) => {
      const events = [
        '{"type":"result","result":"second code review","session_id":"code-stream-sess"}\n',
      ];
      for (const event of events) {
        opts.onStdout?.(event);
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    });
    await reviewer.reviewCode("second", {
      diffSummary: "diff",
      reviewSummary: "review",
    });

    const secondArgs = mockRunCli.mock.calls[1][1].args as string[];
    expect(secondArgs).toContain("--resume");
    expect(secondArgs).toContain("code-stream-sess");
  });
});
