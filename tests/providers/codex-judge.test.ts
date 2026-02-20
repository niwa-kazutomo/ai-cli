import { describe, it, expect, vi, beforeEach } from "vitest";
import { CodexJudge } from "../../src/providers/codex-judge.js";

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

describe("CodexJudge", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("codex exec --sandbox read-only --json で実行される", async () => {
    const jsonl = JSON.stringify({
      type: "item.completed",
      item: { id: "item_1", type: "agent_message", text: "### 概要\n問題なし\n\n### 懸念事項\n懸念事項なし" },
    });
    mockRunCli.mockResolvedValue({
      exitCode: 0,
      stdout: jsonl,
      stderr: "",
    });

    const judge = new CodexJudge({ cwd: "/tmp" });
    await judge.judgeReview("review output");

    expect(mockRunCli).toHaveBeenCalledWith(
      "codex",
      expect.objectContaining({
        args: expect.arrayContaining(["exec", "--sandbox", "read-only", "--json"]),
      }),
    );
  });

  it("--model が渡される", async () => {
    const jsonl = JSON.stringify({
      type: "item.completed",
      item: { id: "item_1", type: "agent_message", text: "懸念事項なし" },
    });
    mockRunCli.mockResolvedValue({
      exitCode: 0,
      stdout: jsonl,
      stderr: "",
    });

    const judge = new CodexJudge({ cwd: "/tmp", model: "o3" });
    await judge.judgeReview("review output");

    const callArgs = mockRunCli.mock.calls[0][1].args as string[];
    expect(callArgs).toContain("--model");
    expect(callArgs).toContain("o3");
  });

  it("マーカーあり（P2+P4）を正常パースする", async () => {
    const jsonl = JSON.stringify({
      type: "item.completed",
      item: { id: "item_1", type: "agent_message", text: "### 概要\nレビュー要約\n\n### 懸念事項\n- [P2] 設計上の問題\n- [P4] スタイルの問題" },
    });
    mockRunCli.mockResolvedValue({
      exitCode: 0,
      stdout: jsonl,
      stderr: "",
    });

    const judge = new CodexJudge({ cwd: "/tmp" });
    const result = await judge.judgeReview("review output");

    expect(result.concerns).toHaveLength(2);
    expect(result.concerns[0].severity).toBe("P2");
    expect(result.concerns[1].severity).toBe("P4");
    expect(result.has_p3_plus_concerns).toBe(true);
    expect(result.questions_for_user).toEqual([]);
  });

  it("マーカーなし + 裸トークン P1 あり → fail-safe", async () => {
    const jsonl = JSON.stringify({
      type: "item.completed",
      item: { id: "item_1", type: "agent_message", text: "P1レベルの脆弱性があります" },
    });
    mockRunCli.mockResolvedValue({
      exitCode: 0,
      stdout: jsonl,
      stderr: "",
    });

    const judge = new CodexJudge({ cwd: "/tmp" });
    const result = await judge.judgeReview("review output");

    expect(result.has_p3_plus_concerns).toBe(true);
    expect(result.concerns[0].severity).toBe("P0");
    expect(result.concerns[0].description).toContain("判定不能");
  });

  it("マーカーなし + 裸トークンなし + 「懸念事項なし」→ PASS", async () => {
    const jsonl = JSON.stringify({
      type: "item.completed",
      item: { id: "item_1", type: "agent_message", text: "### 概要\n問題なし\n\n### 懸念事項\n懸念事項なし" },
    });
    mockRunCli.mockResolvedValue({
      exitCode: 0,
      stdout: jsonl,
      stderr: "",
    });

    const judge = new CodexJudge({ cwd: "/tmp" });
    const result = await judge.judgeReview("review output");

    expect(result.concerns).toEqual([]);
    expect(result.has_p3_plus_concerns).toBe(false);
  });

  it("マーカーなし + 裸トークンなし + テキストあり → PASS", async () => {
    const jsonl = JSON.stringify({
      type: "item.completed",
      item: { id: "item_1", type: "agent_message", text: "特に問題ありません" },
    });
    mockRunCli.mockResolvedValue({
      exitCode: 0,
      stdout: jsonl,
      stderr: "",
    });

    const judge = new CodexJudge({ cwd: "/tmp" });
    const result = await judge.judgeReview("review output");

    expect(result.concerns).toEqual([]);
    expect(result.has_p3_plus_concerns).toBe(false);
  });

  it("agent_message なし（turn.completed のみ）→ fail-safe", async () => {
    mockRunCli.mockResolvedValue({
      exitCode: 0,
      stdout: JSON.stringify({ type: "turn.completed", usage: {} }),
      stderr: "",
    });

    const judge = new CodexJudge({ cwd: "/tmp" });
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

    const judge = new CodexJudge({ cwd: "/tmp" });
    const result = await judge.judgeReview("review output");

    expect(result.has_p3_plus_concerns).toBe(true);
    expect(result.concerns[0].severity).toBe("P0");
  });

  it("runCli 例外 → fail-safe", async () => {
    mockRunCli.mockRejectedValue(new Error("connection failed"));

    const judge = new CodexJudge({ cwd: "/tmp" });
    const result = await judge.judgeReview("review output");

    expect(result.has_p3_plus_concerns).toBe(true);
    expect(result.concerns[0].severity).toBe("P0");
  });

  it("レビュー不能インジケータ → fail-safe", async () => {
    const jsonl = JSON.stringify({
      type: "item.completed",
      item: { id: "item_1", type: "agent_message", text: "レビュー対象が含まれておらず、レビューを実施できません。" },
    });
    mockRunCli.mockResolvedValue({
      exitCode: 0,
      stdout: jsonl,
      stderr: "",
    });

    const judge = new CodexJudge({ cwd: "/tmp" });
    const result = await judge.judgeReview("review output");

    expect(result.has_p3_plus_concerns).toBe(true);
    expect(result.concerns[0].severity).toBe("P0");
  });

  it("onStdout/onStderr を受け取り runCli に伝搬する", async () => {
    const jsonl = JSON.stringify({
      type: "item.completed",
      item: { id: "item_1", type: "agent_message", text: "懸念事項なし" },
    });
    mockRunCli.mockResolvedValue({
      exitCode: 0,
      stdout: jsonl,
      stderr: "",
    });

    const onStdout = vi.fn();
    const onStderr = vi.fn();
    const judge = new CodexJudge({ cwd: "/tmp", onStdout, onStderr });
    await judge.judgeReview("review output");

    expect(mockRunCli).toHaveBeenCalledWith(
      "codex",
      expect.objectContaining({ onStdout, onStderr }),
    );
  });
});
