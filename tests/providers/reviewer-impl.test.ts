import { describe, it, expect, vi, beforeEach } from "vitest";
import { ReviewerImpl } from "../../src/providers/reviewer-impl.js";
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

describe("ReviewerImpl reviewPlan セッション管理", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("初回 reviewPlan で resumeSessionId が null", async () => {
    const run = vi.fn().mockResolvedValue(makeResult({ sessionId: "sess-1" }));
    const backend = createMockBackend(run);
    const reviewer = new ReviewerImpl(backend);

    await reviewer.reviewPlan("test");

    expect(run.mock.calls[0][0].resumeSessionId).toBeNull();
  });

  it("初回レスポンスから session_id を保存し、2回目で resumeSessionId を渡す", async () => {
    const run = vi.fn()
      .mockResolvedValueOnce(makeResult({ sessionId: "sess-abc" }))
      .mockResolvedValueOnce(makeResult({ response: "second review" }));
    const backend = createMockBackend(run);
    const reviewer = new ReviewerImpl(backend);

    await reviewer.reviewPlan("first");
    await reviewer.reviewPlan("second");

    expect(run.mock.calls[1][0].resumeSessionId).toBe("sess-abc");
  });

  it("session_id 抽出失敗時に fallbackContext で buildSummaryContext を使用する", async () => {
    const run = vi.fn()
      .mockResolvedValueOnce(makeResult({ sessionId: null }))
      .mockResolvedValueOnce(makeResult({ response: "second review" }));
    const backend = createMockBackend(run);
    const reviewer = new ReviewerImpl(backend);

    await reviewer.reviewPlan("first");
    await reviewer.reviewPlan("second", {
      planSummary: "plan summary",
      reviewSummary: "review summary",
    });

    // prompt に fallbackContext が含まれる
    const prompt = run.mock.calls[1][0].prompt;
    expect(prompt).toContain("計画の要約");
    expect(prompt).toContain("plan summary");
    expect(prompt).toContain("レビューの要約");
    expect(prompt).toContain("review summary");
  });

  it("exit code 非ゼロ時にエラーを投げる", async () => {
    const run = vi.fn().mockResolvedValue(makeResult({
      raw: { exitCode: 1, stdout: "", stderr: "error" },
    }));
    const backend = createMockBackend(run);
    const reviewer = new ReviewerImpl(backend);

    await expect(reviewer.reviewPlan("test")).rejects.toThrow("プランレビューが失敗しました");
  });

  it("reviewPlan で operation が 'reviewPlan' になる", async () => {
    const run = vi.fn().mockResolvedValue(makeResult({ sessionId: "s" }));
    const backend = createMockBackend(run);
    const reviewer = new ReviewerImpl(backend);

    await reviewer.reviewPlan("test");

    expect(run.mock.calls[0][0].hints.operation).toBe("reviewPlan");
  });
});

