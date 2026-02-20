import { describe, it, expect, vi, beforeEach } from "vitest";
import { CodexReviewer, extractCodexResponse, extractCodexSessionId, buildSummaryContext } from "../../src/providers/codex-reviewer.js";

vi.mock("../../src/cli-runner.js", () => ({
  runCli: vi.fn(),
}));

vi.mock("../../src/logger.js", () => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  verbose: vi.fn(),
  debug: vi.fn(),
}));

import { runCli } from "../../src/cli-runner.js";
const mockRunCli = vi.mocked(runCli);

describe("extractCodexResponse", () => {
  it("item.completed の agent_message からテキストを抽出する", () => {
    const jsonl = [
      JSON.stringify({ type: "thread.started", thread_id: "tid-1" }),
      JSON.stringify({ type: "item.completed", item: { id: "item_1", type: "agent_message", text: "Review result" } }),
      JSON.stringify({ type: "turn.completed", usage: {} }),
    ].join("\n");

    expect(extractCodexResponse(jsonl)).toBe("Review result");
  });

  it("複数の item.completed を改行で join する", () => {
    const jsonl = [
      JSON.stringify({ type: "item.completed", item: { id: "item_1", type: "agent_message", text: "Part 1" } }),
      JSON.stringify({ type: "item.completed", item: { id: "item_2", type: "agent_message", text: "Part 2" } }),
    ].join("\n");

    expect(extractCodexResponse(jsonl)).toBe("Part 1\nPart 2");
  });

  it("JSONL パース失敗時に生テキストを返す", () => {
    const raw = "This is not JSONL";
    expect(extractCodexResponse(raw)).toBe(raw);
  });

  it("テキストが取れない JSONL の場合は生出力を返す", () => {
    const jsonl = JSON.stringify({ type: "turn.completed", usage: {} });
    expect(extractCodexResponse(jsonl)).toBe(jsonl);
  });

  it("空行を無視する", () => {
    const jsonl = [
      "",
      JSON.stringify({ type: "item.completed", item: { id: "item_1", type: "agent_message", text: "Hello" } }),
      "",
    ].join("\n");

    expect(extractCodexResponse(jsonl)).toBe("Hello");
  });
});

describe("extractCodexSessionId", () => {
  it("thread.started の thread_id を抽出する", () => {
    const jsonl = JSON.stringify({ type: "thread.started", thread_id: "0199a213-abcd-1234" });
    expect(extractCodexSessionId(jsonl)).toBe("0199a213-abcd-1234");
  });

  it("session_id フィールドをフォールバックで抽出する", () => {
    const jsonl = JSON.stringify({ type: "init", session_id: "sess-abc123" });
    expect(extractCodexSessionId(jsonl)).toBe("sess-abc123");
  });

  it("thread_id が session_id より優先される", () => {
    const jsonl = [
      JSON.stringify({ type: "thread.started", thread_id: "thread-id" }),
      JSON.stringify({ type: "init", session_id: "session-id" }),
    ].join("\n");
    expect(extractCodexSessionId(jsonl)).toBe("thread-id");
  });

  it("thread_id も session_id も存在しない場合は null を返す", () => {
    const jsonl = JSON.stringify({ type: "item.completed", item: { id: "item_1", type: "agent_message", text: "Hello" } });
    expect(extractCodexSessionId(jsonl)).toBeNull();
  });

  it("不正な JSON 行をスキップして後続の thread.started を取る", () => {
    const jsonl = [
      "not valid json",
      JSON.stringify({ type: "thread.started", thread_id: "after-invalid" }),
    ].join("\n");
    expect(extractCodexSessionId(jsonl)).toBe("after-invalid");
  });

  it("空文字列で null を返す", () => {
    expect(extractCodexSessionId("")).toBeNull();
  });
});

