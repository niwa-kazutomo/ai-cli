import { describe, it, expect, vi, beforeEach } from "vitest";
import { CodexCliBackend, extractCodexResponse, extractCodexSessionId } from "../../src/providers/codex-backend.js";

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

describe("CodexCliBackend 引数構築", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("generatePlan で exec --sandbox workspace-write --json が使用される", async () => {
    mockRunCli.mockImplementation(async (_cmd, opts) => {
      const line = JSON.stringify({ type: "item.completed", item: { id: "item_1", type: "agent_message", text: "ok" } }) + "\n";
      opts.onStdout?.(line);
      return { exitCode: 0, stdout: line, stderr: "" };
    });

    const backend = new CodexCliBackend({
      cwd: "/tmp",
      streaming: true,
      onStdout: () => {},
    });
    await backend.run({
      prompt: "test",
      resumeSessionId: null,
      hints: { operation: "generatePlan" },
    });

    const callArgs = mockRunCli.mock.calls[0][1].args;
    expect(callArgs).toContain("exec");
    expect(callArgs).toContain("--sandbox");
    expect(callArgs).toContain("workspace-write");
    expect(callArgs).toContain("--json");
    expect(callArgs).not.toContain("resume");
  });

  it("generateCode (dangerous=true) で sandbox danger-full-access が使用される", async () => {
    mockRunCli.mockImplementation(async (_cmd, opts) => {
      const line = JSON.stringify({ type: "item.completed", item: { id: "item_1", type: "agent_message", text: "ok" } }) + "\n";
      opts.onStdout?.(line);
      return { exitCode: 0, stdout: line, stderr: "" };
    });

    const backend = new CodexCliBackend({
      cwd: "/tmp",
      streaming: true,
      onStdout: () => {},
    });
    await backend.run({
      prompt: "test",
      resumeSessionId: null,
      hints: { operation: "generateCode", dangerous: true },
    });

    const callArgs = mockRunCli.mock.calls[0][1].args;
    expect(callArgs).toContain("danger-full-access");
    expect(callArgs).not.toContain("workspace-write");
  });

  it("reviewPlan で sandbox read-only が使用される", async () => {
    mockRunCli.mockResolvedValue({
      exitCode: 0,
      stdout: JSON.stringify({ type: "item.completed", item: { id: "item_1", type: "agent_message", text: "ok" } }),
      stderr: "",
    });

    const backend = new CodexCliBackend({ cwd: "/tmp" });
    await backend.run({
      prompt: "test",
      resumeSessionId: null,
      hints: { operation: "reviewPlan" },
    });

    const callArgs = mockRunCli.mock.calls[0][1].args;
    expect(callArgs).toContain("read-only");
  });

  it("reviewCode で sandboxMode が反映される", async () => {
    mockRunCli.mockResolvedValue({
      exitCode: 0,
      stdout: JSON.stringify({ type: "item.completed", item: { id: "item_1", type: "agent_message", text: "ok" } }),
      stderr: "",
    });

    const backend = new CodexCliBackend({ cwd: "/tmp" });
    await backend.run({
      prompt: "test",
      resumeSessionId: null,
      hints: { operation: "reviewCode", sandboxMode: "danger-full-access" },
    });

    const callArgs = mockRunCli.mock.calls[0][1].args;
    expect(callArgs).toContain("danger-full-access");
  });

  it("judge で sandbox read-only が使用される", async () => {
    mockRunCli.mockResolvedValue({
      exitCode: 0,
      stdout: JSON.stringify({ type: "item.completed", item: { id: "item_1", type: "agent_message", text: "ok" } }),
      stderr: "",
    });

    const backend = new CodexCliBackend({ cwd: "/tmp" });
    await backend.run({
      prompt: "test",
      resumeSessionId: null,
      hints: { operation: "judge" },
    });

    const callArgs = mockRunCli.mock.calls[0][1].args;
    expect(callArgs).toContain("read-only");
  });

  it("resumeSessionId で exec resume が使用される", async () => {
    mockRunCli.mockResolvedValue({
      exitCode: 0,
      stdout: JSON.stringify({ type: "item.completed", item: { id: "item_1", type: "agent_message", text: "ok" } }),
      stderr: "",
    });

    const backend = new CodexCliBackend({ cwd: "/tmp" });
    await backend.run({
      prompt: "test",
      resumeSessionId: "sess-abc",
      hints: { operation: "generatePlan" },
    });

    const callArgs = mockRunCli.mock.calls[0][1].args as string[];
    expect(callArgs).toContain("resume");
    expect(callArgs).toContain("sess-abc");
    expect(callArgs).not.toContain("--sandbox");
  });

  it("model で --model が渡される", async () => {
    mockRunCli.mockResolvedValue({
      exitCode: 0,
      stdout: JSON.stringify({ type: "item.completed", item: { id: "item_1", type: "agent_message", text: "ok" } }),
      stderr: "",
    });

    const backend = new CodexCliBackend({ cwd: "/tmp", model: "o3-mini" });
    await backend.run({
      prompt: "test",
      resumeSessionId: null,
      hints: { operation: "generatePlan" },
    });

    const callArgs = mockRunCli.mock.calls[0][1].args as string[];
    expect(callArgs).toContain("--model");
    expect(callArgs).toContain("o3-mini");
  });
});

