import { describe, it, expect, vi, beforeEach } from "vitest";
import { SigintError } from "../src/errors.js";

vi.mock("../src/orchestrator.js", () => ({
  runWorkflow: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../src/repl.js", () => ({
  startRepl: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../src/logger.js", () => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  verbose: vi.fn(),
  debug: vi.fn(),
  configureLogger: vi.fn(),
}));

vi.mock("../src/user-interaction.js", () => ({
  display: vi.fn(),
}));

import { createProgram, formatActiveOptions } from "../src/index.js";
import { runWorkflow } from "../src/orchestrator.js";
import { startRepl } from "../src/repl.js";
import { display } from "../src/user-interaction.js";
import {
  DEFAULT_MAX_PLAN_ITERATIONS,
  DEFAULT_MAX_CODE_ITERATIONS,
} from "../src/constants.js";
import type { ReplOptions } from "../src/types.js";

const mockRunWorkflow = vi.mocked(runWorkflow);
const mockStartRepl = vi.mocked(startRepl);
const mockDisplay = vi.mocked(display);

describe("createProgram CLI routing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("ai plan 'prompt' → runWorkflow を呼ぶ（シングルショット）", async () => {
    const program = createProgram();
    await program.parseAsync(["plan", "テストプロンプト"], { from: "user" });

    expect(mockRunWorkflow).toHaveBeenCalledTimes(1);
    expect(mockRunWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: "テストプロンプト" }),
    );
    expect(mockStartRepl).not.toHaveBeenCalled();
  });

  it("ai plan → startRepl を呼ぶ（REPL）", async () => {
    const program = createProgram();
    await program.parseAsync(["plan"], { from: "user" });

    expect(mockStartRepl).toHaveBeenCalledTimes(1);
    expect(mockStartRepl).toHaveBeenCalledWith(
      expect.any(Object),
      expect.any(String),
      null,
    );
    expect(mockRunWorkflow).not.toHaveBeenCalled();
  });

  it("ai（引数なし）→ startRepl を呼ぶ", async () => {
    const program = createProgram();
    await program.parseAsync([], { from: "user" });

    expect(mockStartRepl).toHaveBeenCalledTimes(1);
    expect(mockStartRepl).toHaveBeenCalledWith(
      expect.any(Object),
      expect.any(String),
      null,
    );
    expect(mockRunWorkflow).not.toHaveBeenCalled();
  });

  it("ai --verbose → startRepl を verbose: true で呼ぶ", async () => {
    const program = createProgram();
    await program.parseAsync(["--verbose"], { from: "user" });

    expect(mockStartRepl).toHaveBeenCalledTimes(1);
    expect(mockStartRepl).toHaveBeenCalledWith(
      expect.objectContaining({ verbose: true }),
      expect.any(String),
      expect.any(String),
    );
    expect(mockRunWorkflow).not.toHaveBeenCalled();
  });

  it("ai plan --verbose 'prompt' → runWorkflow を verbose: true で呼ぶ", async () => {
    const program = createProgram();
    await program.parseAsync(["plan", "--verbose", "テスト"], { from: "user" });

    expect(mockRunWorkflow).toHaveBeenCalledTimes(1);
    expect(mockRunWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: "テスト", verbose: true }),
    );
  });

  it("ai plan --dangerous → startRepl を dangerous: true で呼ぶ", async () => {
    const program = createProgram();
    await program.parseAsync(["plan", "--dangerous"], { from: "user" });

    expect(mockStartRepl).toHaveBeenCalledTimes(1);
    expect(mockStartRepl).toHaveBeenCalledWith(
      expect.objectContaining({ dangerous: true }),
      expect.any(String),
      expect.any(String),
    );
  });

  it("シングルショットで SigintError → exit 130", async () => {
    mockRunWorkflow.mockRejectedValue(new SigintError());

    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit called");
    }) as never);

    const program = createProgram();
    await expect(
      program.parseAsync(["plan", "テスト"], { from: "user" }),
    ).rejects.toThrow("process.exit");

    expect(exitSpy).toHaveBeenCalledWith(130);
    exitSpy.mockRestore();
  });

  it("シングルショットで通常エラー → exit 1", async () => {
    mockRunWorkflow.mockRejectedValue(new Error("何かのエラー"));

    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit called");
    }) as never);

    const program = createProgram();
    await expect(
      program.parseAsync(["plan", "テスト"], { from: "user" }),
    ).rejects.toThrow("process.exit");

    expect(exitSpy).toHaveBeenCalledWith(1);
    exitSpy.mockRestore();
  });

  it("シングルショットでオプション指定あり → display が呼ばれる", async () => {
    mockRunWorkflow.mockResolvedValue(undefined);
    const program = createProgram();
    await program.parseAsync(["plan", "--debug", "テスト"], { from: "user" });

    expect(mockDisplay).toHaveBeenCalledWith(
      expect.stringContaining("⚙ オプション"),
    );
  });

  it("シングルショットでオプション未指定 → display が呼ばれない", async () => {
    mockRunWorkflow.mockResolvedValue(undefined);
    const program = createProgram();
    await program.parseAsync(["plan", "テスト"], { from: "user" });

    expect(mockDisplay).not.toHaveBeenCalled();
  });
});

