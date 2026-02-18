import { describe, it, expect, vi, beforeEach } from "vitest";
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

// node:readline をモックして promptOnce の挙動を制御する
let questionCallbacks: Array<(answer: string) => void> = [];
let closeListeners: Array<() => void> = [];
let sigintListeners: Array<() => void> = [];
let mockRlInstance: {
  question: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  removeListener: ReturnType<typeof vi.fn>;
};

vi.mock("node:readline", () => ({
  createInterface: vi.fn(() => {
    mockRlInstance = {
      question: vi.fn((_prompt: string, cb: (answer: string) => void) => {
        questionCallbacks.push(cb);
      }),
      close: vi.fn(),
      on: vi.fn((event: string, cb: () => void) => {
        if (event === "close") {
          closeListeners.push(cb);
        }
        if (event === "SIGINT") {
          sigintListeners.push(cb);
        }
      }),
      removeListener: vi.fn(),
    };
    return mockRlInstance;
  }),
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

/**
 * promptOnce の question コールバックに回答を渡す。
 * createInterface → rl.question のモックが呼ばれるまで待つ。
 */
async function answerPrompt(answer: string): Promise<void> {
  // question が呼ばれるまで tick を回す
  await vi.waitFor(() => {
    if (questionCallbacks.length === 0) {
      throw new Error("waiting for question callback");
    }
  });
  const cb = questionCallbacks.shift()!;
  cb(answer);
  // 次の tick で処理を進める
  await new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * promptOnce の close イベントを発火して EOF をシミュレートする。
 */
async function simulateEof(): Promise<void> {
  await vi.waitFor(() => {
    if (closeListeners.length === 0) {
      throw new Error("waiting for close listener");
    }
  });
  const cb = closeListeners.shift()!;
  cb();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * promptOnce の SIGINT イベントを発火して Ctrl+C をシミュレートする。
 */
async function simulateSigint(): Promise<void> {
  await vi.waitFor(() => {
    if (sigintListeners.length === 0) {
      throw new Error("waiting for SIGINT listener");
    }
  });
  const cb = sigintListeners.shift()!;
  cb();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("startRepl", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    questionCallbacks = [];
    closeListeners = [];
    sigintListeners = [];
    mockRunWorkflow.mockResolvedValue(undefined);
  });

  it("1回の入力後 exit で runWorkflow が1回呼ばれる", async () => {
    const replPromise = startRepl(defaultReplOptions, "0.1.0");

    await answerPrompt("テストプロンプト");
    await answerPrompt("exit");

    await replPromise;

    expect(mockRunWorkflow).toHaveBeenCalledTimes(1);
    expect(mockRunWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: "テストプロンプト" }),
    );
  });

  it("quit で終了する", async () => {
    const replPromise = startRepl(defaultReplOptions, "0.1.0");

    await answerPrompt("quit");

    await replPromise;

    expect(mockRunWorkflow).not.toHaveBeenCalled();
  });

  it("空入力は runWorkflow を呼ばない", async () => {
    const replPromise = startRepl(defaultReplOptions, "0.1.0");

    await answerPrompt("");
    await answerPrompt("   "); // 空白のみ
    await answerPrompt("exit");

    await replPromise;

    expect(mockRunWorkflow).not.toHaveBeenCalled();
  });

  it("複数プロンプトで runWorkflow が複数回呼ばれる", async () => {
    const replPromise = startRepl(defaultReplOptions, "0.1.0");

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

    const replPromise = startRepl(defaultReplOptions, "0.1.0");

    await answerPrompt("エラーになるプロンプト");
    await answerPrompt("正常なプロンプト");
    await answerPrompt("exit");

    await replPromise;

    expect(mockRunWorkflow).toHaveBeenCalledTimes(2);
  });

  it("EOF (Ctrl+D) で正常終了する", async () => {
    const replPromise = startRepl(defaultReplOptions, "0.1.0");

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

    const replPromise = startRepl(customOptions, "0.1.0");

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
    const replPromise = startRepl(defaultReplOptions, "0.1.0");

    // Ctrl+C → 空文字 resolve → 再プロンプト
    await simulateSigint();
    // SIGINT 後、旧 promptOnce の stale question callback が残っているので
    // 1回目の answerPrompt は stale callback を消費する（no-op）
    await answerPrompt("exit"); // stale callback 消費
    await answerPrompt("exit"); // 新しい promptOnce に "exit" を渡す

    await replPromise;

    expect(mockRunWorkflow).not.toHaveBeenCalled();
  });

  it("runWorkflow 中の SigintError で REPL が中断メッセージを出して継続する", async () => {
    mockRunWorkflow
      .mockRejectedValueOnce(new SigintError())
      .mockResolvedValueOnce(undefined);

    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    const replPromise = startRepl(defaultReplOptions, "0.1.0");

    await answerPrompt("中断されるプロンプト");
    await answerPrompt("正常なプロンプト");
    await answerPrompt("exit");

    await replPromise;

    // SigintError 後も REPL が継続していること
    expect(mockRunWorkflow).toHaveBeenCalledTimes(2);
    // 中断メッセージが出力されていること
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining("中断"),
    );

    stderrSpy.mockRestore();
  });

  it("activeOptionsLine 未指定 → ⚙ オプション を含む出力がない", async () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    const replPromise = startRepl(defaultReplOptions, "0.1.0");
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
      "0.1.0",
      "⚙ オプション: --debug",
    );
    await answerPrompt("exit");
    await replPromise;

    const allCalls = stderrSpy.mock.calls.map((c) => String(c[0]));
    // ウェルカムメッセージの後にオプション行がある
    const welcomeIdx = allCalls.findIndex((s) => s.includes("AI CLI"));
    const optionsIdx = allCalls.findIndex((s) => s.includes("⚙ オプション: --debug"));
    expect(welcomeIdx).toBeGreaterThanOrEqual(0);
    expect(optionsIdx).toBeGreaterThan(welcomeIdx);

    stderrSpy.mockRestore();
  });
});