describe("CodexCliBackend レスポンス抽出", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("agent_message なし（turn.completed のみ）→ extractionSucceeded=false", async () => {
    mockRunCli.mockResolvedValue({
      exitCode: 0,
      stdout: JSON.stringify({ type: "turn.completed", usage: {} }),
      stderr: "",
    });

    const backend = new CodexCliBackend({ cwd: "/tmp" });
    const result = await backend.run({
      prompt: "test",
      resumeSessionId: null,
      hints: { operation: "judge" },
    });

    expect(result.extractionSucceeded).toBe(false);
  });

  it("agent_message あり → extractionSucceeded=true", async () => {
    const jsonl = JSON.stringify({ type: "item.completed", item: { id: "item_1", type: "agent_message", text: "result" } });
    mockRunCli.mockResolvedValue({
      exitCode: 0,
      stdout: jsonl,
      stderr: "",
    });

    const backend = new CodexCliBackend({ cwd: "/tmp" });
    const result = await backend.run({
      prompt: "test",
      resumeSessionId: null,
      hints: { operation: "judge" },
    });

    expect(result.response).toBe("result");
    expect(result.extractionSucceeded).toBe(true);
  });
});

describe("CodexCliBackend ストリーミング", () => {
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

    const backend = new CodexCliBackend({
      cwd: "/tmp",
      streaming: true,
      onStdout: (chunk) => chunks.push(chunk),
    });
    const result = await backend.run({
      prompt: "test",
      resumeSessionId: null,
      hints: { operation: "generatePlan" },
    });

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

    const backend = new CodexCliBackend({
      cwd: "/tmp",
      streaming: false,
      onStdout: (chunk) => chunks.push(chunk),
    });
    const result = await backend.run({
      prompt: "test",
      resumeSessionId: null,
      hints: { operation: "generatePlan" },
    });

    expect(result.response).toBe("Raw output");
    expect(chunks).toEqual([jsonl]);
  });

  it("streaming=true で複数 item の agent_message が正しく結合される", async () => {
    const chunks: string[] = [];

    mockRunCli.mockImplementation(async (_cmd, opts) => {
      const line1 = JSON.stringify({ type: "item.completed", item: { id: "item_1", type: "agent_message", text: "First item" } }) + "\n";
      const line2 = JSON.stringify({ type: "item.completed", item: { id: "item_2", type: "agent_message", text: "Second item" } }) + "\n";
      opts.onStdout?.(line1 + line2);
      return { exitCode: 0, stdout: line1 + line2, stderr: "" };
    });

    const backend = new CodexCliBackend({
      cwd: "/tmp",
      streaming: true,
      onStdout: (chunk) => chunks.push(chunk),
    });
    const result = await backend.run({
      prompt: "test",
      resumeSessionId: null,
      hints: { operation: "generatePlan" },
    });

    expect(result.response).toBe("First item\nSecond item");
    expect(chunks.join("")).toBe("First item\nSecond item");
  });
});
