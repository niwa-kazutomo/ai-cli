import { describe, it, expect, vi, beforeEach } from "vitest";
import { ClaudeCliBackend, extractResponse, extractSessionId } from "../../src/providers/claude-backend.js";

vi.mock("../../src/logger.js", () => ({
  error: vi.fn(),
  warn: vi.fn(),
  verbose: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
}));

vi.mock("../../src/cli-runner.js", () => ({
  runCli: vi.fn(),
}));

import { runCli } from "../../src/cli-runner.js";
const mockRunCli = vi.mocked(runCli);

describe("extractResponse", () => {
  it("result フィールドからテキストを抽出する", () => {
    const json = JSON.stringify({ result: "Hello World" });
    expect(extractResponse(json)).toBe("Hello World");
  });

  it("content 配列からテキストを抽出する", () => {
    const json = JSON.stringify({
      content: [
        { type: "text", text: "First part" },
        { type: "tool_use", id: "123" },
        { type: "text", text: "Second part" },
      ],
    });
    expect(extractResponse(json)).toBe("First part\nSecond part");
  });

  it("text フィールドからテキストを抽出する", () => {
    const json = JSON.stringify({ text: "Simple text" });
    expect(extractResponse(json)).toBe("Simple text");
  });

  it("JSON パース失敗時に生テキストを返す", () => {
    const raw = "This is not JSON {invalid";
    expect(extractResponse(raw)).toBe(raw);
  });

  it("文字列の JSON を返す", () => {
    const json = JSON.stringify("Just a string");
    expect(extractResponse(json)).toBe("Just a string");
  });

  it("既知のフィールドがないオブジェクトを JSON 文字列化して返す", () => {
    const obj = { unknown: "field", data: [1, 2, 3] };
    const json = JSON.stringify(obj);
    expect(extractResponse(json)).toBe(json);
  });
});

describe("extractSessionId", () => {
  it("session_id フィールドを正常に抽出する", () => {
    const json = JSON.stringify({ session_id: "sess-abc123", result: "hello" });
    expect(extractSessionId(json)).toBe("sess-abc123");
  });

  it("session_id フィールドがない場合は null を返す", () => {
    const json = JSON.stringify({ result: "hello" });
    expect(extractSessionId(json)).toBeNull();
  });

  it("JSON パース失敗時は null を返す", () => {
    expect(extractSessionId("not valid json")).toBeNull();
  });

  it("session_id が文字列でない場合は null を返す", () => {
    const json = JSON.stringify({ session_id: 12345 });
    expect(extractSessionId(json)).toBeNull();
  });

  it("空文字列で null を返す", () => {
    expect(extractSessionId("")).toBeNull();
  });
});

