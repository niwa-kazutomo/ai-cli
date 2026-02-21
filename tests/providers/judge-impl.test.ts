import { describe, it, expect, vi, beforeEach } from "vitest";
import { JudgeImpl } from "../../src/providers/judge-impl.js";
import type { CliBackend, BackendRunResult } from "../../src/providers/backend.js";

vi.mock("../../src/logger.js", () => ({
  error: vi.fn(),
  warn: vi.fn(),
  verbose: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
}));

function createMockBackend(runFn?: CliBackend["run"]): CliBackend {
  return {
    run: runFn ?? vi.fn(),
  };
}

function makeResult(overrides: Partial<BackendRunResult> = {}): BackendRunResult {
  return {
    raw: { exitCode: 0, stdout: "", stderr: "" },
    response: "default response",
    sessionId: null,
    extractionSucceeded: true,
    ...overrides,
  };
}

describe("JudgeImpl", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("operation が 'judge' で hints に noSessionPersistence=true が含まれる", async () => {
    const run = vi.fn().mockResolvedValue(makeResult({
      response: "### 概要\n問題なし\n\n### 懸念事項\n懸念事項なし",
    }));
    const backend = createMockBackend(run);
    const judge = new JudgeImpl(backend);

    await judge.judgeReview("review output");

    expect(run.mock.calls[0][0].hints.operation).toBe("judge");
    expect(run.mock.calls[0][0].hints.noSessionPersistence).toBe(true);
    expect(run.mock.calls[0][0].resumeSessionId).toBeNull();
  });

  it("マーカーあり（P2+P4）を正常パースする", async () => {
    const run = vi.fn().mockResolvedValue(makeResult({
      response: "### 概要\nレビュー要約\n\n### 懸念事項\n- [P2] 設計上の問題\n- [P4] スタイルの問題",
    }));
    const backend = createMockBackend(run);
    const judge = new JudgeImpl(backend);

    const result = await judge.judgeReview("review output");

    expect(result.concerns).toHaveLength(2);
    expect(result.concerns[0].severity).toBe("P2");
    expect(result.concerns[1].severity).toBe("P4");
    expect(result.has_p3_plus_concerns).toBe(true);
    expect(result.questions_for_user).toEqual([]);
  });

  it("マーカーなし + 裸トークン P1 あり → fail-safe", async () => {
    const run = vi.fn().mockResolvedValue(makeResult({
      response: "P1レベルの脆弱性があります",
    }));
    const backend = createMockBackend(run);
    const judge = new JudgeImpl(backend);

    const result = await judge.judgeReview("review output");

    expect(result.has_p3_plus_concerns).toBe(true);
    expect(result.concerns[0].severity).toBe("P0");
    expect(result.concerns[0].description).toContain("判定不能");
  });

  it("矛盾出力: 「懸念事項なし」+ 裸トークン P1 → fail-safe（裸トークンが勝つ）", async () => {
    const run = vi.fn().mockResolvedValue(makeResult({
      response: "懸念事項なし\nP1レベルの脆弱性あり",
    }));
    const backend = createMockBackend(run);
    const judge = new JudgeImpl(backend);

    const result = await judge.judgeReview("review output");

    expect(result.has_p3_plus_concerns).toBe(true);
    expect(result.concerns[0].severity).toBe("P0");
  });

  it("マーカーなし + 裸トークンなし + 「懸念事項なし」→ PASS", async () => {
    const run = vi.fn().mockResolvedValue(makeResult({
      response: "### 概要\n問題なし\n\n### 懸念事項\n懸念事項なし",
    }));
    const backend = createMockBackend(run);
    const judge = new JudgeImpl(backend);

    const result = await judge.judgeReview("review output");

    expect(result.concerns).toEqual([]);
    expect(result.has_p3_plus_concerns).toBe(false);
  });

  it("マーカーなし + 裸トークンなし + テキストあり → PASS", async () => {
    const run = vi.fn().mockResolvedValue(makeResult({
      response: "特に問題ありません",
    }));
    const backend = createMockBackend(run);
    const judge = new JudgeImpl(backend);

    const result = await judge.judgeReview("review output");

    expect(result.concerns).toEqual([]);
    expect(result.has_p3_plus_concerns).toBe(false);
  });

  it("空レスポンス → fail-safe", async () => {
    const run = vi.fn().mockResolvedValue(makeResult({
      response: "",
    }));
    const backend = createMockBackend(run);
    const judge = new JudgeImpl(backend);

    const result = await judge.judgeReview("review output");

    expect(result.has_p3_plus_concerns).toBe(true);
    expect(result.concerns[0].severity).toBe("P0");
  });

  it("非ゼロ終了 → fail-safe", async () => {
    const run = vi.fn().mockResolvedValue(makeResult({
      raw: { exitCode: 1, stdout: "", stderr: "error" },
    }));
    const backend = createMockBackend(run);
    const judge = new JudgeImpl(backend);

    const result = await judge.judgeReview("review output");

    expect(result.has_p3_plus_concerns).toBe(true);
    expect(result.concerns[0].severity).toBe("P0");
  });

  it("backend.run() 例外 → fail-safe", async () => {
    const run = vi.fn().mockRejectedValue(new Error("connection failed"));
    const backend = createMockBackend(run);
    const judge = new JudgeImpl(backend);

    const result = await judge.judgeReview("review output");

    expect(result.has_p3_plus_concerns).toBe(true);
    expect(result.concerns[0].severity).toBe("P0");
  });

  it("extractionSucceeded=false → fail-safe", async () => {
    const run = vi.fn().mockResolvedValue(makeResult({
      extractionSucceeded: false,
      response: "raw stdout without agent_message",
    }));
    const backend = createMockBackend(run);
    const judge = new JudgeImpl(backend);

    const result = await judge.judgeReview("review output");

    expect(result.has_p3_plus_concerns).toBe(true);
    expect(result.concerns[0].severity).toBe("P0");
  });

  it("レビュー不能インジケータ → fail-safe", async () => {
    const run = vi.fn().mockResolvedValue(makeResult({
      response: "レビュー対象が含まれておらず、レビューを実施できません。",
    }));
    const backend = createMockBackend(run);
    const judge = new JudgeImpl(backend);

    const result = await judge.judgeReview("review output");

    expect(result.has_p3_plus_concerns).toBe(true);
    expect(result.concerns[0].severity).toBe("P0");
  });

  it("「懸念事項なし」+「レビュー不能」混在時に fail-safe になる", async () => {
    const run = vi.fn().mockResolvedValue(makeResult({
      response: "懸念事項なし\nレビュー対象がありません",
    }));
    const backend = createMockBackend(run);
    const judge = new JudgeImpl(backend);

    const result = await judge.judgeReview("review output");

    expect(result.has_p3_plus_concerns).toBe(true);
    expect(result.concerns[0].severity).toBe("P0");
  });
});
