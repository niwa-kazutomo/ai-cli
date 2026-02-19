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

import { runWorkflow } from "../src/orchestrator.js";
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
});
