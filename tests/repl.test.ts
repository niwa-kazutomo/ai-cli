import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { SigintError } from "../src/errors.js";

vi.mock("../src/orchestrator.js", () => ({
  runWorkflow: vi.fn(),
}));

vi.mock("../src/logger.js", () => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  verbose: vi.fn(),
  debug: vi.fn(),
  configureLogger: vi.fn(),
}));

const mockReadFileSync = vi.fn();
const mockWriteFileSync = vi.fn();
const mockChmodSync = vi.fn();
vi.mock("node:fs", () => ({
  readFileSync: (...args: unknown[]) => mockReadFileSync(...args),
  writeFileSync: (...args: unknown[]) => mockWriteFileSync(...args),
  chmodSync: (...args: unknown[]) => mockChmodSync(...args),
}));

// Mock line-editor to control promptOnce behavior
let readLineResolvers: Array<(result: { type: string; value?: string }) => void> = [];
const mockReadLine = vi.fn(
  () =>
    new Promise((resolve) => {
      readLineResolvers.push(resolve);
    }),
);

vi.mock("../src/line-editor.js", () => ({
  readLine: (...args: unknown[]) => mockReadLine(...args),
}));

// Keep node:readline mock for promptOnceSimple fallback tests
let questionCallbacks: Array<(answer: string) => void> = [];
let closeListeners: Array<() => void> = [];
let sigintListeners: Array<() => void> = [];

vi.mock("node:readline", () => ({
  createInterface: vi.fn((_opts: Record<string, unknown>) => ({
    question: vi.fn((_prompt: string, cb: (answer: string) => void) => {
      questionCallbacks.push(cb);
    }),
    close: vi.fn(),
    on: vi.fn((event: string, cb: () => void) => {
      if (event === "close") closeListeners.push(cb);
      if (event === "SIGINT") sigintListeners.push(cb);
    }),
    removeListener: vi.fn(),
  })),
}));

import { startRepl } from "../src/repl.js";
import { runWorkflow } from "../src/orchestrator.js";
import type { ReplOptions } from "../src/types.js";

const mockRunWorkflow = vi.mocked(runWorkflow);

const defaultReplOptions: ReplOptions = {
  maxPlanIterations: 5,
  maxCodeIterations: 5,
  dangerous: false,
  verbose: false,
  debug: false,
  cwd: "/tmp",
};

// Save original stdin properties
const originalIsTTY = process.stdin.isTTY;
const originalSetRawMode = process.stdin.setRawMode;

/**
 * Resolve the pending readLine call with an input result.
 */
