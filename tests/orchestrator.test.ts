import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock all external dependencies
vi.mock("../src/cli-runner.js", () => ({
  validateCapabilities: vi.fn().mockResolvedValue(null),
  checkStreamingCapability: vi.fn().mockResolvedValue(false),
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
  getGitDiff: vi.fn().mockResolvedValue("mock diff content"),
}));

vi.mock("../src/review-judge.js", () => ({
  judgeReview: vi.fn(),
}));

vi.mock("../src/user-interaction.js", () => ({
  confirmYesNo: vi.fn(),
  promptPlanApproval: vi.fn(),
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

import { runWorkflow, isDiffLikeResponse } from "../src/orchestrator.js";
import * as claudeCode from "../src/claude-code.js";
import * as codex from "../src/codex.js";
import { judgeReview } from "../src/review-judge.js";
import * as ui from "../src/user-interaction.js";
import { checkStreamingCapability } from "../src/cli-runner.js";
import type { ReviewJudgment, OrchestratorOptions } from "../src/types.js";

const mockClaudeCode = vi.mocked(claudeCode);
const mockCodex = vi.mocked(codex);
const mockJudgeReview = vi.mocked(judgeReview);
const mockUi = vi.mocked(ui);
const mockCheckStreamingCapability = vi.mocked(checkStreamingCapability);

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
    mockCodex.getGitDiff.mockResolvedValue("mock diff content");
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
    mockUi.promptPlanApproval.mockResolvedValue({ action: "approve" });

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

    // User aborts plan
    mockUi.promptPlanApproval.mockResolvedValue({ action: "abort" });

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

    mockUi.promptPlanApproval.mockResolvedValue({ action: "approve" });

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
    // PLAN_REVISION プロンプトに currentPlan と「現在の計画」ヘッダが含まれること
    const revisionPrompt = mockClaudeCode.generatePlan.mock.calls[1][1] as string;
    expect(revisionPrompt).toContain("Plan");
    expect(revisionPrompt).toContain("現在の計画");
  });

  it("2回目のプランレビューに修正後プラン本文が含まれる", async () => {
    const revisedPlan = "Revised plan content";

    mockClaudeCode.generatePlan
      .mockResolvedValueOnce({
        response: "Initial plan",
        raw: { exitCode: 0, stdout: "", stderr: "" },
      })
      .mockResolvedValueOnce({
        response: revisedPlan,
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

    mockUi.promptPlanApproval.mockResolvedValue({ action: "approve" });

    mockClaudeCode.generateCode.mockResolvedValue({
      response: "Code",
      raw: { exitCode: 0, stdout: "", stderr: "" },
    });

    mockCodex.reviewCode.mockResolvedValue({
      response: "LGTM",
      raw: { exitCode: 0, stdout: "", stderr: "" },
    });

    await runWorkflow(defaultOptions);

    // 2回目の reviewPlan の prompt 引数に修正後プラン本文が含まれること
    const secondReviewPrompt = mockCodex.reviewPlan.mock.calls[1][1] as string;
    expect(secondReviewPrompt).toContain(revisedPlan);
    // 初回プランテキストではないことも確認
    expect(secondReviewPrompt).not.toContain("Initial plan");
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
    mockUi.promptPlanApproval.mockResolvedValue({ action: "approve" });

    mockClaudeCode.generateCode.mockResolvedValue({
      response: "Code",
      raw: { exitCode: 0, stdout: "", stderr: "" },
    });

    // Not a git repo
    mockCodex.checkGitRepo.mockResolvedValue(false);

    await expect(runWorkflow(defaultOptions)).rejects.toThrow("Git リポジトリ");
  });

  it("verbose=true かつ streaming 対応の場合は onStdout/onStderr が各 LLM 呼び出しに渡される", async () => {
    const opts = { ...defaultOptions, verbose: true };
    mockCheckStreamingCapability.mockResolvedValue(true);

    mockClaudeCode.generatePlan.mockResolvedValue({
      response: "Generated plan",
      raw: { exitCode: 0, stdout: "", stderr: "" },
    });
    mockCodex.reviewPlan.mockResolvedValue({
      response: "Looks good",
      raw: { exitCode: 0, stdout: "", stderr: "" },
    });
    mockJudgeReview.mockResolvedValue(makeJudgment(false));
    mockUi.promptPlanApproval.mockResolvedValue({ action: "approve" });
    mockClaudeCode.generateCode.mockResolvedValue({
      response: "Generated code",
      raw: { exitCode: 0, stdout: "", stderr: "" },
    });
    mockCodex.reviewCode.mockResolvedValue({
      response: "Code looks good",
      raw: { exitCode: 0, stdout: "", stderr: "" },
    });

    await runWorkflow(opts);

    expect(mockClaudeCode.generatePlan.mock.calls[0][2].onStdout).toEqual(expect.any(Function));
    expect(mockCodex.reviewPlan.mock.calls[0][2].onStdout).toEqual(expect.any(Function));
    expect(mockJudgeReview.mock.calls[0][1].onStdout).toEqual(expect.any(Function));
    expect(mockClaudeCode.generatePlan.mock.calls[0][2].onStderr).toEqual(expect.any(Function));
    expect(mockCodex.reviewPlan.mock.calls[0][2].onStderr).toEqual(expect.any(Function));
    expect(mockJudgeReview.mock.calls[0][1].onStderr).toEqual(expect.any(Function));
    expect(mockClaudeCode.generatePlan.mock.calls[0][2].streaming).toBe(true);
    // Codex streaming flag
    expect(mockCodex.reviewPlan.mock.calls[0][2].streaming).toBe(true);
  });

  it("verbose=false かつ debug=false の場合は onStdout/onStderr が undefined", async () => {
    mockClaudeCode.generatePlan.mockResolvedValue({
      response: "Generated plan",
      raw: { exitCode: 0, stdout: "", stderr: "" },
    });
    mockCodex.reviewPlan.mockResolvedValue({
      response: "Looks good",
      raw: { exitCode: 0, stdout: "", stderr: "" },
    });
    mockJudgeReview.mockResolvedValue(makeJudgment(false));
    mockUi.promptPlanApproval.mockResolvedValue({ action: "approve" });
    mockClaudeCode.generateCode.mockResolvedValue({
      response: "Generated code",
      raw: { exitCode: 0, stdout: "", stderr: "" },
    });
    mockCodex.reviewCode.mockResolvedValue({
      response: "Code looks good",
      raw: { exitCode: 0, stdout: "", stderr: "" },
    });

    await runWorkflow(defaultOptions);

    expect(mockClaudeCode.generatePlan.mock.calls[0][2].onStdout).toBeUndefined();
    expect(mockCodex.reviewPlan.mock.calls[0][2].onStdout).toBeUndefined();
    expect(mockJudgeReview.mock.calls[0][1].onStdout).toBeUndefined();
    expect(mockClaudeCode.generatePlan.mock.calls[0][2].onStderr).toBeUndefined();
    expect(mockCodex.reviewPlan.mock.calls[0][2].onStderr).toBeUndefined();
    expect(mockJudgeReview.mock.calls[0][1].onStderr).toBeUndefined();
    // Codex streaming flag should be falsy
    expect(mockCodex.reviewPlan.mock.calls[0][2].streaming).toBeFalsy();
  });

  it("debug=true（verbose=false）かつ streaming 対応でも onStdout/onStderr が有効になる", async () => {
    const opts = { ...defaultOptions, verbose: false, debug: true };
    mockCheckStreamingCapability.mockResolvedValue(true);

    mockClaudeCode.generatePlan.mockResolvedValue({
      response: "Generated plan",
      raw: { exitCode: 0, stdout: "", stderr: "" },
    });
    mockCodex.reviewPlan.mockResolvedValue({
      response: "Looks good",
      raw: { exitCode: 0, stdout: "", stderr: "" },
    });
    mockJudgeReview.mockResolvedValue(makeJudgment(false));
    mockUi.promptPlanApproval.mockResolvedValue({ action: "approve" });
    mockClaudeCode.generateCode.mockResolvedValue({
      response: "Generated code",
      raw: { exitCode: 0, stdout: "", stderr: "" },
    });
    mockCodex.reviewCode.mockResolvedValue({
      response: "Code looks good",
      raw: { exitCode: 0, stdout: "", stderr: "" },
    });

    await runWorkflow(opts);

    expect(mockClaudeCode.generatePlan.mock.calls[0][2].onStdout).toEqual(expect.any(Function));
    expect(mockJudgeReview.mock.calls[0][1].onStdout).toEqual(expect.any(Function));
    expect(mockClaudeCode.generatePlan.mock.calls[0][2].onStderr).toEqual(expect.any(Function));
    expect(mockJudgeReview.mock.calls[0][1].onStderr).toEqual(expect.any(Function));
    expect(mockClaudeCode.generatePlan.mock.calls[0][2].streaming).toBe(true);
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
    mockUi.promptPlanApproval.mockResolvedValue({ action: "approve" });
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

  it("checkStreamingCapability が false を返す場合、claudeOpts.streaming が false になる", async () => {
    const opts = { ...defaultOptions, verbose: true };
    mockCheckStreamingCapability.mockResolvedValue(false);

    mockClaudeCode.generatePlan.mockResolvedValue({
      response: "Generated plan",
      raw: { exitCode: 0, stdout: "", stderr: "" },
    });
    mockCodex.reviewPlan.mockResolvedValue({
      response: "Looks good",
      raw: { exitCode: 0, stdout: "", stderr: "" },
    });
    mockJudgeReview.mockResolvedValue(makeJudgment(false));
    mockUi.promptPlanApproval.mockResolvedValue({ action: "approve" });
    mockClaudeCode.generateCode.mockResolvedValue({
      response: "Generated code",
      raw: { exitCode: 0, stdout: "", stderr: "" },
    });
    mockCodex.reviewCode.mockResolvedValue({
      response: "Code looks good",
      raw: { exitCode: 0, stdout: "", stderr: "" },
    });

    await runWorkflow(opts);

    expect(mockClaudeCode.generatePlan.mock.calls[0][2].streaming).toBe(false);
  });

  it("フォールバック時（streaming 非対応）に Claude 向け onStdout が undefined になる", async () => {
    const opts = { ...defaultOptions, verbose: true };
    mockCheckStreamingCapability.mockResolvedValue(false);

    mockClaudeCode.generatePlan.mockResolvedValue({
      response: "Generated plan",
      raw: { exitCode: 0, stdout: "", stderr: "" },
    });
    mockCodex.reviewPlan.mockResolvedValue({
      response: "Looks good",
      raw: { exitCode: 0, stdout: "", stderr: "" },
    });
    mockJudgeReview.mockResolvedValue(makeJudgment(false));
    mockUi.promptPlanApproval.mockResolvedValue({ action: "approve" });
    mockClaudeCode.generateCode.mockResolvedValue({
      response: "Generated code",
      raw: { exitCode: 0, stdout: "", stderr: "" },
    });
    mockCodex.reviewCode.mockResolvedValue({
      response: "Code looks good",
      raw: { exitCode: 0, stdout: "", stderr: "" },
    });

    await runWorkflow(opts);

    // Claude 向け onStdout は undefined（JSON blob がそのまま表示されるのを防ぐ）
    expect(mockClaudeCode.generatePlan.mock.calls[0][2].onStdout).toBeUndefined();
    // stderr は常に有効
    expect(mockClaudeCode.generatePlan.mock.calls[0][2].onStderr).toEqual(expect.any(Function));
    // Codex やレビュー向け onStdout は引き続き有効
    expect(mockCodex.reviewPlan.mock.calls[0][2].onStdout).toEqual(expect.any(Function));
    expect(mockJudgeReview.mock.calls[0][1].onStdout).toEqual(expect.any(Function));
  });

  it("stream 非対応環境で全ワークフローが正常完了する（フォールバック経路）", async () => {
    const opts = { ...defaultOptions, verbose: true };
    mockCheckStreamingCapability.mockResolvedValue(false);

    mockClaudeCode.generatePlan.mockResolvedValue({
      response: "Generated plan",
      raw: { exitCode: 0, stdout: "", stderr: "" },
    });
    mockCodex.reviewPlan.mockResolvedValue({
      response: "Looks good",
      raw: { exitCode: 0, stdout: "", stderr: "" },
    });
    mockJudgeReview.mockResolvedValue(makeJudgment(false));
    mockUi.promptPlanApproval.mockResolvedValue({ action: "approve" });
    mockClaudeCode.generateCode.mockResolvedValue({
      response: "Generated code",
      raw: { exitCode: 0, stdout: "", stderr: "" },
    });
    mockCodex.reviewCode.mockResolvedValue({
      response: "Code looks good",
      raw: { exitCode: 0, stdout: "", stderr: "" },
    });

    await runWorkflow(opts);

    // ワークフロー全体が正常完了
    expect(mockClaudeCode.generatePlan).toHaveBeenCalledTimes(1);
    expect(mockClaudeCode.generateCode).toHaveBeenCalledTimes(1);
    expect(mockCodex.reviewPlan).toHaveBeenCalledTimes(1);
    expect(mockCodex.reviewCode).toHaveBeenCalledTimes(1);
  });

  it("コードレビューで getGitDiff → CODE_REVIEW プロンプト → reviewCode(prompt, opts) の連携が正しい", async () => {
    const planText = "Test plan content";
    const diffText = "diff --git a/file.ts";

    mockClaudeCode.generatePlan.mockResolvedValue({
      response: planText,
      raw: { exitCode: 0, stdout: "", stderr: "" },
    });
    mockCodex.reviewPlan.mockResolvedValue({
      response: "Looks good",
      raw: { exitCode: 0, stdout: "", stderr: "" },
    });
    mockJudgeReview.mockResolvedValue(makeJudgment(false));
    mockUi.promptPlanApproval.mockResolvedValue({ action: "approve" });
    mockClaudeCode.generateCode.mockResolvedValue({
      response: "Generated code",
      raw: { exitCode: 0, stdout: "", stderr: "" },
    });
    mockCodex.getGitDiff.mockResolvedValue(diffText);
    mockCodex.reviewCode.mockResolvedValue({
      response: "Code looks good",
      raw: { exitCode: 0, stdout: "", stderr: "" },
    });

    await runWorkflow(defaultOptions);

    // getGitDiff が cwd で呼ばれること
    expect(mockCodex.getGitDiff).toHaveBeenCalledWith(defaultOptions.cwd);
    // reviewCode の第1引数がプランと diff を含むプロンプトであること
    const reviewPrompt = mockCodex.reviewCode.mock.calls[0][0] as string;
    expect(reviewPrompt).toContain(planText);
    expect(reviewPrompt).toContain(diffText);
    // 第2引数が options であること
    expect(mockCodex.reviewCode.mock.calls[0][1]).toMatchObject({ cwd: defaultOptions.cwd });
  });

  it("getGitDiff が空文字を返した場合にエラーで停止する", async () => {
    mockClaudeCode.generatePlan.mockResolvedValue({
      response: "Plan",
      raw: { exitCode: 0, stdout: "", stderr: "" },
    });
    mockCodex.reviewPlan.mockResolvedValue({
      response: "OK",
      raw: { exitCode: 0, stdout: "", stderr: "" },
    });
    mockJudgeReview.mockResolvedValue(makeJudgment(false));
    mockUi.promptPlanApproval.mockResolvedValue({ action: "approve" });
    mockClaudeCode.generateCode.mockResolvedValue({
      response: "Code",
      raw: { exitCode: 0, stdout: "", stderr: "" },
    });
    mockCodex.getGitDiff.mockResolvedValue("");

    await expect(runWorkflow(defaultOptions)).rejects.toThrow("差分の取得に失敗しました");
    expect(mockCodex.reviewCode).not.toHaveBeenCalled();
  });

  it("verbose=true かつ streaming 非対応の場合、Claude 呼び出しでスピナーが表示される", async () => {
    const opts = { ...defaultOptions, verbose: true };
    mockCheckStreamingCapability.mockResolvedValue(false);

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
    mockUi.promptPlanApproval.mockResolvedValue({ action: "approve" });
    mockClaudeCode.generateCode.mockResolvedValue({
      response: "Generated code",
      raw: { exitCode: 0, stdout: "", stderr: "" },
    });
    mockCodex.reviewCode.mockResolvedValue({
      response: "Code looks good",
      raw: { exitCode: 0, stdout: "", stderr: "" },
    });

    await runWorkflow(opts);

    // Claude 呼び出し（プラン生成・コード生成）でのみスピナーが表示される
    // canStream=false だが shouldStream=true なので、レビュー系はスピナーなし
    expect(mockUi.startProgress).toHaveBeenCalledTimes(2);
    // スピナーの stop(true) が呼ばれていること
    expect(stopFns.length).toBe(2);
    stopFns.forEach((stop) => {
      expect(stop).toHaveBeenCalledWith(true);
    });
  });

  it("verbose=true の場合、レビュー系ステップでスピナーが表示されない", async () => {
    const opts = { ...defaultOptions, verbose: true };
    mockCheckStreamingCapability.mockResolvedValue(true);

    mockUi.startProgress.mockImplementation(() => {
      const stop = vi.fn();
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
    mockUi.promptPlanApproval.mockResolvedValue({ action: "approve" });
    mockClaudeCode.generateCode.mockResolvedValue({
      response: "Generated code",
      raw: { exitCode: 0, stdout: "", stderr: "" },
    });
    mockCodex.reviewCode.mockResolvedValue({
      response: "Code looks good",
      raw: { exitCode: 0, stdout: "", stderr: "" },
    });

    await runWorkflow(opts);

    // shouldStream=true かつ canStream=true なので全ステップでスピナーなし
    expect(mockUi.startProgress).not.toHaveBeenCalled();

    // startProgress が呼ばれていたとしても、レビュー系ラベルが含まれないことを確認
    const progressLabels = mockUi.startProgress.mock.calls.map((call) => call[0]);
    expect(progressLabels).not.toContain("プランレビュー中...");
    expect(progressLabels).not.toContain("レビュー判定中...");
    expect(progressLabels).not.toContain("コードレビュー中...");
    expect(progressLabels).not.toContain("コードレビュー判定中...");
  });

  it("ユーザー修正指示 → 再レビュー → 承認でワークフローが完了する", async () => {
    mockClaudeCode.generatePlan
      .mockResolvedValueOnce({
        response: "Initial plan",
        raw: { exitCode: 0, stdout: "", stderr: "" },
      })
      // User revision
      .mockResolvedValueOnce({
        response: "User-revised plan",
        raw: { exitCode: 0, stdout: "", stderr: "" },
      });

    mockCodex.reviewPlan.mockResolvedValue({
      response: "Looks good",
      raw: { exitCode: 0, stdout: "", stderr: "" },
    });

    // Both plan reviews pass (initial + re-review after user revision)
    mockJudgeReview
      .mockResolvedValueOnce(makeJudgment(false))
      .mockResolvedValueOnce(makeJudgment(false))
      // code review
      .mockResolvedValueOnce(makeJudgment(false));

    // First: modify, second: approve
    mockUi.promptPlanApproval
      .mockResolvedValueOnce({ action: "modify", instruction: "エラーハンドリングを追加して" })
      .mockResolvedValueOnce({ action: "approve" });

    mockClaudeCode.generateCode.mockResolvedValue({
      response: "Code",
      raw: { exitCode: 0, stdout: "", stderr: "" },
    });
    mockCodex.reviewCode.mockResolvedValue({
      response: "LGTM",
      raw: { exitCode: 0, stdout: "", stderr: "" },
    });

    await runWorkflow(defaultOptions);

    // generatePlan: initial + user revision = 2
    expect(mockClaudeCode.generatePlan).toHaveBeenCalledTimes(2);
    // reviewPlan: initial review + re-review after user revision = 2
    expect(mockCodex.reviewPlan).toHaveBeenCalledTimes(2);
    // Code generation proceeded
    expect(mockClaudeCode.generateCode).toHaveBeenCalledTimes(1);
  });

  it("修正指示のテキストが PLAN_USER_REVISION テンプレート経由で generatePlan に渡される", async () => {
    const userInstruction = "テスト追加してください";

    mockClaudeCode.generatePlan
      .mockResolvedValueOnce({
        response: "Initial plan",
        raw: { exitCode: 0, stdout: "", stderr: "" },
      })
      .mockResolvedValueOnce({
        response: "Revised plan",
        raw: { exitCode: 0, stdout: "", stderr: "" },
      });

    mockCodex.reviewPlan.mockResolvedValue({
      response: "OK",
      raw: { exitCode: 0, stdout: "", stderr: "" },
    });

    mockJudgeReview
      .mockResolvedValueOnce(makeJudgment(false))
      .mockResolvedValueOnce(makeJudgment(false))
      .mockResolvedValueOnce(makeJudgment(false));

    mockUi.promptPlanApproval
      .mockResolvedValueOnce({ action: "modify", instruction: userInstruction })
      .mockResolvedValueOnce({ action: "approve" });

    mockClaudeCode.generateCode.mockResolvedValue({
      response: "Code",
      raw: { exitCode: 0, stdout: "", stderr: "" },
    });
    mockCodex.reviewCode.mockResolvedValue({
      response: "LGTM",
      raw: { exitCode: 0, stdout: "", stderr: "" },
    });

    await runWorkflow(defaultOptions);

    // 2回目の generatePlan に PLAN_USER_REVISION テンプレートの内容が含まれること
    const revisionPrompt = mockClaudeCode.generatePlan.mock.calls[1][1] as string;
    expect(revisionPrompt).toContain(userInstruction);
    expect(revisionPrompt).toContain("ユーザーの修正指示");
    // currentPlan テキストと「現在の計画」ヘッダが含まれること
    expect(revisionPrompt).toContain("Initial plan");
    expect(revisionPrompt).toContain("現在の計画");
  });

  it("ユーザー修正指示後のプランが空の場合エラーで停止する", async () => {
    mockClaudeCode.generatePlan
      .mockResolvedValueOnce({
        response: "Initial plan",
        raw: { exitCode: 0, stdout: "", stderr: "" },
      })
      .mockResolvedValueOnce({
        response: "",
        raw: { exitCode: 0, stdout: "", stderr: "" },
      });

    mockCodex.reviewPlan.mockResolvedValue({
      response: "OK",
      raw: { exitCode: 0, stdout: "", stderr: "" },
    });

    mockJudgeReview.mockResolvedValue(makeJudgment(false));

    mockUi.promptPlanApproval.mockResolvedValueOnce({
      action: "modify",
      instruction: "修正してください",
    });

    await expect(runWorkflow(defaultOptions)).rejects.toThrow("プラン修正結果が空です");

    expect(mockClaudeCode.generateCode).not.toHaveBeenCalled();
  });

  it("差分出力時にリトライが発生し、リトライプロンプトに必要な情報が含まれる", async () => {
    const initialPlan = "A".repeat(200);
    const diffResponse = "変更点は以下の通りです\n- 項目追加";
    const retryFullPlan = "A".repeat(200) + "\n- 追加項目";

    mockClaudeCode.generatePlan
      .mockResolvedValueOnce({
        response: initialPlan,
        raw: { exitCode: 0, stdout: "", stderr: "" },
      })
      // ユーザー修正 → 差分出力
      .mockResolvedValueOnce({
        response: diffResponse,
        raw: { exitCode: 0, stdout: "", stderr: "" },
      })
      // リトライ → 全文出力
      .mockResolvedValueOnce({
        response: retryFullPlan,
        raw: { exitCode: 0, stdout: "", stderr: "" },
      });

    mockCodex.reviewPlan.mockResolvedValue({
      response: "OK",
      raw: { exitCode: 0, stdout: "", stderr: "" },
    });

    mockJudgeReview
      .mockResolvedValueOnce(makeJudgment(false))
      // re-review after user revision
      .mockResolvedValueOnce(makeJudgment(false))
      // code review
      .mockResolvedValueOnce(makeJudgment(false));

    mockUi.promptPlanApproval
      .mockResolvedValueOnce({ action: "modify", instruction: "項目を追加して" })
      .mockResolvedValueOnce({ action: "approve" });

    mockClaudeCode.generateCode.mockResolvedValue({
      response: "Code",
      raw: { exitCode: 0, stdout: "", stderr: "" },
    });
    mockCodex.reviewCode.mockResolvedValue({
      response: "LGTM",
      raw: { exitCode: 0, stdout: "", stderr: "" },
    });

    await runWorkflow(defaultOptions);

    // リトライが発生（3回目の generatePlan）
    expect(mockClaudeCode.generatePlan).toHaveBeenCalledTimes(3);
    // リトライプロンプトに lastKnownFullPlan と差分出力と修正要求が含まれること
    const retryPrompt = mockClaudeCode.generatePlan.mock.calls[2][1] as string;
    expect(retryPrompt).toContain(initialPlan);
    expect(retryPrompt).toContain("項目を追加して");
    expect(retryPrompt).toContain("ベースとなる計画");
    expect(retryPrompt).toContain("先ほどの修正出力");
  });

  it("リトライ成功で全文が currentPlan になり、CODE_REVIEW に全文が渡る", async () => {
    const initialPlan = "A".repeat(200);
    const diffResponse = "変更点: エラー処理追加";
    const retryFullPlan = "A".repeat(200) + "\nエラー処理追加";

    mockClaudeCode.generatePlan
      .mockResolvedValueOnce({
        response: initialPlan,
        raw: { exitCode: 0, stdout: "", stderr: "" },
      })
      .mockResolvedValueOnce({
        response: diffResponse,
        raw: { exitCode: 0, stdout: "", stderr: "" },
      })
      .mockResolvedValueOnce({
        response: retryFullPlan,
        raw: { exitCode: 0, stdout: "", stderr: "" },
      });

    mockCodex.reviewPlan.mockResolvedValue({
      response: "OK",
      raw: { exitCode: 0, stdout: "", stderr: "" },
    });

    mockJudgeReview
      .mockResolvedValueOnce(makeJudgment(false))
      .mockResolvedValueOnce(makeJudgment(false))
      .mockResolvedValueOnce(makeJudgment(false));

    mockUi.promptPlanApproval
      .mockResolvedValueOnce({ action: "modify", instruction: "エラー処理追加" })
      .mockResolvedValueOnce({ action: "approve" });

    mockClaudeCode.generateCode.mockResolvedValue({
      response: "Code",
      raw: { exitCode: 0, stdout: "", stderr: "" },
    });
    mockCodex.reviewCode.mockResolvedValue({
      response: "LGTM",
      raw: { exitCode: 0, stdout: "", stderr: "" },
    });

    await runWorkflow(defaultOptions);

    // CODE_REVIEW プロンプトにリトライ後の全文が渡ること
    const codeReviewPrompt = mockCodex.reviewCode.mock.calls[0][0] as string;
    expect(codeReviewPrompt).toContain(retryFullPlan);
  });

  it("リトライ失敗時に lastKnownFullPlan にフォールバック + 警告表示", async () => {
    const initialPlan = "A".repeat(200);
    const diffResponse = "変更点: 追加";
    const retryDiffAgain = "まだ差分です";

    mockClaudeCode.generatePlan
      .mockResolvedValueOnce({
        response: initialPlan,
        raw: { exitCode: 0, stdout: "", stderr: "" },
      })
      .mockResolvedValueOnce({
        response: diffResponse,
        raw: { exitCode: 0, stdout: "", stderr: "" },
      })
      // リトライも差分（短い）→ フォールバック
      .mockResolvedValueOnce({
        response: retryDiffAgain,
        raw: { exitCode: 0, stdout: "", stderr: "" },
      });

    mockCodex.reviewPlan.mockResolvedValue({
      response: "OK",
      raw: { exitCode: 0, stdout: "", stderr: "" },
    });

    mockJudgeReview
      .mockResolvedValueOnce(makeJudgment(false))
      .mockResolvedValueOnce(makeJudgment(false))
      .mockResolvedValueOnce(makeJudgment(false));

    mockUi.promptPlanApproval
      .mockResolvedValueOnce({ action: "modify", instruction: "追加して" })
      .mockResolvedValueOnce({ action: "approve" });

    // フォールバック時の続行確認
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

    // 警告が表示されること
    expect(mockUi.display).toHaveBeenCalledWith(
      expect.stringContaining("修正指示が反映されていない可能性があります"),
    );
    // CODE_REVIEW に初回全文プランが渡ること（フォールバック）
    const codeReviewPrompt = mockCodex.reviewCode.mock.calls[0][0] as string;
    expect(codeReviewPrompt).toContain(initialPlan);
  });

  it("連続修正で2回目も差分出力された場合、初回の lastKnownFullPlan が維持される", async () => {
    const initialPlan = "A".repeat(200);
    const firstDiff = "変更点: 1回目";
    const firstRetryFull = "A".repeat(200) + "\n1回目修正";
    const secondDiff = "変更点: 2回目";
    const secondRetryDiff = "まだ差分";

    mockClaudeCode.generatePlan
      .mockResolvedValueOnce({
        response: initialPlan,
        raw: { exitCode: 0, stdout: "", stderr: "" },
      })
      // 1回目修正: 差分
      .mockResolvedValueOnce({
        response: firstDiff,
        raw: { exitCode: 0, stdout: "", stderr: "" },
      })
      // 1回目リトライ: 全文成功
      .mockResolvedValueOnce({
        response: firstRetryFull,
        raw: { exitCode: 0, stdout: "", stderr: "" },
      })
      // 2回目修正: 差分
      .mockResolvedValueOnce({
        response: secondDiff,
        raw: { exitCode: 0, stdout: "", stderr: "" },
      })
      // 2回目リトライ: また差分 → フォールバック
      .mockResolvedValueOnce({
        response: secondRetryDiff,
        raw: { exitCode: 0, stdout: "", stderr: "" },
      });

    mockCodex.reviewPlan.mockResolvedValue({
      response: "OK",
      raw: { exitCode: 0, stdout: "", stderr: "" },
    });

    mockJudgeReview
      .mockResolvedValueOnce(makeJudgment(false))
      .mockResolvedValueOnce(makeJudgment(false))
      .mockResolvedValueOnce(makeJudgment(false))
      .mockResolvedValueOnce(makeJudgment(false));

    mockUi.promptPlanApproval
      .mockResolvedValueOnce({ action: "modify", instruction: "1回目" })
      .mockResolvedValueOnce({ action: "modify", instruction: "2回目" })
      .mockResolvedValueOnce({ action: "approve" });

    // 2回目フォールバック時の続行確認
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

    // 2回目フォールバック時、lastKnownFullPlan は1回目リトライ成功時の全文
    const codeReviewPrompt = mockCodex.reviewCode.mock.calls[0][0] as string;
    expect(codeReviewPrompt).toContain(firstRetryFull);
  });

  it("パターン検知（'変更点...'で始まる長いレスポンス）でリトライが発動する", async () => {
    const initialPlan = "A".repeat(100);
    // 長いが先頭行が差分パターンに一致
    const longDiffResponse = "変更点は2つです\n" + "B".repeat(200);
    const retryFullPlan = "C".repeat(200);

    mockClaudeCode.generatePlan
      .mockResolvedValueOnce({
        response: initialPlan,
        raw: { exitCode: 0, stdout: "", stderr: "" },
      })
      .mockResolvedValueOnce({
        response: longDiffResponse,
        raw: { exitCode: 0, stdout: "", stderr: "" },
      })
      .mockResolvedValueOnce({
        response: retryFullPlan,
        raw: { exitCode: 0, stdout: "", stderr: "" },
      });

    mockCodex.reviewPlan.mockResolvedValue({
      response: "OK",
      raw: { exitCode: 0, stdout: "", stderr: "" },
    });

    mockJudgeReview
      .mockResolvedValueOnce(makeJudgment(false))
      .mockResolvedValueOnce(makeJudgment(false))
      .mockResolvedValueOnce(makeJudgment(false));

    mockUi.promptPlanApproval
      .mockResolvedValueOnce({ action: "modify", instruction: "修正して" })
      .mockResolvedValueOnce({ action: "approve" });

    mockClaudeCode.generateCode.mockResolvedValue({
      response: "Code",
      raw: { exitCode: 0, stdout: "", stderr: "" },
    });
    mockCodex.reviewCode.mockResolvedValue({
      response: "LGTM",
      raw: { exitCode: 0, stdout: "", stderr: "" },
    });

    await runWorkflow(defaultOptions);

    // リトライが発動（3回目の generatePlan）
    expect(mockClaudeCode.generatePlan).toHaveBeenCalledTimes(3);
    expect(mockUi.display).toHaveBeenCalledWith(
      expect.stringContaining("差分出力を検知しました"),
    );
  });

  it("unified diff 形式 (@@, +++/---) のレスポンスでリトライが発動する", async () => {
    const initialPlan = "A".repeat(200);
    const diffResponse = "以下の変更を適用:\n@@ -1,3 +1,4 @@\n line1\n+added\n line2\n" + "B".repeat(200);
    const retryFullPlan = "A".repeat(200) + "\nadded";

    mockClaudeCode.generatePlan
      .mockResolvedValueOnce({
        response: initialPlan,
        raw: { exitCode: 0, stdout: "", stderr: "" },
      })
      .mockResolvedValueOnce({
        response: diffResponse,
        raw: { exitCode: 0, stdout: "", stderr: "" },
      })
      .mockResolvedValueOnce({
        response: retryFullPlan,
        raw: { exitCode: 0, stdout: "", stderr: "" },
      });

    mockCodex.reviewPlan.mockResolvedValue({
      response: "OK",
      raw: { exitCode: 0, stdout: "", stderr: "" },
    });

    mockJudgeReview
      .mockResolvedValueOnce(makeJudgment(false))
      .mockResolvedValueOnce(makeJudgment(false))
      .mockResolvedValueOnce(makeJudgment(false));

    mockUi.promptPlanApproval
      .mockResolvedValueOnce({ action: "modify", instruction: "修正して" })
      .mockResolvedValueOnce({ action: "approve" });

    mockClaudeCode.generateCode.mockResolvedValue({
      response: "Code",
      raw: { exitCode: 0, stdout: "", stderr: "" },
    });
    mockCodex.reviewCode.mockResolvedValue({
      response: "LGTM",
      raw: { exitCode: 0, stdout: "", stderr: "" },
    });

    await runWorkflow(defaultOptions);

    expect(mockClaudeCode.generatePlan).toHaveBeenCalledTimes(3);
  });

  it("リトライ API が throw した場合に lastKnownFullPlan にフォールバック + 警告表示", async () => {
    const initialPlan = "A".repeat(200);
    const diffResponse = "変更点: 追加";

    mockClaudeCode.generatePlan
      .mockResolvedValueOnce({
        response: initialPlan,
        raw: { exitCode: 0, stdout: "", stderr: "" },
      })
      .mockResolvedValueOnce({
        response: diffResponse,
        raw: { exitCode: 0, stdout: "", stderr: "" },
      })
      // リトライが throw
      .mockRejectedValueOnce(new Error("API error"));

    mockCodex.reviewPlan.mockResolvedValue({
      response: "OK",
      raw: { exitCode: 0, stdout: "", stderr: "" },
    });

    mockJudgeReview
      .mockResolvedValueOnce(makeJudgment(false))
      .mockResolvedValueOnce(makeJudgment(false))
      .mockResolvedValueOnce(makeJudgment(false));

    mockUi.promptPlanApproval
      .mockResolvedValueOnce({ action: "modify", instruction: "追加して" })
      .mockResolvedValueOnce({ action: "approve" });

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

    // フォールバック警告
    expect(mockUi.display).toHaveBeenCalledWith(
      expect.stringContaining("全文再取得に失敗しました"),
    );
    // CODE_REVIEW に初回プランが渡ること
    const codeReviewPrompt = mockCodex.reviewCode.mock.calls[0][0] as string;
    expect(codeReviewPrompt).toContain(initialPlan);
  });

  it("フォールバック確認で n を選んだ場合にワークフローが中止される", async () => {
    const initialPlan = "A".repeat(200);
    const diffResponse = "変更点: 追加";
    const retryDiffAgain = "まだ差分";

    mockClaudeCode.generatePlan
      .mockResolvedValueOnce({
        response: initialPlan,
        raw: { exitCode: 0, stdout: "", stderr: "" },
      })
      .mockResolvedValueOnce({
        response: diffResponse,
        raw: { exitCode: 0, stdout: "", stderr: "" },
      })
      // リトライも差分 → フォールバック
      .mockResolvedValueOnce({
        response: retryDiffAgain,
        raw: { exitCode: 0, stdout: "", stderr: "" },
      });

    mockCodex.reviewPlan.mockResolvedValue({
      response: "OK",
      raw: { exitCode: 0, stdout: "", stderr: "" },
    });

    mockJudgeReview.mockResolvedValue(makeJudgment(false));

    mockUi.promptPlanApproval.mockResolvedValueOnce({
      action: "modify",
      instruction: "追加して",
    });

    // フォールバック確認で n → 中止
    mockUi.confirmYesNo.mockResolvedValue(false);

    await runWorkflow(defaultOptions);

    // ワークフロー中止メッセージが表示されること
    expect(mockUi.display).toHaveBeenCalledWith(
      expect.stringContaining("中止"),
    );
    // コード生成に進んでいないこと
    expect(mockClaudeCode.generateCode).not.toHaveBeenCalled();
  });

  it("正当に短くなったプラン（パターン不一致かつ 30%以上）がリトライされずそのまま採用される", async () => {
    const initialPlan = "A".repeat(100);
    // 30%以上でパターン不一致 → リトライされない
    const shorterPlan = "B".repeat(40);

    mockClaudeCode.generatePlan
      .mockResolvedValueOnce({
        response: initialPlan,
        raw: { exitCode: 0, stdout: "", stderr: "" },
      })
      .mockResolvedValueOnce({
        response: shorterPlan,
        raw: { exitCode: 0, stdout: "", stderr: "" },
      });

    mockCodex.reviewPlan.mockResolvedValue({
      response: "OK",
      raw: { exitCode: 0, stdout: "", stderr: "" },
    });

    mockJudgeReview
      .mockResolvedValueOnce(makeJudgment(false))
      .mockResolvedValueOnce(makeJudgment(false))
      .mockResolvedValueOnce(makeJudgment(false));

    mockUi.promptPlanApproval
      .mockResolvedValueOnce({ action: "modify", instruction: "簡略化して" })
      .mockResolvedValueOnce({ action: "approve" });

    mockClaudeCode.generateCode.mockResolvedValue({
      response: "Code",
      raw: { exitCode: 0, stdout: "", stderr: "" },
    });
    mockCodex.reviewCode.mockResolvedValue({
      response: "LGTM",
      raw: { exitCode: 0, stdout: "", stderr: "" },
    });

    await runWorkflow(defaultOptions);

    // リトライなし（generatePlan は2回のみ: 初回 + ユーザー修正）
    expect(mockClaudeCode.generatePlan).toHaveBeenCalledTimes(2);
    // CODE_REVIEW に短縮されたプランが渡ること
    const codeReviewPrompt = mockCodex.reviewCode.mock.calls[0][0] as string;
    expect(codeReviewPrompt).toContain(shorterPlan);
  });

  it("プラン本文中に「変更点」を含むが先頭行でなければ全文と判定される", async () => {
    const initialPlan = "A".repeat(100);
    // 先頭行はパターン不一致、本文中に「変更点」あり
    const fullPlanWithKeyword = "# 実装計画\n\n## 変更点の概要\n詳細...\n" + "B".repeat(100);

    mockClaudeCode.generatePlan
      .mockResolvedValueOnce({
        response: initialPlan,
        raw: { exitCode: 0, stdout: "", stderr: "" },
      })
      .mockResolvedValueOnce({
        response: fullPlanWithKeyword,
        raw: { exitCode: 0, stdout: "", stderr: "" },
      });

    mockCodex.reviewPlan.mockResolvedValue({
      response: "OK",
      raw: { exitCode: 0, stdout: "", stderr: "" },
    });

    mockJudgeReview
      .mockResolvedValueOnce(makeJudgment(false))
      .mockResolvedValueOnce(makeJudgment(false))
      .mockResolvedValueOnce(makeJudgment(false));

    mockUi.promptPlanApproval
      .mockResolvedValueOnce({ action: "modify", instruction: "修正して" })
      .mockResolvedValueOnce({ action: "approve" });

    mockClaudeCode.generateCode.mockResolvedValue({
      response: "Code",
      raw: { exitCode: 0, stdout: "", stderr: "" },
    });
    mockCodex.reviewCode.mockResolvedValue({
      response: "LGTM",
      raw: { exitCode: 0, stdout: "", stderr: "" },
    });

    await runWorkflow(defaultOptions);

    // リトライなし
    expect(mockClaudeCode.generatePlan).toHaveBeenCalledTimes(2);
    // 全文がそのまま採用
    const codeReviewPrompt = mockCodex.reviewCode.mock.calls[0][0] as string;
    expect(codeReviewPrompt).toContain(fullPlanWithKeyword);
  });
});

describe("isDiffLikeResponse", () => {
  it("長さ30%未満で差分と判定", () => {
    expect(isDiffLikeResponse("短い", "A".repeat(100))).toBe(true);
  });

  it("先頭行が差分パターンに一致で差分と判定（長いレスポンスでも）", () => {
    const longDiff = "変更点は2つです\n" + "A".repeat(200);
    expect(isDiffLikeResponse(longDiff, "A".repeat(100))).toBe(true);
  });

  it("unified diff 形式 (@@単独) で差分と判定", () => {
    const diff = "以下の変更を適用:\n@@ -1,3 +1,4 @@\n line1\n+added\n line2";
    expect(isDiffLikeResponse(diff, "A".repeat(100))).toBe(true);
  });

  it("unified diff 形式 (---/+++ペア) で差分と判定", () => {
    const diff = "--- a/file.ts\n+++ b/file.ts\nsome context";
    expect(isDiffLikeResponse(diff, "A".repeat(100))).toBe(true);
  });

  it("fenced diff ブロックで差分と判定", () => {
    const diff = "```diff\n-old line\n+new line\n```\n" + "A".repeat(200);
    expect(isDiffLikeResponse(diff, "A".repeat(100))).toBe(true);
  });

  it("通常の箇条書き (-項目) は差分と誤検知しない", () => {
    const plan = "# 計画\n- 項目1\n- 項目2\n- 項目3\n- 項目4\n" + "A".repeat(100);
    expect(isDiffLikeResponse(plan, "A".repeat(100))).toBe(false);
  });

  it("全文出力は差分と判定しない", () => {
    expect(isDiffLikeResponse("A".repeat(100), "A".repeat(100))).toBe(false);
  });

  it("正当な短縮プラン (30%以上、パターン不一致) は差分と判定しない", () => {
    expect(isDiffLikeResponse("B".repeat(40), "A".repeat(100))).toBe(false);
  });

  it("本文中に「変更点」があっても先頭行でなければ全文と判定", () => {
    const plan = "# 実装計画\n\n## 変更点の概要\n詳細...\n" + "A".repeat(100);
    expect(isDiffLikeResponse(plan, "A".repeat(100))).toBe(false);
  });

  it("先頭行が「変更点の概要」のような見出しでは差分と判定しない", () => {
    const plan = "変更点の概要を以下にまとめます\n" + "A".repeat(200);
    expect(isDiffLikeResponse(plan, "A".repeat(100))).toBe(false);
  });

  it("basePlan が空なら常に false", () => {
    expect(isDiffLikeResponse("何か", "")).toBe(false);
  });
});