describe("ReviewerImpl reviewCode セッション管理", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("初回 reviewCode で resumeSessionId が null", async () => {
    const run = vi.fn().mockResolvedValue(makeResult({ response: "code review" }));
    const backend = createMockBackend(run);
    const reviewer = new ReviewerImpl(backend);

    await reviewer.reviewCode("test");

    expect(run.mock.calls[0][0].resumeSessionId).toBeNull();
  });

  it("reviewCode で exit code 非ゼロ時にエラーを投げる", async () => {
    const run = vi.fn().mockResolvedValue(makeResult({
      raw: { exitCode: 1, stdout: "", stderr: "error" },
    }));
    const backend = createMockBackend(run);
    const reviewer = new ReviewerImpl(backend);

    await expect(reviewer.reviewCode("test")).rejects.toThrow("コードレビューが失敗しました");
  });

  it("2回目以降でセッション ID がある場合は resumeSessionId を使う", async () => {
    const run = vi.fn()
      .mockResolvedValueOnce(makeResult({ sessionId: "code-sess-1" }))
      .mockResolvedValueOnce(makeResult({ response: "second review" }));
    const backend = createMockBackend(run);
    const reviewer = new ReviewerImpl(backend);

    await reviewer.reviewCode("first");
    await reviewer.reviewCode("second", { diffSummary: "diff", reviewSummary: "review" });

    expect(run.mock.calls[1][0].resumeSessionId).toBe("code-sess-1");
  });

  it("セッション ID 抽出失敗時に fallbackContext を使用する", async () => {
    const run = vi.fn()
      .mockResolvedValueOnce(makeResult({ sessionId: null }))
      .mockResolvedValueOnce(makeResult({ response: "second review" }));
    const backend = createMockBackend(run);
    const reviewer = new ReviewerImpl(backend);

    await reviewer.reviewCode("first");
    await reviewer.reviewCode("second", {
      diffSummary: "diff summary",
      reviewSummary: "review summary",
    });

    const prompt = run.mock.calls[1][0].prompt;
    expect(prompt).toContain("前回の差分要約");
    expect(prompt).toContain("diff summary");
    expect(prompt).toContain("前回のレビュー要約");
    expect(prompt).toContain("review summary");
  });

  it("1回目抽出失敗→2回目抽出成功→3回目で resumeSessionId 使用", async () => {
    const run = vi.fn()
      .mockResolvedValueOnce(makeResult({ sessionId: null }))
      .mockResolvedValueOnce(makeResult({ sessionId: "code-sess-late" }))
      .mockResolvedValueOnce(makeResult({ response: "resumed" }));
    const backend = createMockBackend(run);
    const reviewer = new ReviewerImpl(backend);

    await reviewer.reviewCode("first");
    await reviewer.reviewCode("second", { diffSummary: "diff", reviewSummary: "review" });
    await reviewer.reviewCode("third", { diffSummary: "diff2", reviewSummary: "review2" });

    expect(run.mock.calls[2][0].resumeSessionId).toBe("code-sess-late");
  });

  it("reviewCode で sandboxMode が hints に反映される", async () => {
    const run = vi.fn().mockResolvedValue(makeResult({ response: "ok" }));
    const backend = createMockBackend(run);
    const reviewer = new ReviewerImpl(backend, { sandboxMode: "danger-full-access" });

    await reviewer.reviewCode("test");

    expect(run.mock.calls[0][0].hints.sandboxMode).toBe("danger-full-access");
  });

  it("reviewCode のデフォルト sandboxMode は workspace-write", async () => {
    const run = vi.fn().mockResolvedValue(makeResult({ response: "ok" }));
    const backend = createMockBackend(run);
    const reviewer = new ReviewerImpl(backend);

    await reviewer.reviewCode("test");

    expect(run.mock.calls[0][0].hints.sandboxMode).toBe("workspace-write");
  });
});

describe("ReviewerImpl デュアルセッション独立性", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("reviewPlan と reviewCode は独立したセッション ID を管理する", async () => {
    const run = vi.fn()
      .mockResolvedValueOnce(makeResult({ sessionId: "plan-sess" }))
      .mockResolvedValueOnce(makeResult({ sessionId: "code-sess" }))
      .mockResolvedValueOnce(makeResult({ response: "plan2" }))
      .mockResolvedValueOnce(makeResult({ response: "code2" }));
    const backend = createMockBackend(run);
    const reviewer = new ReviewerImpl(backend);

    await reviewer.reviewPlan("plan1");
    await reviewer.reviewCode("code1");
    await reviewer.reviewPlan("plan2");
    await reviewer.reviewCode("code2", { diffSummary: "d", reviewSummary: "r" });

    // 3回目: plan は plan-sess を使う
    expect(run.mock.calls[2][0].resumeSessionId).toBe("plan-sess");
    // 4回目: code は code-sess を使う
    expect(run.mock.calls[3][0].resumeSessionId).toBe("code-sess");
  });
});
