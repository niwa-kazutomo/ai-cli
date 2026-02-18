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

describe("ストリーミングモード", () => {
  let runCliMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetAllMocks();
    const cliRunner = await import("../src/cli-runner.js");
    runCliMock = cliRunner.runCli as ReturnType<typeof vi.fn>;
  });

  it("streaming: true で --output-format stream-json, --verbose, --include-partial-messages が渡される", async () => {
    runCliMock.mockImplementation((_cmd: string, opts: { args: string[]; onStdout?: (chunk: string) => void }) => {
      // stream-json 形式でイベントを発火
      const events = [
        '{"type":"system","session_id":"stream-sess"}\n',
        '{"type":"result","result":"streamed plan","session_id":"stream-sess"}\n',
      ];
      for (const event of events) {
        opts.onStdout?.(event);
      }
      return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" });
    });

    const { generatePlan } = await import("../src/claude-code.js");
    const session = { claudeSessionId: null, claudeFirstRun: true, codexSessionId: null, codexFirstRun: true };

    await generatePlan(session, "test", { cwd: "/tmp", streaming: true });

    const calledArgs = runCliMock.mock.calls[0][1].args as string[];
    expect(calledArgs).toContain("stream-json");
    expect(calledArgs).not.toContain("json");
    expect(calledArgs).toContain("--verbose");
    expect(calledArgs).toContain("--include-partial-messages");
  });

  it("streaming: false で --output-format json が維持され、--verbose が付かない", async () => {
    runCliMock.mockResolvedValue({
      exitCode: 0,
      stdout: JSON.stringify({ session_id: "sess-1", result: "plan" }),
      stderr: "",
    });

    const { generatePlan } = await import("../src/claude-code.js");
    const session = { claudeSessionId: null, claudeFirstRun: true, codexSessionId: null, codexFirstRun: true };

    await generatePlan(session, "test", { cwd: "/tmp", streaming: false });

    const calledArgs = runCliMock.mock.calls[0][1].args as string[];
    expect(calledArgs).toContain("json");
    expect(calledArgs).not.toContain("stream-json");
    expect(calledArgs).not.toContain("--verbose");
    expect(calledArgs).not.toContain("--include-partial-messages");
  });

  it("streaming 未指定で json 経路が使われる", async () => {
    runCliMock.mockResolvedValue({
      exitCode: 0,
      stdout: JSON.stringify({ session_id: "sess-1", result: "plan" }),
      stderr: "",
    });

    const { generatePlan } = await import("../src/claude-code.js");
    const session = { claudeSessionId: null, claudeFirstRun: true, codexSessionId: null, codexFirstRun: true };

    await generatePlan(session, "test", { cwd: "/tmp" });

    const calledArgs = runCliMock.mock.calls[0][1].args as string[];
    expect(calledArgs).toContain("json");
    expect(calledArgs).not.toContain("stream-json");
  });

  it("stream-json 出力から response と sessionId を正しく抽出する", async () => {
    runCliMock.mockImplementation((_cmd: string, opts: { args: string[]; onStdout?: (chunk: string) => void }) => {
      const events = [
        '{"type":"system","session_id":"stream-sess-abc"}\n',
        '{"type":"assistant","message":{"content":[{"type":"text","text":"partial"}]}}\n',
        '{"type":"result","result":"final response text","session_id":"stream-sess-abc"}\n',
      ];
      for (const event of events) {
        opts.onStdout?.(event);
      }
      return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" });
    });

    const { generatePlan } = await import("../src/claude-code.js");
    const session = { claudeSessionId: null, claudeFirstRun: true, codexSessionId: null, codexFirstRun: true };

    const result = await generatePlan(session, "test", { cwd: "/tmp", streaming: true });

    expect(result.response).toBe("final response text");
    expect(session.claudeSessionId).toBe("stream-sess-abc");
  });

  it("onStdout が差分テキストのみ受け取る（重複表示防止）", async () => {
    const receivedChunks: string[] = [];

    runCliMock.mockImplementation((_cmd: string, opts: { args: string[]; onStdout?: (chunk: string) => void }) => {
      // partial message: "Hello" → "Hello World"
      const events = [
        '{"type":"system","session_id":"sess-delta"}\n',
        '{"type":"assistant","message":{"content":[{"type":"text","text":"Hello"}]}}\n',
        '{"type":"assistant","message":{"content":[{"type":"text","text":"Hello World"}]}}\n',
        '{"type":"result","result":"Hello World","session_id":"sess-delta"}\n',
      ];
      for (const event of events) {
        opts.onStdout?.(event);
      }
      return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" });
    });

    const { generatePlan } = await import("../src/claude-code.js");
    const session = { claudeSessionId: null, claudeFirstRun: true, codexSessionId: null, codexFirstRun: true };

    await generatePlan(session, "test", {
      cwd: "/tmp",
      streaming: true,
      onStdout: (chunk: string) => receivedChunks.push(chunk),
    });

    // 1回目: "Hello", 2回目: " World" (差分のみ), 末尾改行
    expect(receivedChunks).toEqual(["Hello", " World", "\n"]);
  });

  it("テキスト長縮退時に prevEmittedLength がリセットされる", async () => {
    const receivedChunks: string[] = [];

    runCliMock.mockImplementation((_cmd: string, opts: { args: string[]; onStdout?: (chunk: string) => void }) => {
      const events = [
        '{"type":"system","session_id":"sess-shrink"}\n',
        '{"type":"assistant","message":{"content":[{"type":"text","text":"Long text here"}]}}\n',
        // テキストが短くなるケース（再構成等）
        '{"type":"assistant","message":{"content":[{"type":"text","text":"Short"}]}}\n',
        '{"type":"result","result":"Short","session_id":"sess-shrink"}\n',
      ];
      for (const event of events) {
        opts.onStdout?.(event);
      }
      return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" });
    });

    const { generatePlan } = await import("../src/claude-code.js");
    const session = { claudeSessionId: null, claudeFirstRun: true, codexSessionId: null, codexFirstRun: true };

    await generatePlan(session, "test", {
      cwd: "/tmp",
      streaming: true,
      onStdout: (chunk: string) => receivedChunks.push(chunk),
    });

    // 1回目: "Long text here", 2回目: "Short"（リセット後に全文再出力）, 末尾改行
    expect(receivedChunks).toEqual(["Long text here", "Short", "\n"]);
  });

  it("末尾改行なしの最終 assistant イベントが onStdout に流れる", async () => {
    const receivedChunks: string[] = [];

    runCliMock.mockImplementation((_cmd: string, opts: { args: string[]; onStdout?: (chunk: string) => void }) => {
      // 最後のイベントが改行なしで終了 → feed() では取れず flush() で処理される
      opts.onStdout?.('{"type":"system","session_id":"sess-noeol"}\n');
      opts.onStdout?.('{"type":"assistant","message":{"content":[{"type":"text","text":"Hello"}]}}');
      // ↑ 改行なしのため feed() のバッファに残る
      return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" });
    });

    const { generatePlan } = await import("../src/claude-code.js");
    const session = { claudeSessionId: null, claudeFirstRun: true, codexSessionId: null, codexFirstRun: true };

    const result = await generatePlan(session, "test", {
      cwd: "/tmp",
      streaming: true,
      onStdout: (chunk: string) => receivedChunks.push(chunk),
    });

    // flush() 経由でも onStdout に差分が転送されること + 末尾改行
    expect(receivedChunks).toEqual(["Hello", "\n"]);
    expect(result.response).toBe("Hello");
    expect(session.claudeSessionId).toBe("sess-noeol");
  });

  it("最終差分が改行で終わる場合は末尾改行を追加しない", async () => {
    const receivedChunks: string[] = [];
    runCliMock.mockImplementation((_cmd: string, opts: { args: string[]; onStdout?: (chunk: string) => void }) => {
      opts.onStdout?.('{"type":"system","session_id":"sess-nl"}\n');
      opts.onStdout?.('{"type":"assistant","message":{"content":[{"type":"text","text":"Done\\n"}]}}\n');
      opts.onStdout?.('{"type":"result","result":"Done\\n","session_id":"sess-nl"}\n');
      return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" });
    });
    const { generatePlan } = await import("../src/claude-code.js");
    const session = { claudeSessionId: null, claudeFirstRun: true, codexSessionId: null, codexFirstRun: true };
    await generatePlan(session, "test", {
      cwd: "/tmp",
      streaming: true,
      onStdout: (chunk: string) => receivedChunks.push(chunk),
    });
    // "Done\n" のみ。末尾に余分な "\n" が追加されないこと
    expect(receivedChunks).toEqual(["Done\n"]);
  });

  it("テキスト縮退後も末尾改行が付与される", async () => {
    const receivedChunks: string[] = [];
    runCliMock.mockImplementation((_cmd: string, opts: { args: string[]; onStdout?: (chunk: string) => void }) => {
      opts.onStdout?.('{"type":"system","session_id":"sess-shrink2"}\n');
      // テキスト emit → 縮退（prevEmittedLength が 0 にリセット）→ 短いテキスト再 emit
      opts.onStdout?.('{"type":"assistant","message":{"content":[{"type":"text","text":"First"}]}}\n');
      opts.onStdout?.('{"type":"assistant","message":{"content":[{"type":"text","text":"AB"}]}}\n');
      opts.onStdout?.('{"type":"result","result":"AB","session_id":"sess-shrink2"}\n');
      return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" });
    });
    const { generatePlan } = await import("../src/claude-code.js");
    const session = { claudeSessionId: null, claudeFirstRun: true, codexSessionId: null, codexFirstRun: true };
    await generatePlan(session, "test", {
      cwd: "/tmp",
      streaming: true,
      onStdout: (chunk: string) => receivedChunks.push(chunk),
    });
    // 縮退でリセット後も hasEmittedText = true なので末尾 "\n" が追加される
    expect(receivedChunks).toEqual(["First", "AB", "\n"]);
  });

  it("streaming: false で json 経路が正常動作する（クラッシュしない）", async () => {
    runCliMock.mockResolvedValue({
      exitCode: 0,
      stdout: JSON.stringify({ session_id: "sess-json", result: "json result" }),
      stderr: "",
    });

    const { generateCode } = await import("../src/claude-code.js");
    const session = { claudeSessionId: null, claudeFirstRun: true, codexSessionId: null, codexFirstRun: true };

    const result = await generateCode(session, "test", { cwd: "/tmp", streaming: false });

    expect(result.response).toBe("json result");
    expect(session.claudeSessionId).toBe("sess-json");
  });
});
