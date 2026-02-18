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

import { createProgram } from "../src/index.js";
import { runWorkflow } from "../src/orchestrator.js";
import { startRepl } from "../src/repl.js";

const mockRunWorkflow = vi.mocked(runWorkflow);
const mockStartRepl = vi.mocked(startRepl);

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
    expect(mockRunWorkflow).not.toHaveBeenCalled();
  });

  it("ai（引数なし）→ startRepl を呼ぶ", async () => {
    const program = createProgram();
    await program.parseAsync([], { from: "user" });

    expect(mockStartRepl).toHaveBeenCalledTimes(1);
    expect(mockRunWorkflow).not.toHaveBeenCalled();
  });

  it("ai --verbose → startRepl を verbose: true で呼ぶ", async () => {
    const program = createProgram();
    await program.parseAsync(["--verbose"], { from: "user" });

    expect(mockStartRepl).toHaveBeenCalledTimes(1);
    expect(mockStartRepl).toHaveBeenCalledWith(
      expect.objectContaining({ verbose: true }),
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
});
