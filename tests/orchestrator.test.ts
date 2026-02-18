import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock all external dependencies
vi.mock("../src/cli-runner.js", () => ({
  validateCapabilities: vi.fn().mockResolvedValue(null),
  runCli: vi.fn(),
}));

vi.mock("../src/claude-code.js", () => ({
  generatePlan: vi.fn(),
  generateCode: vi.fn(),
}));

vi.mock("../src/codex.js", () => ({
  reviewPlan: vi.fn(),
  reviewCode: vi.fn(),
  checkGitRepo: vi.fn().mockResolvedValue(true),
  checkGitChanges: vi.fn().mockResolvedValue(true),
}));

vi.mock("../src/review-judge.js", () => ({
  judgeReview: vi.fn(),
}));

vi.mock("../src/user-interaction.js", () => ({
  confirmYesNo: vi.fn(),
  askQuestions: vi.fn().mockResolvedValue(""),
  display: vi.fn(),
  displaySeparator: vi.fn(),
  startProgress: vi.fn().mockImplementation(() => ({ stop: vi.fn() })),
}));

vi.mock("../src/logger.js", () => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  verbose: vi.fn(),
  debug: vi.fn(),
  configureLogger: vi.fn(),
}));

import { runWorkflow } from "../src/orchestrator.js";
import * as claudeCode from "../src/claude-code.js";
import * as codex from "../src/codex.js";
import { judgeReview } from "../src/review-judge.js";
import * as ui from "../src/user-interaction.js";
import type { ReviewJudgment, OrchestratorOptions } from "../src/types.js";

const mockClaudeCode = vi.mocked(claudeCode);
const mockCodex = vi.mocked(codex);
const mockJudgeReview = vi.mocked(judgeReview);
const mockUi = vi.mocked(ui);

const defaultOptions: OrchestratorOptions = {
  prompt: "テストプロンプト",
  maxPlanIterations: 5,
  maxCodeIterations: 5,
  dangerous: false,
  verbose: false,
  debug: false,
  cwd: "/tmp",
};

function makeJudgment(hasConcerns: boolean, concerns: ReviewJudgment["concerns"] = []): ReviewJudgment {
  return {
    has_p3_plus_concerns: hasConcerns,
    concerns,
    questions_for_user: [],
    summary: hasConcerns ? "Issues found" : "No issues",
  };
}

