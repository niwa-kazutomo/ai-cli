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

const mockReadFileSync = vi.fn();
const mockWriteFileSync = vi.fn();
const mockChmodSync = vi.fn();
vi.mock("node:fs", () => ({
  readFileSync: (...args: unknown[]) => mockReadFileSync(...args),
  writeFileSync: (...args: unknown[]) => mockWriteFileSync(...args),
  chmodSync: (...args: unknown[]) => mockChmodSync(...args),
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
let lastCreateInterfaceOptions: Record<string, unknown> = {};

vi.mock("node:readline", () => ({
  createInterface: vi.fn((opts: Record<string, unknown>) => {
    lastCreateInterfaceOptions = opts;
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
  const DUMMY_HISTORY_FILE = "/tmp/test_ai_cli_history";

  beforeEach(() => {
    vi.clearAllMocks();
    questionCallbacks = [];
    closeListeners = [];
    sigintListeners = [];
    lastCreateInterfaceOptions = {};
    mockRunWorkflow.mockResolvedValue(undefined);
    // デフォルト: ヒストリーファイルなし
    mockReadFileSync.mockImplementation(() => { throw new Error("ENOENT"); });
    mockWriteFileSync.mockImplementation(() => {});
    mockChmodSync.mockImplementation(() => {});
  });

  it("1回の入力後 exit で runWorkflow が1回呼ばれる", async () => {
    const replPromise = startRepl(defaultReplOptions, "0.1.0", undefined, DUMMY_HISTORY_FILE);

    await answerPrompt("テストプロンプト");
    await answerPrompt("exit");

    await replPromise;

    expect(mockRunWorkflow).toHaveBeenCalledTimes(1);
    expect(mockRunWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: "テストプロンプト" }),
    );
  });

  it("quit で終了する", async () => {
    const replPromise = startRepl(defaultReplOptions, "0.1.0", undefined, DUMMY_HISTORY_FILE);

    await answerPrompt("quit");

    await replPromise;

    expect(mockRunWorkflow).not.toHaveBeenCalled();
  });

  it("空入力は runWorkflow を呼ばない", async () => {
    const replPromise = startRepl(defaultReplOptions, "0.1.0", undefined, DUMMY_HISTORY_FILE);

    await answerPrompt("");
    await answerPrompt("   "); // 空白のみ
    await answerPrompt("exit");

    await replPromise;

    expect(mockRunWorkflow).not.toHaveBeenCalled();
  });

  it("複数プロンプトで runWorkflow が複数回呼ばれる", async () => {
    const replPromise = startRepl(defaultReplOptions, "0.1.0", undefined, DUMMY_HISTORY_FILE);

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

    const replPromise = startRepl(defaultReplOptions, "0.1.0", undefined, DUMMY_HISTORY_FILE);

    await answerPrompt("エラーになるプロンプト");
    await answerPrompt("正常なプロンプト");
    await answerPrompt("exit");

    await replPromise;

    expect(mockRunWorkflow).toHaveBeenCalledTimes(2);
  });

  it("EOF (Ctrl+D) で正常終了する", async () => {
    const replPromise = startRepl(defaultReplOptions, "0.1.0", undefined, DUMMY_HISTORY_FILE);

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

    const replPromise = startRepl(customOptions, "0.1.0", undefined, DUMMY_HISTORY_FILE);

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
    const replPromise = startRepl(defaultReplOptions, "0.1.0", undefined, DUMMY_HISTORY_FILE);

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

    const replPromise = startRepl(defaultReplOptions, "0.1.0", undefined, DUMMY_HISTORY_FILE);

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

    const replPromise = startRepl(defaultReplOptions, "0.1.0", undefined, DUMMY_HISTORY_FILE);
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
      DUMMY_HISTORY_FILE,
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

  // ── ヒストリー機能テスト ──

  it("createInterface に history コピーが渡される", async () => {
    mockReadFileSync.mockReturnValue("previous1\nprevious2\n");

    const capturedHistories: unknown[] = [];
    const { createInterface } = await import("node:readline");
    const mockCreateInterface = vi.mocked(createInterface);
    mockCreateInterface.mockImplementation(((opts: Record<string, unknown>) => {
      lastCreateInterfaceOptions = opts;
      capturedHistories.push(opts.history);
      mockRlInstance = {
        question: vi.fn((_prompt: string, cb: (answer: string) => void) => {
          questionCallbacks.push(cb);
        }),
        close: vi.fn(),
        on: vi.fn((event: string, cb: () => void) => {
          if (event === "close") closeListeners.push(cb);
          if (event === "SIGINT") sigintListeners.push(cb);
        }),
        removeListener: vi.fn(),
      };
      return mockRlInstance;
    }) as unknown as typeof createInterface);

    const replPromise = startRepl(defaultReplOptions, "0.1.0", undefined, DUMMY_HISTORY_FILE);

    await answerPrompt("new input");
    await answerPrompt("exit");
    await replPromise;

    // 最初の呼び出しでファイルから読み込んだ履歴が渡されること
    expect(capturedHistories[0]).toEqual(["previous1", "previous2"]);
    // 2回目は新しい入力が追加された履歴が渡されること
    expect(capturedHistories[1]).toEqual(["new input", "previous1", "previous2"]);
    // 各呼び出しで異なる配列参照（コピー）であること
    expect(capturedHistories[0]).not.toBe(capturedHistories[1]);
  });

  it("入力後にヒストリーファイルが保存される", async () => {
    const replPromise = startRepl(defaultReplOptions, "0.1.0", undefined, DUMMY_HISTORY_FILE);

    await answerPrompt("hello world");
    await answerPrompt("exit");
    await replPromise;

    expect(mockWriteFileSync).toHaveBeenCalledWith(
      DUMMY_HISTORY_FILE,
      "hello world\n",
      { mode: 0o600 },
    );
    expect(mockChmodSync).toHaveBeenCalledWith(DUMMY_HISTORY_FILE, 0o600);
  });

  it("exit はヒストリーに保存されない", async () => {
    const replPromise = startRepl(defaultReplOptions, "0.1.0", undefined, DUMMY_HISTORY_FILE);

    await answerPrompt("exit");
    await replPromise;

    expect(mockWriteFileSync).not.toHaveBeenCalled();
  });

  it("quit はヒストリーに保存されない", async () => {
    const replPromise = startRepl(defaultReplOptions, "0.1.0", undefined, DUMMY_HISTORY_FILE);

    await answerPrompt("quit");
    await replPromise;

    expect(mockWriteFileSync).not.toHaveBeenCalled();
  });

  it("連続重複は保存されない", async () => {
    const replPromise = startRepl(defaultReplOptions, "0.1.0", undefined, DUMMY_HISTORY_FILE);

    await answerPrompt("same input");
    await answerPrompt("same input");
    await answerPrompt("exit");
    await replPromise;

    // writeFileSync は2回呼ばれるが、内容は両方とも "same input\n"（1エントリのみ）
    expect(mockWriteFileSync).toHaveBeenCalledTimes(2);
    expect(mockWriteFileSync).toHaveBeenLastCalledWith(
      DUMMY_HISTORY_FILE,
      "same input\n",
      { mode: 0o600 },
    );
  });

  it("ファイル読み込み失敗時に空配列で継続する", async () => {
    mockReadFileSync.mockImplementation(() => { throw new Error("ENOENT"); });

    const replPromise = startRepl(defaultReplOptions, "0.1.0", undefined, DUMMY_HISTORY_FILE);

    await answerPrompt("テスト");
    await answerPrompt("exit");
    await replPromise;

    // REPL が正常に動作すること
    expect(mockRunWorkflow).toHaveBeenCalledTimes(1);
  });

  it("読み込み時に各行が trim されて正規化される", async () => {
    mockReadFileSync.mockReturnValue("  padded  \n\ttabbed\t\n  \n normal\n");

    const replPromise = startRepl(defaultReplOptions, "0.1.0", undefined, DUMMY_HISTORY_FILE);
    await answerPrompt("exit");
    await replPromise;

    // createInterface に渡された history が trim 済みで空行が除去されていること
    const passedHistory = lastCreateInterfaceOptions.history as string[];
    expect(passedHistory).toEqual(["padded", "tabbed", "normal"]);
  });

  it("ヒストリーが上限500件に制限される", async () => {
    // 600 行のヒストリーファイルを用意
    const lines = Array.from({ length: 600 }, (_, i) => `entry${i}`);
    mockReadFileSync.mockReturnValue(lines.join("\n") + "\n");

    const replPromise = startRepl(defaultReplOptions, "0.1.0", undefined, DUMMY_HISTORY_FILE);
    await answerPrompt("exit");
    await replPromise;

    // loadHistory で 500 件に切り詰められること
    const passedHistory = lastCreateInterfaceOptions.history as string[];
    expect(passedHistory).toHaveLength(500);
    expect(passedHistory[0]).toBe("entry0");
    expect(passedHistory[499]).toBe("entry499");
  });

  it("ヒストリー追加時に上限500件を超えると古い履歴が削除される", async () => {
    // ちょうど 500 件のヒストリーを用意
    const lines = Array.from({ length: 500 }, (_, i) => `old${i}`);
    mockReadFileSync.mockReturnValue(lines.join("\n") + "\n");

    const replPromise = startRepl(defaultReplOptions, "0.1.0", undefined, DUMMY_HISTORY_FILE);
    await answerPrompt("new entry");
    await answerPrompt("exit");
    await replPromise;

    // saveHistory で書き込まれた内容を検証
    const writtenContent = mockWriteFileSync.mock.calls[0][1] as string;
    const writtenLines = writtenContent.split("\n").filter((s: string) => s.length > 0);
    expect(writtenLines).toHaveLength(500);
    expect(writtenLines[0]).toBe("new entry");
    // 最後の古い履歴 (old499) が押し出されていること
    expect(writtenLines).not.toContain("old499");
    expect(writtenLines[499]).toBe("old498");
  });

  it("ファイル書き込み失敗時にも REPL が継続する", async () => {
    mockWriteFileSync.mockImplementation(() => { throw new Error("EACCES"); });

    const replPromise = startRepl(defaultReplOptions, "0.1.0", undefined, DUMMY_HISTORY_FILE);

    await answerPrompt("1つ目");
    await answerPrompt("2つ目");
    await answerPrompt("exit");
    await replPromise;

    // 書き込み失敗しても REPL が中断しないこと
    expect(mockRunWorkflow).toHaveBeenCalledTimes(2);
  });
});