describe("buildSummaryContext", () => {
  it("要約コンテキストを正しく構築する", () => {
    const result = buildSummaryContext("計画の内容", "レビューの内容");

    expect(result).toContain("計画の要約");
    expect(result).toContain("計画の内容");
    expect(result).toContain("レビューの要約");
    expect(result).toContain("レビューの内容");
  });
});

describe("CodexReviewer reviewPlan streaming", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("streaming=true のとき JSONL をパースしてテキスト差分を onStdout に送出する", async () => {
    const chunks: string[] = [];

    mockRunCli.mockImplementation(async (_cmd, opts) => {
      const line1 = JSON.stringify({ type: "thread.started", thread_id: "sess-stream" }) + "\n";
      const line2 = JSON.stringify({ type: "item.started", item: { id: "item_1", type: "agent_message", text: "" } }) + "\n";
      const line3 = JSON.stringify({ type: "item.updated", item: { id: "item_1", type: "agent_message", text: "Hello" } }) + "\n";
      const line4 = JSON.stringify({ type: "item.completed", item: { id: "item_1", type: "agent_message", text: "Hello World" } }) + "\n";
      opts.onStdout?.(line1 + line2 + line3 + line4);
      return { exitCode: 0, stdout: line1 + line2 + line3 + line4, stderr: "" };
    });

    const reviewer = new CodexReviewer({
      cwd: "/tmp",
      streaming: true,
      onStdout: (chunk) => chunks.push(chunk),
    });
    const result = await reviewer.reviewPlan("test prompt");

    expect(result.response).toBe("Hello World");
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.join("")).toBe("Hello World");
  });

  it("streaming=false のとき raw stdout パススルー", async () => {
    const chunks: string[] = [];

    const jsonl = JSON.stringify({ type: "item.completed", item: { id: "item_1", type: "agent_message", text: "Raw output" } }) + "\n";
    mockRunCli.mockImplementation(async (_cmd, opts) => {
      opts.onStdout?.(jsonl);
      return { exitCode: 0, stdout: jsonl, stderr: "" };
    });

    const reviewer = new CodexReviewer({
      cwd: "/tmp",
      streaming: false,
      onStdout: (chunk) => chunks.push(chunk),
    });
    const result = await reviewer.reviewPlan("test prompt");

    expect(result.response).toBe("Raw output");
    expect(chunks).toEqual([jsonl]);
  });

  it("失敗時にエラーを投げる", async () => {
    mockRunCli.mockResolvedValue({
      exitCode: 1,
      stdout: "",
      stderr: "error",
    });

    const reviewer = new CodexReviewer({ cwd: "/tmp" });

    await expect(
      reviewer.reviewPlan("test prompt"),
    ).rejects.toThrow("プランレビューが失敗しました");
  });

  it("streaming=true で複数 item の agent_message が正しく結合される", async () => {
    const chunks: string[] = [];

    mockRunCli.mockImplementation(async (_cmd, opts) => {
      const line1 = JSON.stringify({ type: "item.completed", item: { id: "item_1", type: "agent_message", text: "First item" } }) + "\n";
      const line2 = JSON.stringify({ type: "item.completed", item: { id: "item_2", type: "agent_message", text: "Second item" } }) + "\n";
      opts.onStdout?.(line1 + line2);
      return { exitCode: 0, stdout: line1 + line2, stderr: "" };
    });

    const reviewer = new CodexReviewer({
      cwd: "/tmp",
      streaming: true,
      onStdout: (chunk) => chunks.push(chunk),
    });
    const result = await reviewer.reviewPlan("test prompt");

    expect(result.response).toBe("First item\nSecond item");
    expect(chunks.join("")).toBe("First item\nSecond item");
  });

  it("reviewPlan は常に read-only sandbox を使う", async () => {
    mockRunCli.mockImplementation(async (_cmd, opts) => {
      const line = JSON.stringify({ type: "item.completed", item: { id: "item_1", type: "agent_message", text: "ok" } }) + "\n";
      opts.onStdout?.(line);
      return { exitCode: 0, stdout: line, stderr: "" };
    });

    const reviewer = new CodexReviewer({
      cwd: "/tmp",
      sandbox: "workspace-write",
      streaming: true,
      onStdout: () => {},
    });
    await reviewer.reviewPlan("test prompt");

    const callArgs = mockRunCli.mock.calls[0][1].args;
    expect(callArgs).toContain("read-only");
    expect(callArgs).not.toContain("workspace-write");
  });

  it("2回目以降でセッション ID がある場合は resume を使う", async () => {
    // 1回目: セッション ID 取得
    mockRunCli.mockImplementation(async (_cmd, opts) => {
      const line1 = JSON.stringify({ type: "thread.started", thread_id: "sess-resume" }) + "\n";
      const line2 = JSON.stringify({ type: "item.completed", item: { id: "item_1", type: "agent_message", text: "ok" } }) + "\n";
      opts.onStdout?.(line1 + line2);
      return { exitCode: 0, stdout: line1 + line2, stderr: "" };
    });

    const reviewer = new CodexReviewer({
      cwd: "/tmp",
      streaming: true,
      onStdout: () => {},
    });
    await reviewer.reviewPlan("first");

    // 2回目: resume を使う
    mockRunCli.mockImplementation(async (_cmd, opts) => {
      const line = JSON.stringify({ type: "item.completed", item: { id: "item_1", type: "agent_message", text: "resumed" } }) + "\n";
      opts.onStdout?.(line);
      return { exitCode: 0, stdout: line, stderr: "" };
    });
    await reviewer.reviewPlan("second");

    const secondArgs = mockRunCli.mock.calls[1][1].args as string[];
    expect(secondArgs).toContain("resume");
    expect(secondArgs).toContain("sess-resume");
  });

  it("セッション ID 抽出失敗時に fallbackContext を使用する", async () => {
    // 1回目: セッション ID 抽出失敗
    mockRunCli.mockResolvedValue({
      exitCode: 0,
      stdout: JSON.stringify({ type: "item.completed", item: { id: "item_1", type: "agent_message", text: "ok" } }),
      stderr: "",
    });

    const reviewer = new CodexReviewer({ cwd: "/tmp" });
    await reviewer.reviewPlan("first");

    // 2回目: fallbackContext 付き
    mockRunCli.mockResolvedValue({
      exitCode: 0,
      stdout: JSON.stringify({ type: "item.completed", item: { id: "item_1", type: "agent_message", text: "ok" } }),
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
});

describe("CodexReviewer reviewCode streaming", () => {
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

    const reviewer = new CodexReviewer({
      cwd: "/tmp",
      streaming: true,
      onStdout: (chunk) => chunks.push(chunk),
    });
    const result = await reviewer.reviewCode("review prompt");

    expect(result.response).toBe("Review done");
    expect(chunks.join("")).toBe("Review done");
  });

  it("デフォルトで --sandbox workspace-write が使用される", async () => {
    mockRunCli.mockImplementation(async (_cmd, opts) => {
      const line = JSON.stringify({ type: "item.completed", item: { id: "item_1", type: "agent_message", text: "ok" } }) + "\n";
      opts.onStdout?.(line);
      return { exitCode: 0, stdout: line, stderr: "" };
    });

    const reviewer = new CodexReviewer({
      cwd: "/tmp",
      streaming: true,
      onStdout: () => {},
    });
    await reviewer.reviewCode("my review prompt");

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

    const reviewer = new CodexReviewer({
      cwd: "/tmp",
      sandbox: "read-only",
      streaming: true,
      onStdout: () => {},
    });
    await reviewer.reviewCode("prompt");

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

    const reviewer = new CodexReviewer({
      cwd: "/tmp",
      sandbox: "danger-full-access",
      streaming: true,
      onStdout: () => {},
    });
    await reviewer.reviewCode("prompt");

    const callArgs = mockRunCli.mock.calls[0][1].args;
    expect(callArgs).toContain("danger-full-access");
    expect(callArgs).not.toContain("workspace-write");
  });
});
