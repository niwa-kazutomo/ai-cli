import { describe, it, expect, vi, beforeEach } from "vitest";
import { ClaudeCodeJudge } from "../../src/providers/claude-code-judge.js";

vi.mock("../../src/cli-runner.js", () => ({
  runCli: vi.fn(),
}));

vi.mock("../../src/logger.js", () => ({
  error: vi.fn(),
  warn: vi.fn(),
  verbose: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
}));

import { runCli } from "../../src/cli-runner.js";
const mockRunCli = vi.mocked(runCli);

describe("ClaudeCodeJudge", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("マーカーあり（P2+P4）を正常パースする", async () => {
    mockRunCli.mockResolvedValue({
      exitCode: 0,
      stdout: "### 概要\nレビュー要約\n\n### 懸念事項\n- [P2] 設計上の問題\n- [P4] スタイルの問題",
      stderr: "",
    });

    const judge = new ClaudeCodeJudge({ cwd: "/tmp" });
    const result = await judge.judgeReview("review output");

    expect(result.concerns).toHaveLength(2);
    expect(result.concerns[0].severity).toBe("P2");
    expect(result.concerns[1].severity).toBe("P4");
    expect(result.has_p3_plus_concerns).toBe(true);
    expect(result.questions_for_user).toEqual([]);
  });

  it("onStderr を受け取り runCli に伝搬する", async () => {
    mockRunCli.mockResolvedValue({
      exitCode: 0,
      stdout: "### 概要\n問題なし\n\n### 懸念事項\n懸念事項なし",
      stderr: "",
    });

    const onStderr = vi.fn();
    const judge = new ClaudeCodeJudge({ cwd: "/tmp", onStderr });
    await judge.judgeReview("review output");

    expect(mockRunCli).toHaveBeenCalledWith(
      "claude",
      expect.objectContaining({ onStderr }),
    );
  });

  it("onStdout を受け取り runCli に伝搬する", async () => {
    mockRunCli.mockResolvedValue({
      exitCode: 0,
      stdout: "### 概要\n問題なし\n\n### 懸念事項\n懸念事項なし",
      stderr: "",
    });

    const onStdout = vi.fn();
    const judge = new ClaudeCodeJudge({ cwd: "/tmp", onStdout });
    await judge.judgeReview("review output");

    expect(mockRunCli).toHaveBeenCalledWith(
      "claude",
      expect.objectContaining({ onStdout }),
    );
  });

  it("マーカーなし + 裸トークン P1 あり → fail-safe", async () => {
    mockRunCli.mockResolvedValue({
      exitCode: 0,
      stdout: "P1レベルの脆弱性があります",
      stderr: "",
    });

    const judge = new ClaudeCodeJudge({ cwd: "/tmp" });
    const result = await judge.judgeReview("review output");

    expect(result.has_p3_plus_concerns).toBe(true);
    expect(result.concerns[0].severity).toBe("P0");
    expect(result.concerns[0].description).toContain("判定不能");
  });

  it("矛盾出力: 「懸念事項なし」+ 裸トークン P1 → fail-safe（裸トークンが勝つ）", async () => {
    mockRunCli.mockResolvedValue({
      exitCode: 0,
      stdout: "懸念事項なし\nP1レベルの脆弱性あり",
      stderr: "",
    });

    const judge = new ClaudeCodeJudge({ cwd: "/tmp" });
    const result = await judge.judgeReview("review output");

    expect(result.has_p3_plus_concerns).toBe(true);
    expect(result.concerns[0].severity).toBe("P0");
  });

  it("マーカーなし + 裸トークンなし + 「懸念事項なし」→ PASS", async () => {
    mockRunCli.mockResolvedValue({
      exitCode: 0,
      stdout: "### 概要\n問題なし\n\n### 懸念事項\n懸念事項なし",
      stderr: "",
    });

    const judge = new ClaudeCodeJudge({ cwd: "/tmp" });
    const result = await judge.judgeReview("review output");

    expect(result.concerns).toEqual([]);
    expect(result.has_p3_plus_concerns).toBe(false);
  });

  it("マーカーなし + 裸トークンなし + テキストあり → PASS", async () => {
    mockRunCli.mockResolvedValue({
      exitCode: 0,
      stdout: "特に問題ありません",
      stderr: "",
    });

    const judge = new ClaudeCodeJudge({ cwd: "/tmp" });
    const result = await judge.judgeReview("review output");

    expect(result.concerns).toEqual([]);
    expect(result.has_p3_plus_concerns).toBe(false);
  });

  it("stdout 空 → fail-safe", async () => {
    mockRunCli.mockResolvedValue({
      exitCode: 0,
      stdout: "",
      stderr: "",
    });

    const judge = new ClaudeCodeJudge({ cwd: "/tmp" });
    const result = await judge.judgeReview("review output");

    expect(result.has_p3_plus_concerns).toBe(true);
    expect(result.concerns[0].severity).toBe("P0");
  });

  it("非ゼロ終了 → fail-safe", async () => {
    mockRunCli.mockResolvedValue({
      exitCode: 1,
      stdout: "",
      stderr: "error",
    });

    const judge = new ClaudeCodeJudge({ cwd: "/tmp" });
    const result = await judge.judgeReview("review output");

    expect(result.has_p3_plus_concerns).toBe(true);
    expect(result.concerns[0].severity).toBe("P0");
  });

  it("runCli 例外 → fail-safe", async () => {
    mockRunCli.mockRejectedValue(new Error("connection failed"));

    const judge = new ClaudeCodeJudge({ cwd: "/tmp" });
    const result = await judge.judgeReview("review output");

    expect(result.has_p3_plus_concerns).toBe(true);
    expect(result.concerns[0].severity).toBe("P0");
  });

  it("レビュー不能インジケータ → fail-safe", async () => {
    mockRunCli.mockResolvedValue({
      exitCode: 0,
      stdout: "レビュー対象が含まれておらず、レビューを実施できません。",
      stderr: "",
    });

    const judge = new ClaudeCodeJudge({ cwd: "/tmp" });
    const result = await judge.judgeReview("review output");

    expect(result.has_p3_plus_concerns).toBe(true);
    expect(result.concerns[0].severity).toBe("P0");
  });

  it("「懸念事項なし」+「レビュー不能」混在時に fail-safe になる", async () => {
    mockRunCli.mockResolvedValue({
      exitCode: 0,
      stdout: "懸念事項なし\nレビュー対象がありません",
      stderr: "",
    });

    const judge = new ClaudeCodeJudge({ cwd: "/tmp" });
    const result = await judge.judgeReview("review output");

    expect(result.has_p3_plus_concerns).toBe(true);
    expect(result.concerns[0].severity).toBe("P0");
  });
});
