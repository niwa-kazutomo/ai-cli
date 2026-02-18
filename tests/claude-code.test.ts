import { describe, it, expect, vi, beforeEach } from "vitest";
import { extractResponse, extractSessionId } from "../src/claude-code.js";

// logger モック
vi.mock("../src/logger.js", () => ({
  error: vi.fn(),
  warn: vi.fn(),
  verbose: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
}));

// cli-runner モック
vi.mock("../src/cli-runner.js", () => ({
  runCli: vi.fn(),
}));

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

describe("セッション管理フロー", () => {
  let runCliMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetAllMocks();
    const cliRunner = await import("../src/cli-runner.js");
    runCliMock = cliRunner.runCli as ReturnType<typeof vi.fn>;
  });

  it("初回 generatePlan で --session-id が引数に含まれない", async () => {
    runCliMock.mockResolvedValue({
      exitCode: 0,
      stdout: JSON.stringify({ session_id: "new-sess-id", result: "plan" }),
      stderr: "",
    });

    const { generatePlan } = await import("../src/claude-code.js");
    const session = { claudeSessionId: null, claudeFirstRun: true, codexSessionId: null, codexFirstRun: true };

    await generatePlan(session, "test prompt", { cwd: "/tmp" });

    const calledArgs = runCliMock.mock.calls[0][1].args as string[];
    expect(calledArgs).not.toContain("--session-id");
  });

  it("初回レスポンスから session_id を保存し、2回目で --resume を使う", async () => {
    runCliMock.mockResolvedValue({
      exitCode: 0,
      stdout: JSON.stringify({ session_id: "new-sess-id", result: "plan" }),
      stderr: "",
    });

    const { generatePlan } = await import("../src/claude-code.js");
    const session = { claudeSessionId: null, claudeFirstRun: true, codexSessionId: null, codexFirstRun: true };

    await generatePlan(session, "test prompt", { cwd: "/tmp" });

    expect(session.claudeSessionId).toBe("new-sess-id");
    expect(session.claudeFirstRun).toBe(false);

    // 2回目の呼び出し
    runCliMock.mockResolvedValue({
      exitCode: 0,
      stdout: JSON.stringify({ session_id: "new-sess-id", result: "revised plan" }),
      stderr: "",
    });

    await generatePlan(session, "revision prompt", { cwd: "/tmp" });

    const secondArgs = runCliMock.mock.calls[1][1].args as string[];
    expect(secondArgs).toContain("--resume");
    expect(secondArgs).toContain("new-sess-id");
  });

  it("session_id 抽出失敗時にエラーで停止する", async () => {
    runCliMock.mockResolvedValue({
      exitCode: 0,
      stdout: JSON.stringify({ result: "plan without session_id" }),
      stderr: "",
    });

    const { generatePlan } = await import("../src/claude-code.js");
    const session = { claudeSessionId: null, claudeFirstRun: true, codexSessionId: null, codexFirstRun: true };

    await expect(generatePlan(session, "test", { cwd: "/tmp" })).rejects.toThrow("session_id");
  });

  it("session_id 抽出失敗時に claudeFirstRun が true のまま（markClaudeUsed が呼ばれていない）", async () => {
    runCliMock.mockResolvedValue({
      exitCode: 0,
      stdout: JSON.stringify({ result: "plan without session_id" }),
      stderr: "",
    });

    const { generatePlan } = await import("../src/claude-code.js");
    const session = { claudeSessionId: null, claudeFirstRun: true, codexSessionId: null, codexFirstRun: true };

    await expect(generatePlan(session, "test", { cwd: "/tmp" })).rejects.toThrow();
    expect(session.claudeFirstRun).toBe(true);
  });

  it("exit code 非ゼロ時に claudeFirstRun が true のまま", async () => {
    runCliMock.mockResolvedValue({
      exitCode: 1,
      stdout: "",
      stderr: "error",
    });

    const { generatePlan } = await import("../src/claude-code.js");
    const session = { claudeSessionId: null, claudeFirstRun: true, codexSessionId: null, codexFirstRun: true };

    await expect(generatePlan(session, "test", { cwd: "/tmp" })).rejects.toThrow();
    expect(session.claudeFirstRun).toBe(true);
  });

  it("claudeFirstRun=false かつ claudeSessionId=null の場合にエラー", async () => {
    const { generatePlan } = await import("../src/claude-code.js");
    const session = { claudeSessionId: null, claudeFirstRun: false, codexSessionId: null, codexFirstRun: true };

    await expect(generatePlan(session, "test", { cwd: "/tmp" })).rejects.toThrow("不整合");
  });
});