async function answerPrompt(answer: string): Promise<void> {
  await vi.waitFor(() => {
    if (readLineResolvers.length === 0) {
      throw new Error("waiting for readLine call");
    }
  });
  const resolve = readLineResolvers.shift()!;
  resolve({ type: "input", value: answer });
  await new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Simulate EOF (Ctrl+D on empty buffer).
 */
async function simulateEof(): Promise<void> {
  await vi.waitFor(() => {
    if (readLineResolvers.length === 0) {
      throw new Error("waiting for readLine call");
    }
  });
  const resolve = readLineResolvers.shift()!;
  resolve({ type: "eof" });
  await new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Simulate Ctrl+C (cancel).
 */
async function simulateCancel(): Promise<void> {
  await vi.waitFor(() => {
    if (readLineResolvers.length === 0) {
      throw new Error("waiting for readLine call");
    }
  });
  const resolve = readLineResolvers.shift()!;
  resolve({ type: "cancel" });
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("startRepl", () => {
  const DUMMY_HISTORY_FILE = "/tmp/test_ai_cli_history";

  beforeEach(() => {
    vi.clearAllMocks();
    readLineResolvers = [];
    questionCallbacks = [];
    closeListeners = [];
    sigintListeners = [];
    mockRunWorkflow.mockResolvedValue(undefined);
    mockReadFileSync.mockImplementation(() => { throw new Error("ENOENT"); });
    mockWriteFileSync.mockImplementation(() => {});
    mockChmodSync.mockImplementation(() => {});
    // Ensure TTY mode for line-editor path
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
    Object.defineProperty(process.stdin, "setRawMode", { value: () => {}, configurable: true });
  });

  afterEach(() => {
    // Restore original stdin properties (including undefined values)
    Object.defineProperty(process.stdin, "isTTY", { value: originalIsTTY, configurable: true });
    Object.defineProperty(process.stdin, "setRawMode", { value: originalSetRawMode, configurable: true });
  });

  it("1回の入力後 exit で runWorkflow が1回呼ばれる", async () => {
    const replPromise = startRepl(defaultReplOptions, "0.1.1", undefined, DUMMY_HISTORY_FILE);

    await answerPrompt("テストプロンプト");
    await answerPrompt("exit");

    await replPromise;

    expect(mockRunWorkflow).toHaveBeenCalledTimes(1);
    expect(mockRunWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: "テストプロンプト" }),
    );
  });

  it("quit で終了する", async () => {
    const replPromise = startRepl(defaultReplOptions, "0.1.1", undefined, DUMMY_HISTORY_FILE);

    await answerPrompt("quit");

    await replPromise;

    expect(mockRunWorkflow).not.toHaveBeenCalled();
  });

  it("空入力は runWorkflow を呼ばない", async () => {
    const replPromise = startRepl(defaultReplOptions, "0.1.1", undefined, DUMMY_HISTORY_FILE);

    await answerPrompt("");
    await answerPrompt("   "); // whitespace only
    await answerPrompt("exit");

    await replPromise;

    expect(mockRunWorkflow).not.toHaveBeenCalled();
  });

  it("複数プロンプトで runWorkflow が複数回呼ばれる", async () => {
    const replPromise = startRepl(defaultReplOptions, "0.1.1", undefined, DUMMY_HISTORY_FILE);

    await answerPrompt("最初のプロンプト");
    await answerPrompt("2番目のプロンプト");
    await answerPrompt("exit");

    await replPromise;

    expect(mockRunWorkflow).toHaveBeenCalledTimes(2);
    expect(mockRunWorkflow).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ prompt: "最初のプロンプト" }),
    );
    expect(mockRunWorkflow).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ prompt: "2番目のプロンプト" }),
    );
  });

  it("runWorkflow がエラーを throw しても REPL は継続する", async () => {
    mockRunWorkflow
      .mockRejectedValueOnce(new Error("テストエラー"))
      .mockResolvedValueOnce(undefined);

    const replPromise = startRepl(defaultReplOptions, "0.1.1", undefined, DUMMY_HISTORY_FILE);

    await answerPrompt("エラーになるプロンプト");
    await answerPrompt("正常なプロンプト");
    await answerPrompt("exit");

    await replPromise;

    expect(mockRunWorkflow).toHaveBeenCalledTimes(2);
  });

  it("EOF (Ctrl+D) で正常終了する", async () => {
    const replPromise = startRepl(defaultReplOptions, "0.1.1", undefined, DUMMY_HISTORY_FILE);

    await simulateEof();

    await replPromise;

    expect(mockRunWorkflow).not.toHaveBeenCalled();
  });

  it("オプションが runWorkflow に正しく渡される", async () => {
    const customOptions: ReplOptions = {
      ...defaultReplOptions,
      verbose: true,
      dangerous: true,
      maxPlanIterations: 3,
    };

    const replPromise = startRepl(customOptions, "0.1.1", undefined, DUMMY_HISTORY_FILE);

    await answerPrompt("テスト");
    await answerPrompt("exit");

    await replPromise;

    expect(mockRunWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: "テスト",
        verbose: true,
        dangerous: true,
        maxPlanIterations: 3,
      }),
    );
  });

  it("プロンプト入力中の Ctrl+C は空文字扱いで再プロンプトされる", async () => {
    const replPromise = startRepl(defaultReplOptions, "0.1.1", undefined, DUMMY_HISTORY_FILE);

    // Ctrl+C → cancel → "" → re-prompt
    await simulateCancel();
    await answerPrompt("exit");

    await replPromise;

    expect(mockRunWorkflow).not.toHaveBeenCalled();
  });

  it("runWorkflow 中の SigintError で REPL が中断メッセージを出して継続する", async () => {
    mockRunWorkflow
      .mockRejectedValueOnce(new SigintError())
      .mockResolvedValueOnce(undefined);

    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    const replPromise = startRepl(defaultReplOptions, "0.1.1", undefined, DUMMY_HISTORY_FILE);

    await answerPrompt("中断されるプロンプト");
    await answerPrompt("正常なプロンプト");
    await answerPrompt("exit");

    await replPromise;

    expect(mockRunWorkflow).toHaveBeenCalledTimes(2);
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining("中断"),
    );

    stderrSpy.mockRestore();
  });

  it("activeOptionsLine 未指定 → ⚙ オプション を含む出力がない", async () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    const replPromise = startRepl(defaultReplOptions, "0.1.1", undefined, DUMMY_HISTORY_FILE);
    await answerPrompt("exit");
    await replPromise;

    const allCalls = stderrSpy.mock.calls.map((c) => String(c[0]));
    expect(allCalls.some((s) => s.includes("⚙ オプション"))).toBe(false);

    stderrSpy.mockRestore();
  });

  it("activeOptionsLine 指定 → ウェルカムメッセージの後にオプション行が出力される", async () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    const replPromise = startRepl(
      defaultReplOptions,
      "0.1.1",
      "⚙ オプション: --debug",
      DUMMY_HISTORY_FILE,
    );
    await answerPrompt("exit");
    await replPromise;

    const allCalls = stderrSpy.mock.calls.map((c) => String(c[0]));
    const welcomeIdx = allCalls.findIndex((s) => s.includes("AI CLI"));
    const optionsIdx = allCalls.findIndex((s) => s.includes("⚙ オプション: --debug"));
    expect(welcomeIdx).toBeGreaterThanOrEqual(0);
    expect(optionsIdx).toBeGreaterThan(welcomeIdx);

    stderrSpy.mockRestore();
  });

  // ── History tests ──

  it("readLine に history が渡される", async () => {
    mockReadFileSync.mockReturnValue("AIH2\nprevious1\0previous2\0");

    const replPromise = startRepl(defaultReplOptions, "0.1.1", undefined, DUMMY_HISTORY_FILE);

    await answerPrompt("new input");
    await answerPrompt("exit");
    await replPromise;

    // First call should pass loaded history
    expect(mockReadLine).toHaveBeenCalled();
    const firstCallOpts = mockReadLine.mock.calls[0][0] as { history: string[] };
    expect(firstCallOpts.history).toContain("previous1");
    expect(firstCallOpts.history).toContain("previous2");
  });

  it("入力後にヒストリーファイルが新形式で保存される", async () => {
    const replPromise = startRepl(defaultReplOptions, "0.1.1", undefined, DUMMY_HISTORY_FILE);

    await answerPrompt("hello world");
    await answerPrompt("exit");
    await replPromise;

    expect(mockWriteFileSync).toHaveBeenCalledWith(
      DUMMY_HISTORY_FILE,
      "AIH2\nhello world\0",
      { mode: 0o600 },
    );
    expect(mockChmodSync).toHaveBeenCalledWith(DUMMY_HISTORY_FILE, 0o600);
  });

  it("exit はヒストリーに保存されない", async () => {
    const replPromise = startRepl(defaultReplOptions, "0.1.1", undefined, DUMMY_HISTORY_FILE);

    await answerPrompt("exit");
    await replPromise;

    expect(mockWriteFileSync).not.toHaveBeenCalled();
  });

  it("quit はヒストリーに保存されない", async () => {
    const replPromise = startRepl(defaultReplOptions, "0.1.1", undefined, DUMMY_HISTORY_FILE);

    await answerPrompt("quit");
    await replPromise;

    expect(mockWriteFileSync).not.toHaveBeenCalled();
  });

  it("連続重複は保存されない", async () => {
    const replPromise = startRepl(defaultReplOptions, "0.1.1", undefined, DUMMY_HISTORY_FILE);

    await answerPrompt("same input");
    await answerPrompt("same input");
    await answerPrompt("exit");
    await replPromise;

    // writeFileSync called twice but both contain only one entry
    expect(mockWriteFileSync).toHaveBeenCalledTimes(2);
    expect(mockWriteFileSync).toHaveBeenLastCalledWith(
      DUMMY_HISTORY_FILE,
      "AIH2\nsame input\0",
      { mode: 0o600 },
    );
  });

  it("ファイル読み込み失敗時に空配列で継続する", async () => {
    mockReadFileSync.mockImplementation(() => { throw new Error("ENOENT"); });

    const replPromise = startRepl(defaultReplOptions, "0.1.1", undefined, DUMMY_HISTORY_FILE);

    await answerPrompt("テスト");
    await answerPrompt("exit");
    await replPromise;

    expect(mockRunWorkflow).toHaveBeenCalledTimes(1);
  });

  it("旧形式ヒストリーファイルが後方互換で読み込まれる", async () => {
    // Legacy format: no AIH2 header, newline-separated
    mockReadFileSync.mockReturnValue("  padded  \n\ttabbed\t\n  \n normal\n");

    const replPromise = startRepl(defaultReplOptions, "0.1.1", undefined, DUMMY_HISTORY_FILE);
    await answerPrompt("exit");
    await replPromise;

    // readLine should have been called with the legacy history loaded and trimmed
    const firstCallOpts = mockReadLine.mock.calls[0][0] as { history: string[] };
    expect(firstCallOpts.history).toEqual(["padded", "tabbed", "normal"]);
  });

  it("ヒストリーが上限500件に制限される", async () => {
    // 600 entries in new format
    const entries = Array.from({ length: 600 }, (_, i) => `entry${i}`);
    mockReadFileSync.mockReturnValue("AIH2\n" + entries.join("\0") + "\0");

    const replPromise = startRepl(defaultReplOptions, "0.1.1", undefined, DUMMY_HISTORY_FILE);
    await answerPrompt("exit");
    await replPromise;

    const firstCallOpts = mockReadLine.mock.calls[0][0] as { history: string[] };
    expect(firstCallOpts.history).toHaveLength(500);
    expect(firstCallOpts.history[0]).toBe("entry0");
    expect(firstCallOpts.history[499]).toBe("entry499");
  });

  it("ヒストリー追加時に上限500件を超えると古い履歴が削除される", async () => {
    const entries = Array.from({ length: 500 }, (_, i) => `old${i}`);
    mockReadFileSync.mockReturnValue("AIH2\n" + entries.join("\0") + "\0");

    const replPromise = startRepl(defaultReplOptions, "0.1.1", undefined, DUMMY_HISTORY_FILE);
    await answerPrompt("new entry");
    await answerPrompt("exit");
    await replPromise;

    const writtenContent = mockWriteFileSync.mock.calls[0][1] as string;
    // New format: AIH2\n + null-separated entries
    expect(writtenContent.startsWith("AIH2\n")).toBe(true);
    const body = writtenContent.slice("AIH2\n".length);
    const writtenEntries = body.split("\0").filter((s: string) => s.length > 0);
    expect(writtenEntries).toHaveLength(500);
    expect(writtenEntries[0]).toBe("new entry");
    expect(writtenEntries).not.toContain("old499");
    expect(writtenEntries[499]).toBe("old498");
  });

  it("ファイル書き込み失敗時にも REPL が継続する", async () => {
    mockWriteFileSync.mockImplementation(() => { throw new Error("EACCES"); });

    const replPromise = startRepl(defaultReplOptions, "0.1.1", undefined, DUMMY_HISTORY_FILE);

    await answerPrompt("1つ目");
    await answerPrompt("2つ目");
    await answerPrompt("exit");
    await replPromise;

    expect(mockRunWorkflow).toHaveBeenCalledTimes(2);
  });

  it("マルチライン入力がそのまま runWorkflow に渡される", async () => {
    const replPromise = startRepl(defaultReplOptions, "0.1.1", undefined, DUMMY_HISTORY_FILE);

    await answerPrompt("line1\nline2\nline3");
    await answerPrompt("exit");
    await replPromise;

    expect(mockRunWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: "line1\nline2\nline3" }),
    );
  });

  it("マルチラインヒストリーが新形式で正しく保存される", async () => {
    const replPromise = startRepl(defaultReplOptions, "0.1.1", undefined, DUMMY_HISTORY_FILE);

    await answerPrompt("line1\nline2");
    await answerPrompt("exit");
    await replPromise;

    expect(mockWriteFileSync).toHaveBeenCalledWith(
      DUMMY_HISTORY_FILE,
      "AIH2\nline1\nline2\0",
      { mode: 0o600 },
    );
  });

  // ── Non-TTY / no setRawMode fallback tests ──

  it("非TTY環境では promptOnceSimple にフォールバックする", async () => {
    Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
    mockReadLine.mockClear();

    const replPromise = startRepl(defaultReplOptions, "0.1.1", undefined, DUMMY_HISTORY_FILE);

    // promptOnceSimple uses node:readline, so we use question callbacks
    await vi.waitFor(() => {
      if (questionCallbacks.length === 0) throw new Error("waiting");
    });
    questionCallbacks.shift()!("exit");
    await new Promise((r) => setTimeout(r, 0));

    await replPromise;

    // readLine (line-editor) should NOT have been called
    expect(mockReadLine).not.toHaveBeenCalled();
  });

  it("setRawMode未対応環境では promptOnceSimple にフォールバックする", async () => {
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
    Object.defineProperty(process.stdin, "setRawMode", { value: undefined, configurable: true });
    mockReadLine.mockClear();

    const replPromise = startRepl(defaultReplOptions, "0.1.1", undefined, DUMMY_HISTORY_FILE);

    await vi.waitFor(() => {
      if (questionCallbacks.length === 0) throw new Error("waiting");
    });
    questionCallbacks.shift()!("exit");
    await new Promise((r) => setTimeout(r, 0));

    await replPromise;

    expect(mockReadLine).not.toHaveBeenCalled();
  });
});