describe("ClaudeCliBackend 引数構築", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("generatePlan で --print --output-format json が渡される", async () => {
    mockRunCli.mockResolvedValue({
      exitCode: 0,
      stdout: JSON.stringify({ session_id: "sess-1", result: "plan" }),
      stderr: "",
    });

    const backend = new ClaudeCliBackend({ cwd: "/tmp" });
    await backend.run({
      prompt: "test",
      resumeSessionId: null,
      hints: { operation: "generatePlan" },
    });

    const args = mockRunCli.mock.calls[0][1].args as string[];
    expect(args).toContain("--print");
    expect(args).toContain("--output-format");
    expect(args).toContain("json");
    expect(args).not.toContain("--permission-mode");
  });

  it("generateCode (dangerous=false) で --permission-mode acceptEdits が渡される", async () => {
    mockRunCli.mockResolvedValue({
      exitCode: 0,
      stdout: JSON.stringify({ session_id: "sess-1", result: "code" }),
      stderr: "",
    });

    const backend = new ClaudeCliBackend({ cwd: "/tmp" });
    await backend.run({
      prompt: "test",
      resumeSessionId: null,
      hints: { operation: "generateCode", dangerous: false },
    });

    const args = mockRunCli.mock.calls[0][1].args as string[];
    expect(args).toContain("--permission-mode");
    expect(args).toContain("acceptEdits");
    expect(args).not.toContain("--dangerously-skip-permissions");
  });

  it("generateCode (dangerous=true) で --dangerously-skip-permissions が渡される", async () => {
    mockRunCli.mockResolvedValue({
      exitCode: 0,
      stdout: JSON.stringify({ session_id: "sess-1", result: "code" }),
      stderr: "",
    });

    const backend = new ClaudeCliBackend({ cwd: "/tmp" });
    await backend.run({
      prompt: "test",
      resumeSessionId: null,
      hints: { operation: "generateCode", dangerous: true },
    });

    const args = mockRunCli.mock.calls[0][1].args as string[];
    expect(args).toContain("--dangerously-skip-permissions");
    expect(args).not.toContain("--permission-mode");
  });

  it("judge で --no-session-persistence が渡され、--output-format json は付かない", async () => {
    mockRunCli.mockResolvedValue({
      exitCode: 0,
      stdout: "plain text",
      stderr: "",
    });

    const backend = new ClaudeCliBackend({ cwd: "/tmp" });
    await backend.run({
      prompt: "test",
      resumeSessionId: null,
      hints: { operation: "judge" },
    });

    const args = mockRunCli.mock.calls[0][1].args as string[];
    expect(args).toContain("--print");
    expect(args).toContain("--no-session-persistence");
    expect(args).not.toContain("--output-format");
  });

  it("resumeSessionId で --resume が渡される", async () => {
    mockRunCli.mockResolvedValue({
      exitCode: 0,
      stdout: JSON.stringify({ result: "resumed" }),
      stderr: "",
    });

    const backend = new ClaudeCliBackend({ cwd: "/tmp" });
    await backend.run({
      prompt: "test",
      resumeSessionId: "sess-abc",
      hints: { operation: "generatePlan" },
    });

    const args = mockRunCli.mock.calls[0][1].args as string[];
    expect(args).toContain("--resume");
    expect(args).toContain("sess-abc");
  });

  it("model で --model が渡される", async () => {
    mockRunCli.mockResolvedValue({
      exitCode: 0,
      stdout: JSON.stringify({ session_id: "sess-1", result: "plan" }),
      stderr: "",
    });

    const backend = new ClaudeCliBackend({ cwd: "/tmp", model: "claude-sonnet-4-20250514" });
    await backend.run({
      prompt: "test",
      resumeSessionId: null,
      hints: { operation: "generatePlan" },
    });

    const args = mockRunCli.mock.calls[0][1].args as string[];
    expect(args).toContain("--model");
    expect(args).toContain("claude-sonnet-4-20250514");
  });
});

describe("ClaudeCliBackend レスポンス抽出", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("JSON レスポンスから response と sessionId を正しく抽出する", async () => {
    mockRunCli.mockResolvedValue({
      exitCode: 0,
      stdout: JSON.stringify({ session_id: "sess-123", result: "plan output" }),
      stderr: "",
    });

    const backend = new ClaudeCliBackend({ cwd: "/tmp" });
    const result = await backend.run({
      prompt: "test",
      resumeSessionId: null,
      hints: { operation: "generatePlan" },
    });

    expect(result.response).toBe("plan output");
    expect(result.sessionId).toBe("sess-123");
    expect(result.extractionSucceeded).toBe(true);
  });

  it("judge はプレーンテキストを返し extractionSucceeded=true", async () => {
    mockRunCli.mockResolvedValue({
      exitCode: 0,
      stdout: "懸念事項なし",
      stderr: "",
    });

    const backend = new ClaudeCliBackend({ cwd: "/tmp" });
    const result = await backend.run({
      prompt: "test",
      resumeSessionId: null,
      hints: { operation: "judge" },
    });

    expect(result.response).toBe("懸念事項なし");
    expect(result.sessionId).toBeNull();
    expect(result.extractionSucceeded).toBe(true);
  });

  it("JSON パース失敗時に extractionSucceeded=false", async () => {
    mockRunCli.mockResolvedValue({
      exitCode: 0,
      stdout: "not json at all",
      stderr: "",
    });

    const backend = new ClaudeCliBackend({ cwd: "/tmp" });
    const result = await backend.run({
      prompt: "test",
      resumeSessionId: null,
      hints: { operation: "generatePlan" },
    });

    expect(result.response).toBe("not json at all");
    expect(result.extractionSucceeded).toBe(false);
  });
});