describe("formatActiveOptions", () => {
  const baseOptions: ReplOptions = {
    maxPlanIterations: DEFAULT_MAX_PLAN_ITERATIONS,
    maxCodeIterations: DEFAULT_MAX_CODE_ITERATIONS,
    dangerous: false,
    verbose: false,
    debug: false,
    cwd: process.cwd(),
  };

  it("オプション未指定 → null を返す", () => {
    expect(formatActiveOptions(baseOptions)).toBeNull();
  });

  it("--debug 指定 → ⚙ オプション: --debug", () => {
    const result = formatActiveOptions({ ...baseOptions, debug: true });
    expect(result).toBe("⚙ オプション: --debug");
  });

  it("--verbose --dangerous 指定 → 順序固定で表示", () => {
    const result = formatActiveOptions({
      ...baseOptions,
      verbose: true,
      dangerous: true,
    });
    expect(result).toBe("⚙ オプション: --verbose --dangerous");
  });

  it("--claude-model で特殊文字を含む値 → JSON.stringify でエスケープ", () => {
    const result = formatActiveOptions({
      ...baseOptions,
      claudeModel: 'some"model\\x',
    });
    expect(result).toBe('⚙ オプション: --claude-model "some\\"model\\\\x"');
  });

  it("--cwd で空白を含むパス → クォートされる", () => {
    const result = formatActiveOptions({
      ...baseOptions,
      cwd: "/path/with space",
    });
    expect(result).toBe('⚙ オプション: --cwd "/path/with space"');
  });

  it("--max-plan-iterations がデフォルト以外 → 表示される", () => {
    const result = formatActiveOptions({
      ...baseOptions,
      maxPlanIterations: 3,
    });
    expect(result).toBe("⚙ オプション: --max-plan-iterations 3");
  });

  it("--max-plan-iterations がデフォルト値 → null を返す", () => {
    const result = formatActiveOptions({
      ...baseOptions,
      maxPlanIterations: DEFAULT_MAX_PLAN_ITERATIONS,
    });
    expect(result).toBeNull();
  });

  it("--cwd が process.cwd() と同値 → null を返す", () => {
    const result = formatActiveOptions({
      ...baseOptions,
      cwd: process.cwd(),
    });
    expect(result).toBeNull();
  });

  it("--max-plan-iterations が NaN → NaN と表示される（不正値が見える）", () => {
    const result = formatActiveOptions({
      ...baseOptions,
      maxPlanIterations: NaN,
    });
    expect(result).toBe("⚙ オプション: --max-plan-iterations NaN");
  });

  it("--codex-model 指定 → クォートされて表示される", () => {
    const result = formatActiveOptions({
      ...baseOptions,
      codexModel: "gpt-4o",
    });
    expect(result).toBe('⚙ オプション: --codex-model "gpt-4o"');
  });

  it("--max-code-iterations がデフォルト以外 → 表示される", () => {
    const result = formatActiveOptions({
      ...baseOptions,
      maxCodeIterations: 10,
    });
    expect(result).toBe("⚙ オプション: --max-code-iterations 10");
  });

  it("--max-code-iterations がデフォルト値 → null を返す", () => {
    const result = formatActiveOptions({
      ...baseOptions,
      maxCodeIterations: DEFAULT_MAX_CODE_ITERATIONS,
    });
    expect(result).toBeNull();
  });
});