describe("orchestrator", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCodex.checkGitRepo.mockResolvedValue(true);
    mockCodex.checkGitChanges.mockResolvedValue(true);
    mockUi.startProgress.mockImplementation(() => ({ stop: vi.fn() }));
  });

  it("懸念なしでワークフローが正常完了する", async () => {
    // Plan generation
    mockClaudeCode.generatePlan.mockResolvedValue({
      response: "Generated plan",
      raw: { exitCode: 0, stdout: "", stderr: "" },
    });

    // Plan review
    mockCodex.reviewPlan.mockResolvedValue({
      response: "Looks good",
      raw: { exitCode: 0, stdout: "", stderr: "" },
    });

    // Review judgment - no concerns
    mockJudgeReview.mockResolvedValue(makeJudgment(false));

    // User approvals
    mockUi.confirmYesNo.mockResolvedValue(true);

    // Code generation
    mockClaudeCode.generateCode.mockResolvedValue({
      response: "Generated code",
      raw: { exitCode: 0, stdout: "", stderr: "" },
    });

    // Code review
    mockCodex.reviewCode.mockResolvedValue({
      response: "Code looks good",
      raw: { exitCode: 0, stdout: "", stderr: "" },
    });

    await runWorkflow(defaultOptions);

    expect(mockClaudeCode.generatePlan).toHaveBeenCalledTimes(1);
    expect(mockCodex.reviewPlan).toHaveBeenCalledTimes(1);
    expect(mockJudgeReview).toHaveBeenCalledTimes(2); // plan + code review
    expect(mockClaudeCode.generateCode).toHaveBeenCalledTimes(1);
    expect(mockCodex.reviewCode).toHaveBeenCalledTimes(1);
  });

  it("ユーザーがプランを reject した場合にワークフローが中止される", async () => {
    mockClaudeCode.generatePlan.mockResolvedValue({
      response: "Generated plan",
      raw: { exitCode: 0, stdout: "", stderr: "" },
    });

    mockCodex.reviewPlan.mockResolvedValue({
      response: "Looks good",
      raw: { exitCode: 0, stdout: "", stderr: "" },
    });

    mockJudgeReview.mockResolvedValue(makeJudgment(false));

    // User rejects plan
    mockUi.confirmYesNo.mockResolvedValue(false);

    await runWorkflow(defaultOptions);

    // Code generation should NOT have been called
    expect(mockClaudeCode.generateCode).not.toHaveBeenCalled();
    expect(mockUi.display).toHaveBeenCalledWith(
      expect.stringContaining("中止"),
    );
  });

  it("プランレビューループが上限に達する", async () => {
    const opts = { ...defaultOptions, maxPlanIterations: 2 };

    mockClaudeCode.generatePlan.mockResolvedValue({
      response: "Plan",
      raw: { exitCode: 0, stdout: "", stderr: "" },
    });

    mockCodex.reviewPlan.mockResolvedValue({
      response: "Has issues",
      raw: { exitCode: 0, stdout: "", stderr: "" },
    });

    // Always return P3+ concerns
    mockJudgeReview.mockResolvedValue(
      makeJudgment(true, [{ severity: "P2", description: "Issue" }]),
    );

    // User chooses not to continue after loop limit
    mockUi.confirmYesNo.mockResolvedValue(false);

    await runWorkflow(opts);

    // Should have iterated maxPlanIterations times
    expect(mockCodex.reviewPlan).toHaveBeenCalledTimes(2);
    // Plan revision happens maxPlanIterations - 1 times (not on last iteration)
    expect(mockClaudeCode.generatePlan).toHaveBeenCalledTimes(2); // initial + 1 revision
    // Code generation should not have been called (user rejected)
    expect(mockClaudeCode.generateCode).not.toHaveBeenCalled();
  });

  it("プランレビューで修正→再レビューのフェーズ遷移が正しい", async () => {
    mockClaudeCode.generatePlan.mockResolvedValue({
      response: "Plan",
      raw: { exitCode: 0, stdout: "", stderr: "" },
    });

    mockCodex.reviewPlan.mockResolvedValue({
      response: "Review",
      raw: { exitCode: 0, stdout: "", stderr: "" },
    });

    // First review: concerns, second: no concerns
    mockJudgeReview
      .mockResolvedValueOnce(
        makeJudgment(true, [{ severity: "P2", description: "Fix this" }]),
      )
      .mockResolvedValueOnce(makeJudgment(false))
      // code review: no concerns
      .mockResolvedValueOnce(makeJudgment(false));

    mockUi.confirmYesNo.mockResolvedValue(true);

    mockClaudeCode.generateCode.mockResolvedValue({
      response: "Code",
      raw: { exitCode: 0, stdout: "", stderr: "" },
    });

    mockCodex.reviewCode.mockResolvedValue({
      response: "LGTM",
      raw: { exitCode: 0, stdout: "", stderr: "" },
    });

    await runWorkflow(defaultOptions);

    // Plan: initial + revision = 2 calls
    expect(mockClaudeCode.generatePlan).toHaveBeenCalledTimes(2);
    // Plan review: 2 rounds
    expect(mockCodex.reviewPlan).toHaveBeenCalledTimes(2);
  });

  it("初回プラン生成が空でエラー停止する", async () => {
    mockClaudeCode.generatePlan.mockResolvedValue({
      response: "",
      raw: { exitCode: 0, stdout: "", stderr: "" },
    });

    await expect(runWorkflow(defaultOptions)).rejects.toThrow("プラン生成結果が空です");

    // レビューやコード生成に進んでいないこと
    expect(mockCodex.reviewPlan).not.toHaveBeenCalled();
    expect(mockClaudeCode.generateCode).not.toHaveBeenCalled();
  });

  it("初回プラン生成が空白のみでもエラー停止する", async () => {
    mockClaudeCode.generatePlan.mockResolvedValue({
      response: "   \n  \n  ",
      raw: { exitCode: 0, stdout: "", stderr: "" },
    });

    await expect(runWorkflow(defaultOptions)).rejects.toThrow("プラン生成結果が空です");
    expect(mockCodex.reviewPlan).not.toHaveBeenCalled();
  });

  it("ループ内プラン修正後が空でエラー停止する", async () => {
    // 初回は正常なプランを返す
    mockClaudeCode.generatePlan
      .mockResolvedValueOnce({
        response: "Valid plan",
        raw: { exitCode: 0, stdout: "", stderr: "" },
      })
      // 修正後は空を返す
      .mockResolvedValueOnce({
        response: "",
        raw: { exitCode: 0, stdout: "", stderr: "" },
      });

    mockCodex.reviewPlan.mockResolvedValue({
      response: "Has issues",
      raw: { exitCode: 0, stdout: "", stderr: "" },
    });

    // レビューで懸念あり → 修正フェーズに進む
    mockJudgeReview.mockResolvedValue(
      makeJudgment(true, [{ severity: "P2", description: "Issue" }]),
    );

    await expect(runWorkflow(defaultOptions)).rejects.toThrow("プラン修正結果が空です");

    // 修正が呼ばれたこと（2回目のgeneratePlan）
    expect(mockClaudeCode.generatePlan).toHaveBeenCalledTimes(2);
    // コード生成には進んでいないこと
    expect(mockClaudeCode.generateCode).not.toHaveBeenCalled();
  });

  it("Git リポジトリ外でコードレビュー前にエラーで停止する", async () => {
    mockClaudeCode.generatePlan.mockResolvedValue({
      response: "Plan",
      raw: { exitCode: 0, stdout: "", stderr: "" },
    });

    mockCodex.reviewPlan.mockResolvedValue({
      response: "OK",
      raw: { exitCode: 0, stdout: "", stderr: "" },
    });

    mockJudgeReview.mockResolvedValue(makeJudgment(false));
    mockUi.confirmYesNo.mockResolvedValue(true);

    mockClaudeCode.generateCode.mockResolvedValue({
      response: "Code",
      raw: { exitCode: 0, stdout: "", stderr: "" },
    });

    // Not a git repo
    mockCodex.checkGitRepo.mockResolvedValue(false);

    await expect(runWorkflow(defaultOptions)).rejects.toThrow("Git リポジトリ");
  });

  it("verbose=true の場合は onStderr が各 LLM 呼び出しに渡される", async () => {
    const opts = { ...defaultOptions, verbose: true };

    mockClaudeCode.generatePlan.mockResolvedValue({
      response: "Generated plan",
      raw: { exitCode: 0, stdout: "", stderr: "" },
    });
    mockCodex.reviewPlan.mockResolvedValue({
      response: "Looks good",
      raw: { exitCode: 0, stdout: "", stderr: "" },
    });
    mockJudgeReview.mockResolvedValue(makeJudgment(false));
    mockUi.confirmYesNo.mockResolvedValue(true);
    mockClaudeCode.generateCode.mockResolvedValue({
      response: "Generated code",
      raw: { exitCode: 0, stdout: "", stderr: "" },
    });
    mockCodex.reviewCode.mockResolvedValue({
      response: "Code looks good",
      raw: { exitCode: 0, stdout: "", stderr: "" },
    });

    await runWorkflow(opts);

    expect(mockClaudeCode.generatePlan.mock.calls[0][2].onStderr).toEqual(expect.any(Function));
    expect(mockCodex.reviewPlan.mock.calls[0][2].onStderr).toEqual(expect.any(Function));
    expect(mockJudgeReview.mock.calls[0][1].onStderr).toEqual(expect.any(Function));
  });

  it("verbose=false かつ debug=false の場合は onStderr が undefined", async () => {
    mockClaudeCode.generatePlan.mockResolvedValue({
      response: "Generated plan",
      raw: { exitCode: 0, stdout: "", stderr: "" },
    });
    mockCodex.reviewPlan.mockResolvedValue({
      response: "Looks good",
      raw: { exitCode: 0, stdout: "", stderr: "" },
    });
    mockJudgeReview.mockResolvedValue(makeJudgment(false));
    mockUi.confirmYesNo.mockResolvedValue(true);
    mockClaudeCode.generateCode.mockResolvedValue({
      response: "Generated code",
      raw: { exitCode: 0, stdout: "", stderr: "" },
    });
    mockCodex.reviewCode.mockResolvedValue({
      response: "Code looks good",
      raw: { exitCode: 0, stdout: "", stderr: "" },
    });

    await runWorkflow(defaultOptions);

    expect(mockClaudeCode.generatePlan.mock.calls[0][2].onStderr).toBeUndefined();
    expect(mockCodex.reviewPlan.mock.calls[0][2].onStderr).toBeUndefined();
    expect(mockJudgeReview.mock.calls[0][1].onStderr).toBeUndefined();
  });

  it("debug=true（verbose=false）でも onStderr が有効になる", async () => {
    const opts = { ...defaultOptions, verbose: false, debug: true };

    mockClaudeCode.generatePlan.mockResolvedValue({
      response: "Generated plan",
      raw: { exitCode: 0, stdout: "", stderr: "" },
    });
    mockCodex.reviewPlan.mockResolvedValue({
      response: "Looks good",
      raw: { exitCode: 0, stdout: "", stderr: "" },
    });
    mockJudgeReview.mockResolvedValue(makeJudgment(false));
    mockUi.confirmYesNo.mockResolvedValue(true);
    mockClaudeCode.generateCode.mockResolvedValue({
      response: "Generated code",
      raw: { exitCode: 0, stdout: "", stderr: "" },
    });
    mockCodex.reviewCode.mockResolvedValue({
      response: "Code looks good",
      raw: { exitCode: 0, stdout: "", stderr: "" },
    });

    await runWorkflow(opts);

    expect(mockClaudeCode.generatePlan.mock.calls[0][2].onStderr).toEqual(expect.any(Function));
    expect(mockJudgeReview.mock.calls[0][1].onStderr).toEqual(expect.any(Function));
  });

  it("通常モードでは startProgress が呼ばれ、成功時に stop(true) が呼ばれる", async () => {
    const stopFns: Array<ReturnType<typeof vi.fn>> = [];
    mockUi.startProgress.mockImplementation(() => {
      const stop = vi.fn();
      stopFns.push(stop);
      return { stop };
    });

    mockClaudeCode.generatePlan.mockResolvedValue({
      response: "Generated plan",
      raw: { exitCode: 0, stdout: "", stderr: "" },
    });
    mockCodex.reviewPlan.mockResolvedValue({
      response: "Looks good",
      raw: { exitCode: 0, stdout: "", stderr: "" },
    });
    mockJudgeReview.mockResolvedValue(makeJudgment(false));
    mockUi.confirmYesNo.mockResolvedValue(true);
    mockClaudeCode.generateCode.mockResolvedValue({
      response: "Generated code",
      raw: { exitCode: 0, stdout: "", stderr: "" },
    });
    mockCodex.reviewCode.mockResolvedValue({
      response: "Code looks good",
      raw: { exitCode: 0, stdout: "", stderr: "" },
    });

    await runWorkflow(defaultOptions);

    expect(mockUi.startProgress).toHaveBeenCalled();
    expect(stopFns.length).toBeGreaterThan(0);
    stopFns.forEach((stop) => {
      expect(stop).toHaveBeenCalledWith(true);
      expect(stop).not.toHaveBeenCalledWith(false);
    });
  });

  it("通常モードで LLM 呼び出しが失敗した場合に stop(false) が呼ばれる", async () => {
    const stop = vi.fn();
    mockUi.startProgress.mockReturnValue({ stop });
    mockClaudeCode.generatePlan.mockRejectedValue(new Error("boom"));

    await expect(runWorkflow(defaultOptions)).rejects.toThrow("boom");

    expect(stop).toHaveBeenCalledWith(false);
  });
});