describe("ClaudeCliBackend ストリーミング", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("streaming: true で --output-format stream-json, --verbose, --include-partial-messages が渡される", async () => {
    mockRunCli.mockImplementation(async (_cmd, opts) => {
      const events = [
        '{"type":"system","session_id":"stream-sess"}\n',
        '{"type":"result","result":"streamed plan","session_id":"stream-sess"}\n',
      ];
      for (const event of events) {
        opts.onStdout?.(event);
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    });

    const backend = new ClaudeCliBackend({ cwd: "/tmp", streaming: true });
    await backend.run({
      prompt: "test",
      resumeSessionId: null,
      hints: { operation: "generatePlan" },
    });

    const calledArgs = mockRunCli.mock.calls[0][1].args as string[];
    expect(calledArgs).toContain("stream-json");
    expect(calledArgs).not.toContain("json");
    expect(calledArgs).toContain("--verbose");
    expect(calledArgs).toContain("--include-partial-messages");
  });

  it("streaming: false で --output-format json が維持される", async () => {
    mockRunCli.mockResolvedValue({
      exitCode: 0,
      stdout: JSON.stringify({ session_id: "sess-1", result: "plan" }),
      stderr: "",
    });

    const backend = new ClaudeCliBackend({ cwd: "/tmp", streaming: false });
    await backend.run({
      prompt: "test",
      resumeSessionId: null,
      hints: { operation: "generatePlan" },
    });

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
        '{"type":"result","result":"final response text","session_id":"stream-sess-abc"}\n',
      ];
      for (const event of events) {
        opts.onStdout?.(event);
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    });

    const backend = new ClaudeCliBackend({ cwd: "/tmp", streaming: true });
    const result = await backend.run({
      prompt: "test",
      resumeSessionId: null,
      hints: { operation: "generatePlan" },
    });

    expect(result.response).toBe("final response text");
    expect(result.sessionId).toBe("stream-sess-abc");
    expect(result.extractionSucceeded).toBe(true);
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

    const backend = new ClaudeCliBackend({
      cwd: "/tmp",
      streaming: true,
      onStdout: (chunk: string) => receivedChunks.push(chunk),
    });
    await backend.run({
      prompt: "test",
      resumeSessionId: null,
      hints: { operation: "generatePlan" },
    });

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

    const backend = new ClaudeCliBackend({
      cwd: "/tmp",
      streaming: true,
      onStdout: (chunk: string) => receivedChunks.push(chunk),
    });
    await backend.run({
      prompt: "test",
      resumeSessionId: null,
      hints: { operation: "generatePlan" },
    });

    expect(receivedChunks).toEqual(["Long text here", "\n", "Short", "\n"]);
  });

  it("複数 assistant メッセージが response に蓄積される", async () => {
    mockRunCli.mockImplementation(async (_cmd, opts) => {
      const events = [
        '{"type":"system","session_id":"sess-multi-msg"}\n',
        '{"type":"assistant","message":{"content":[{"type":"text","text":"# Full Plan\\nStep 1: Do X"}]}}\n',
        '{"type":"tool_result","tool_use_id":"t1","content":"file content"}\n',
        '{"type":"assistant","message":{"content":[{"type":"text","text":"以上が修正後の計画全文です。"}]}}\n',
        '{"type":"result","result":"以上が修正後の計画全文です。","session_id":"sess-multi-msg"}\n',
      ];
      for (const event of events) {
        opts.onStdout?.(event);
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    });

    const backend = new ClaudeCliBackend({ cwd: "/tmp", streaming: true });
    const result = await backend.run({
      prompt: "test",
      resumeSessionId: null,
      hints: { operation: "generatePlan" },
    });

    expect(result.response).toContain("# Full Plan");
    expect(result.response).toContain("Step 1: Do X");
    expect(result.response).toContain("以上が修正後の計画全文です。");
  });
});

describe("ClaudeCliBackend.getRequiredFlags", () => {
  it("generatePlan では --permission-mode を要求しない", () => {
    const flags = ClaudeCliBackend.getRequiredFlags(
      [{ operation: "generatePlan" }],
      false,
    );
    expect(flags).toContain("--print");
    expect(flags).toContain("--output-format");
    expect(flags).toContain("--resume");
    expect(flags).not.toContain("--permission-mode");
  });

  it("generateCode (dangerous=false) で --permission-mode を要求する", () => {
    const flags = ClaudeCliBackend.getRequiredFlags(
      [{ operation: "generateCode" }],
      false,
    );
    expect(flags).toContain("--permission-mode");
    expect(flags).not.toContain("--dangerously-skip-permissions");
  });

  it("generateCode (dangerous=true) で --dangerously-skip-permissions を要求する", () => {
    const flags = ClaudeCliBackend.getRequiredFlags(
      [{ operation: "generateCode" }],
      true,
    );
    expect(flags).toContain("--dangerously-skip-permissions");
  });

  it("judge で --no-session-persistence を要求する", () => {
    const flags = ClaudeCliBackend.getRequiredFlags(
      [{ operation: "judge" }],
      false,
    );
    expect(flags).toContain("--no-session-persistence");
    expect(flags).not.toContain("--output-format");
  });
});
