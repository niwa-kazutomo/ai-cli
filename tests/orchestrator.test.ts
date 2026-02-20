import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock all external dependencies
vi.mock("../src/providers/factory.js", () => ({
  createProviders: vi.fn(),
  validateProviderCapabilities: vi.fn().mockResolvedValue(null),
  checkClaudeStreamingCapability: vi.fn().mockResolvedValue(false),
}));

vi.mock("../src/git-utils.js", () => ({
  checkGitRepo: vi.fn().mockResolvedValue(true),
  checkGitChanges: vi.fn().mockResolvedValue(true),
  getGitDiff: vi.fn().mockResolvedValue("mock diff content"),
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
import { createProviders, validateProviderCapabilities, checkClaudeStreamingCapability } from "../src/providers/factory.js";
import * as gitUtils from "../src/git-utils.js";
import * as ui from "../src/user-interaction.js";
import type { ReviewJudgment, OrchestratorOptions } from "../src/types.js";

const mockCreateProviders = vi.mocked(createProviders);
const mockValidateProviderCapabilities = vi.mocked(validateProviderCapabilities);
const mockCheckClaudeStreamingCapability = vi.mocked(checkClaudeStreamingCapability);
const mockGitUtils = vi.mocked(gitUtils);
const mockUi = vi.mocked(ui);

// Provider mocks (Generator / Reviewer / Judge interfaces)
const mockGenerator = {
  generatePlan: vi.fn(),
  generateCode: vi.fn(),
};
const mockReviewer = {
  reviewPlan: vi.fn(),
  reviewCode: vi.fn(),
};
const mockJudge = {
  judgeReview: vi.fn(),
};

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
    mockValidateProviderCapabilities.mockResolvedValue(null);
    mockCreateProviders.mockReturnValue({
      generator: mockGenerator,
      reviewer: mockReviewer,
      judge: mockJudge,
    });
    mockGitUtils.checkGitRepo.mockResolvedValue(true);
    mockGitUtils.checkGitChanges.mockResolvedValue(true);
    mockGitUtils.getGitDiff.mockResolvedValue("mock diff content");
    mockUi.startProgress.mockImplementation(() => ({ stop: vi.fn() }));
  });

  it("懸念なしでワークフローが正常完了する", async () => {
    // Plan generation
    mockGenerator.generatePlan.mockResolvedValue({
      response: "Generated plan",
      raw: { exitCode: 0, stdout: "", stderr: "" },
    });

    // Plan review
    mockReviewer.reviewPlan.mockResolvedValue({
      response: "Looks good",
      raw: { exitCode: 0, stdout: "", stderr: "" },
    });

    // Review judgment - no concerns
    mockJudge.judgeReview.mockResolvedValue(makeJudgment(false));

    // User approvals
    mockUi.promptPlanApproval.mockResolvedValue({ action: "approve" });

    // Code generation
    mockGenerator.generateCode.mockResolvedValue({
      response: "Generated code",
      raw: { exitCode: 0, stdout: "", stderr: "" },
    });

    // Code review
    mockReviewer.reviewCode.mockResolvedValue({
      response: "Code looks good",
      raw: { exitCode: 0, stdout: "", stderr: "" },
    });

    await runWorkflow(defaultOptions);

    expect(mockGenerator.generatePlan).toHaveBeenCalledTimes(1);
    expect(mockReviewer.reviewPlan).toHaveBeenCalledTimes(1);
    expect(mockJudge.judgeReview).toHaveBeenCalledTimes(2); // plan + code review
    expect(mockGenerator.generateCode).toHaveBeenCalledTimes(1);
    expect(mockReviewer.reviewCode).toHaveBeenCalledTimes(1);
  });

  it("ユーザーがプランを reject した場合にワークフローが中止される", async () => {
    mockGenerator.generatePlan.mockResolvedValue({
      response: "Generated plan",
      raw: { exitCode: 0, stdout: "", stderr: "" },
    });

    mockReviewer.reviewPlan.mockResolvedValue({
      response: "Looks good",
      raw: { exitCode: 0, stdout: "", stderr: "" },
    });

    mockJudge.judgeReview.mockResolvedValue(makeJudgment(false));

    // User aborts plan
    mockUi.promptPlanApproval.mockResolvedValue({ action: "abort" });

    await runWorkflow(defaultOptions);

    // Code generation should NOT have been called
    expect(mockGenerator.generateCode).not.toHaveBeenCalled();
    expect(mockUi.display).toHaveBeenCalledWith(
      expect.stringContaining("中止"),
    );
  });

  it("プランレビューループが上限に達する", async () => {
    const opts = { ...defaultOptions, maxPlanIterations: 2 };

    mockGenerator.generatePlan.mockResolvedValue({
      response: "Plan",
      raw: { exitCode: 0, stdout: "", stderr: "" },
    });

    mockReviewer.reviewPlan.mockResolvedValue({
      response: "Has issues",
      raw: { exitCode: 0, stdout: "", stderr: "" },
    });

    // Always return P3+ concerns
    mockJudge.judgeReview.mockResolvedValue(
      makeJudgment(true, [{ severity: "P2", description: "Issue" }]),
    );

    // User chooses not to continue after loop limit
    mockUi.confirmYesNo.mockResolvedValue(false);

    await runWorkflow(opts);

    // Should have iterated maxPlanIterations times
    expect(mockReviewer.reviewPlan).toHaveBeenCalledTimes(2);
    // Plan revision happens maxPlanIterations - 1 times (not on last iteration)
    expect(mockGenerator.generatePlan).toHaveBeenCalledTimes(2); // initial + 1 revision
    // Code generation should not have been called (user rejected)
    expect(mockGenerator.generateCode).not.toHaveBeenCalled();
  });

  it("プランレビューで修正→再レビューのフェーズ遷移が正しい", async () => {
    mockGenerator.generatePlan.mockResolvedValue({
      response: "Plan",
      raw: { exitCode: 0, stdout: "", stderr: "" },
    });

    mockReviewer.reviewPlan.mockResolvedValue({
      response: "Review",
      raw: { exitCode: 0, stdout: "", stderr: "" },
    });

    // First review: concerns, second: no concerns
    mockJudge.judgeReview
      .mockResolvedValueOnce(
        makeJudgment(true, [{ severity: "P2", description: "Fix this" }]),
      )
      .mockResolvedValueOnce(makeJudgment(false))
      // code review: no concerns
      .mockResolvedValueOnce(makeJudgment(false));

    mockUi.promptPlanApproval.mockResolvedValue({ action: "approve" });

    mockGenerator.generateCode.mockResolvedValue({
      response: "Code",
      raw: { exitCode: 0, stdout: "", stderr: "" },
    });

    mockReviewer.reviewCode.mockResolvedValue({
      response: "LGTM",
      raw: { exitCode: 0, stdout: "", stderr: "" },
    });

    await runWorkflow(defaultOptions);

    // Plan: initial + revision = 2 calls
    expect(mockGenerator.generatePlan).toHaveBeenCalledTimes(2);
    // Plan review: 2 rounds
    expect(mockReviewer.reviewPlan).toHaveBeenCalledTimes(2);
    // PLAN_REVISION プロンプトに currentPlan と「現在の計画」ヘッダが含まれること
    const revisionPrompt = mockGenerator.generatePlan.mock.calls[1][0] as string;
    expect(revisionPrompt).toContain("Plan");
    expect(revisionPrompt).toContain("現在の計画");
  });

  it("2回目のプランレビューに修正後プラン本文が含まれる", async () => {
    const revisedPlan = "Revised plan content";

    mockGenerator.generatePlan
      .mockResolvedValueOnce({
        response: "Initial plan",
        raw: { exitCode: 0, stdout: "", stderr: "" },
      })
      .mockResolvedValueOnce({
        response: revisedPlan,
        raw: { exitCode: 0, stdout: "", stderr: "" },
      });

    mockReviewer.reviewPlan.mockResolvedValue({
      response: "Review",
      raw: { exitCode: 0, stdout: "", stderr: "" },
    });

    // First review: concerns, second: no concerns
    mockJudge.judgeReview
      .mockResolvedValueOnce(
        makeJudgment(true, [{ severity: "P2", description: "Fix this" }]),
      )
      .mockResolvedValueOnce(makeJudgment(false))
      // code review: no concerns
      .mockResolvedValueOnce(makeJudgment(false));

    mockUi.promptPlanApproval.mockResolvedValue({ action: "approve" });

    mockGenerator.generateCode.mockResolvedValue({
      response: "Code",
      raw: { exitCode: 0, stdout: "", stderr: "" },
    });

    mockReviewer.reviewCode.mockResolvedValue({
      response: "LGTM",
      raw: { exitCode: 0, stdout: "", stderr: "" },
    });

    await runWorkflow(defaultOptions);

    // 2回目の reviewPlan の prompt 引数に修正後プラン本文が含まれること
    const secondReviewPrompt = mockReviewer.reviewPlan.mock.calls[1][0] as string;
    expect(secondReviewPrompt).toContain(revisedPlan);
    // 初回プランテキストではないことも確認
    expect(secondReviewPrompt).not.toContain("Initial plan");
  });

  it("初回プラン生成が空でエラー停止する", async () => {
    mockGenerator.generatePlan.mockResolvedValue({
      response: "",
      raw: { exitCode: 0, stdout: "", stderr: "" },
    });

    await expect(runWorkflow(defaultOptions)).rejects.toThrow("プラン生成結果が空です");

    // レビューやコード生成に進んでいないこと
    expect(mockReviewer.reviewPlan).not.toHaveBeenCalled();
    expect(mockGenerator.generateCode).not.toHaveBeenCalled();
  });

  it("初回プラン生成が空白のみでもエラー停止する", async () => {
    mockGenerator.generatePlan.mockResolvedValue({
      response: "   \n  \n  ",
      raw: { exitCode: 0, stdout: "", stderr: "" },
    });

    await expect(runWorkflow(defaultOptions)).rejects.toThrow("プラン生成結果が空です");
    expect(mockReviewer.reviewPlan).not.toHaveBeenCalled();
  });

  it("ループ内プラン修正後が空でエラー停止する", async () => {
    // 初回は正常なプランを返す
    mockGenerator.generatePlan
      .mockResolvedValueOnce({
        response: "Valid plan",
        raw: { exitCode: 0, stdout: "", stderr: "" },
      })
      // 修正後は空を返す
      .mockResolvedValueOnce({
        response: "",
        raw: { exitCode: 0, stdout: "", stderr: "" },
      });

    mockReviewer.reviewPlan.mockResolvedValue({
      response: "Has issues",
      raw: { exitCode: 0, stdout: "", stderr: "" },
    });

    // レビューで懸念あり → 修正フェーズに進む
    mockJudge.judgeReview.mockResolvedValue(
      makeJudgment(true, [{ severity: "P2", description: "Issue" }]),
    );

    await expect(runWorkflow(defaultOptions)).rejects.toThrow("プラン修正結果が空です");

    // 修正が呼ばれたこと（2回目のgeneratePlan）
    expect(mockGenerator.generatePlan).toHaveBeenCalledTimes(2);
    // コード生成には進んでいないこと
    expect(mockGenerator.generateCode).not.toHaveBeenCalled();
  });

  it("Git リポジトリ外でコードレビュー前にエラーで停止する", async () => {
    mockGenerator.generatePlan.mockResolvedValue({
      response: "Plan",
      raw: { exitCode: 0, stdout: "", stderr: "" },
    });

    mockReviewer.reviewPlan.mockResolvedValue({
      response: "OK",
      raw: { exitCode: 0, stdout: "", stderr: "" },
    });

    mockJudge.judgeReview.mockResolvedValue(makeJudgment(false));
    mockUi.promptPlanApproval.mockResolvedValue({ action: "approve" });

    mockGenerator.generateCode.mockResolvedValue({
      response: "Code",
      raw: { exitCode: 0, stdout: "", stderr: "" },
    });

    // Not a git repo
    mockGitUtils.checkGitRepo.mockResolvedValue(false);

    await expect(runWorkflow(defaultOptions)).rejects.toThrow("Git リポジトリ");
  });

  it("verbose=true かつ streaming 対応の場合 createProviders に streaming/canStreamClaude が渡される", async () => {
    const opts = { ...defaultOptions, verbose: true };
    mockCheckClaudeStreamingCapability.mockResolvedValue(true);

    mockGenerator.generatePlan.mockResolvedValue({
      response: "Generated plan",
      raw: { exitCode: 0, stdout: "", stderr: "" },
    });
    mockReviewer.reviewPlan.mockResolvedValue({
      response: "Looks good",
      raw: { exitCode: 0, stdout: "", stderr: "" },
    });
    mockJudge.judgeReview.mockResolvedValue(makeJudgment(false));
    mockUi.promptPlanApproval.mockResolvedValue({ action: "approve" });
    mockGenerator.generateCode.mockResolvedValue({
      response: "Generated code",
      raw: { exitCode: 0, stdout: "", stderr: "" },
    });
    mockReviewer.reviewCode.mockResolvedValue({
      response: "Code looks good",
      raw: { exitCode: 0, stdout: "", stderr: "" },
    });

    await runWorkflow(opts);

    expect(mockCreateProviders).toHaveBeenCalledWith(
      expect.objectContaining({
        streaming: true,
        canStreamClaude: true,
        onStdout: expect.any(Function),
        onStderr: expect.any(Function),
      }),
    );
  });

  it("verbose=false かつ debug=false の場合は onStdout/onStderr が undefined で渡される", async () => {
    mockGenerator.generatePlan.mockResolvedValue({
      response: "Generated plan",
      raw: { exitCode: 0, stdout: "", stderr: "" },
    });
    mockReviewer.reviewPlan.mockResolvedValue({
      response: "Looks good",
      raw: { exitCode: 0, stdout: "", stderr: "" },
    });
    mockJudge.judgeReview.mockResolvedValue(makeJudgment(false));
    mockUi.promptPlanApproval.mockResolvedValue({ action: "approve" });
    mockGenerator.generateCode.mockResolvedValue({
      response: "Generated code",
      raw: { exitCode: 0, stdout: "", stderr: "" },
    });
    mockReviewer.reviewCode.mockResolvedValue({
      response: "Code looks good",
      raw: { exitCode: 0, stdout: "", stderr: "" },
    });

    await runWorkflow(defaultOptions);

    expect(mockCreateProviders).toHaveBeenCalledWith(
      expect.objectContaining({
        streaming: false,
        onStdout: undefined,
        onStderr: undefined,
      }),
    );
  });

  it("debug=true かつ streaming 対応で createProviders に正しく渡される", async () => {
    const opts = { ...defaultOptions, verbose: false, debug: true };
    mockCheckClaudeStreamingCapability.mockResolvedValue(true);

    mockGenerator.generatePlan.mockResolvedValue({
      response: "Generated plan",
      raw: { exitCode: 0, stdout: "", stderr: "" },
    });
    mockReviewer.reviewPlan.mockResolvedValue({
      response: "Looks good",
      raw: { exitCode: 0, stdout: "", stderr: "" },
    });
    mockJudge.judgeReview.mockResolvedValue(makeJudgment(false));
    mockUi.promptPlanApproval.mockResolvedValue({ action: "approve" });
    mockGenerator.generateCode.mockResolvedValue({
      response: "Generated code",
      raw: { exitCode: 0, stdout: "", stderr: "" },
    });
    mockReviewer.reviewCode.mockResolvedValue({
      response: "Code looks good",
      raw: { exitCode: 0, stdout: "", stderr: "" },
    });

    await runWorkflow(opts);

    expect(mockCreateProviders).toHaveBeenCalledWith(
      expect.objectContaining({
        streaming: true,
        canStreamClaude: true,
        onStdout: expect.any(Function),
        onStderr: expect.any(Function),
      }),
    );
  });

  it("通常モードでは startProgress が呼ばれ、成功時に stop(true) が呼ばれる", async () => {
    const stopFns: Array<ReturnType<typeof vi.fn>> = [];
    mockUi.startProgress.mockImplementation(() => {
      const stop = vi.fn();
      stopFns.push(stop);
      return { stop };
    });

    mockGenerator.generatePlan.mockResolvedValue({
      response: "Generated plan",
      raw: { exitCode: 0, stdout: "", stderr: "" },
    });
    mockReviewer.reviewPlan.mockResolvedValue({
      response: "Looks good",
      raw: { exitCode: 0, stdout: "", stderr: "" },
    });
    mockJudge.judgeReview.mockResolvedValue(makeJudgment(false));
    mockUi.promptPlanApproval.mockResolvedValue({ action: "approve" });
    mockGenerator.generateCode.mockResolvedValue({
      response: "Generated code",
      raw: { exitCode: 0, stdout: "", stderr: "" },
    });
    mockReviewer.reviewCode.mockResolvedValue({
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
    mockGenerator.generatePlan.mockRejectedValue(new Error("boom"));

    await expect(runWorkflow(defaultOptions)).rejects.toThrow("boom");

    expect(stop).toHaveBeenCalledWith(false);
  });

  it("checkClaudeStreamingCapability が false を返す場合、canStreamClaude が false で渡される", async () => {
    const opts = { ...defaultOptions, verbose: true };
    mockCheckClaudeStreamingCapability.mockResolvedValue(false);

    mockGenerator.generatePlan.mockResolvedValue({
      response: "Generated plan",
      raw: { exitCode: 0, stdout: "", stderr: "" },
    });
    mockReviewer.reviewPlan.mockResolvedValue({
      response: "Looks good",
      raw: { exitCode: 0, stdout: "", stderr: "" },
    });
    mockJudge.judgeReview.mockResolvedValue(makeJudgment(false));
    mockUi.promptPlanApproval.mockResolvedValue({ action: "approve" });
    mockGenerator.generateCode.mockResolvedValue({
      response: "Generated code",
      raw: { exitCode: 0, stdout: "", stderr: "" },
    });
    mockReviewer.reviewCode.mockResolvedValue({
      response: "Code looks good",
      raw: { exitCode: 0, stdout: "", stderr: "" },
    });

    await runWorkflow(opts);

    expect(mockCreateProviders).toHaveBeenCalledWith(
      expect.objectContaining({
        streaming: true,
        canStreamClaude: false,
      }),
    );
  });

  it("コードレビューで getGitDiff → CODE_REVIEW プロンプト → reviewCode(prompt) の連携が正しい", async () => {
    const planText = "Test plan content";
    const diffText = "diff --git a/file.ts";

    mockGenerator.generatePlan.mockResolvedValue({
      response: planText,
      raw: { exitCode: 0, stdout: "", stderr: "" },
    });
    mockReviewer.reviewPlan.mockResolvedValue({
      response: "Looks good",
      raw: { exitCode: 0, stdout: "", stderr: "" },
    });
    mockJudge.judgeReview.mockResolvedValue(makeJudgment(false));
    mockUi.promptPlanApproval.mockResolvedValue({ action: "approve" });
    mockGenerator.generateCode.mockResolvedValue({
      response: "Generated code",
      raw: { exitCode: 0, stdout: "", stderr: "" },
    });
    mockGitUtils.getGitDiff.mockResolvedValue(diffText);
    mockReviewer.reviewCode.mockResolvedValue({
      response: "Code looks good",
      raw: { exitCode: 0, stdout: "", stderr: "" },
    });

    await runWorkflow(defaultOptions);

    // getGitDiff が cwd で呼ばれること
    expect(mockGitUtils.getGitDiff).toHaveBeenCalledWith(defaultOptions.cwd);
    // reviewCode の第1引数がプランと diff を含むプロンプトであること
    const reviewPrompt = mockReviewer.reviewCode.mock.calls[0][0] as string;
    expect(reviewPrompt).toContain(planText);
    expect(reviewPrompt).toContain(diffText);
  });

  it("getGitDiff が空文字を返した場合にエラーで停止する", async () => {
    mockGenerator.generatePlan.mockResolvedValue({
      response: "Plan",
      raw: { exitCode: 0, stdout: "", stderr: "" },
    });
    mockReviewer.reviewPlan.mockResolvedValue({
      response: "OK",
      raw: { exitCode: 0, stdout: "", stderr: "" },
    });
    mockJudge.judgeReview.mockResolvedValue(makeJudgment(false));
    mockUi.promptPlanApproval.mockResolvedValue({ action: "approve" });
    mockGenerator.generateCode.mockResolvedValue({
      response: "Code",
      raw: { exitCode: 0, stdout: "", stderr: "" },
    });
    mockGitUtils.getGitDiff.mockResolvedValue("");

    await expect(runWorkflow(defaultOptions)).rejects.toThrow("差分の取得に失敗しました");
    expect(mockReviewer.reviewCode).not.toHaveBeenCalled();
  });

  it("ユーザー修正指示 → 再レビュー → 承認でワークフローが完了する", async () => {
    mockGenerator.generatePlan
      .mockResolvedValueOnce({
        response: "Initial plan",
        raw: { exitCode: 0, stdout: "", stderr: "" },
      })
      // User revision
      .mockResolvedValueOnce({
        response: "User-revised plan",
        raw: { exitCode: 0, stdout: "", stderr: "" },
      });

    mockReviewer.reviewPlan.mockResolvedValue({
      response: "Looks good",
      raw: { exitCode: 0, stdout: "", stderr: "" },
    });

    // Both plan reviews pass (initial + re-review after user revision)
    mockJudge.judgeReview
      .mockResolvedValueOnce(makeJudgment(false))
      .mockResolvedValueOnce(makeJudgment(false))
      // code review
      .mockResolvedValueOnce(makeJudgment(false));

    // First: modify, second: approve
    mockUi.promptPlanApproval
      .mockResolvedValueOnce({ action: "modify", instruction: "エラーハンドリングを追加して" })
      .mockResolvedValueOnce({ action: "approve" });

    mockGenerator.generateCode.mockResolvedValue({
      response: "Code",
      raw: { exitCode: 0, stdout: "", stderr: "" },
    });
    mockReviewer.reviewCode.mockResolvedValue({
      response: "LGTM",
      raw: { exitCode: 0, stdout: "", stderr: "" },
    });

    await runWorkflow(defaultOptions);

    // generatePlan: initial + user revision = 2
    expect(mockGenerator.generatePlan).toHaveBeenCalledTimes(2);
    // reviewPlan: initial review + re-review after user revision = 2
    expect(mockReviewer.reviewPlan).toHaveBeenCalledTimes(2);
    // Code generation proceeded
    expect(mockGenerator.generateCode).toHaveBeenCalledTimes(1);
  });

  it("修正指示のテキストが PLAN_USER_REVISION テンプレート経由で generatePlan に渡される", async () => {
    const userInstruction = "テスト追加してください";

    mockGenerator.generatePlan
      .mockResolvedValueOnce({
        response: "Initial plan",
        raw: { exitCode: 0, stdout: "", stderr: "" },
      })
      .mockResolvedValueOnce({
        response: "Revised plan",
        raw: { exitCode: 0, stdout: "", stderr: "" },
      });

    mockReviewer.reviewPlan.mockResolvedValue({
      response: "OK",
      raw: { exitCode: 0, stdout: "", stderr: "" },
    });

    mockJudge.judgeReview
      .mockResolvedValueOnce(makeJudgment(false))
      .mockResolvedValueOnce(makeJudgment(false))
      .mockResolvedValueOnce(makeJudgment(false));

    mockUi.promptPlanApproval
      .mockResolvedValueOnce({ action: "modify", instruction: userInstruction })
      .mockResolvedValueOnce({ action: "approve" });

    mockGenerator.generateCode.mockResolvedValue({
      response: "Code",
      raw: { exitCode: 0, stdout: "", stderr: "" },
    });
    mockReviewer.reviewCode.mockResolvedValue({
      response: "LGTM",
      raw: { exitCode: 0, stdout: "", stderr: "" },
    });

    await runWorkflow(defaultOptions);

    // 2回目の generatePlan に PLAN_USER_REVISION テンプレートの内容が含まれること
    const revisionPrompt = mockGenerator.generatePlan.mock.calls[1][0] as string;
    expect(revisionPrompt).toContain(userInstruction);
    expect(revisionPrompt).toContain("ユーザーの修正指示");
    // currentPlan テキストと「現在の計画」ヘッダが含まれること
    expect(revisionPrompt).toContain("Initial plan");
    expect(revisionPrompt).toContain("現在の計画");
  });

  it("ユーザー修正指示後のプランが空の場合エラーで停止する", async () => {
    mockGenerator.generatePlan
      .mockResolvedValueOnce({
        response: "Initial plan",
        raw: { exitCode: 0, stdout: "", stderr: "" },
      })
      .mockResolvedValueOnce({
        response: "",
        raw: { exitCode: 0, stdout: "", stderr: "" },
      });

    mockReviewer.reviewPlan.mockResolvedValue({
      response: "OK",
      raw: { exitCode: 0, stdout: "", stderr: "" },
    });

    mockJudge.judgeReview.mockResolvedValue(makeJudgment(false));

    mockUi.promptPlanApproval.mockResolvedValueOnce({
      action: "modify",
      instruction: "修正してください",
    });

    await expect(runWorkflow(defaultOptions)).rejects.toThrow("プラン修正結果が空です");

    expect(mockGenerator.generateCode).not.toHaveBeenCalled();
  });

  it("差分出力時にリトライが発生し、リトライプロンプトに必要な情報が含まれる", async () => {
    const initialPlan = "A".repeat(200);
    const diffResponse = "変更点は以下の通りです\n- 項目追加";
    const retryFullPlan = "A".repeat(200) + "\n- 追加項目";

    mockGenerator.generatePlan
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

    mockReviewer.reviewPlan.mockResolvedValue({
      response: "OK",
      raw: { exitCode: 0, stdout: "", stderr: "" },
    });

    mockJudge.judgeReview
      .mockResolvedValueOnce(makeJudgment(false))
      // re-review after user revision
      .mockResolvedValueOnce(makeJudgment(false))
      // code review
      .mockResolvedValueOnce(makeJudgment(false));

    mockUi.promptPlanApproval
      .mockResolvedValueOnce({ action: "modify", instruction: "項目を追加して" })
      .mockResolvedValueOnce({ action: "approve" });

    mockGenerator.generateCode.mockResolvedValue({
      response: "Code",
      raw: { exitCode: 0, stdout: "", stderr: "" },
    });
    mockReviewer.reviewCode.mockResolvedValue({
      response: "LGTM",
      raw: { exitCode: 0, stdout: "", stderr: "" },
    });

    await runWorkflow(defaultOptions);

    // リトライが発生（3回目の generatePlan）
    expect(mockGenerator.generatePlan).toHaveBeenCalledTimes(3);
    // リトライプロンプトに lastKnownFullPlan と差分出力と修正要求が含まれること
    const retryPrompt = mockGenerator.generatePlan.mock.calls[2][0] as string;
    expect(retryPrompt).toContain(initialPlan);
    expect(retryPrompt).toContain("項目を追加して");
    expect(retryPrompt).toContain("ベースとなる計画");
    expect(retryPrompt).toContain("先ほどの修正出力");
  });

  it("リトライ成功で全文が currentPlan になり、CODE_REVIEW に全文が渡る", async () => {
    const initialPlan = "A".repeat(200);
    const diffResponse = "変更点: エラー処理追加";
    const retryFullPlan = "A".repeat(200) + "\nエラー処理追加";

    mockGenerator.generatePlan
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

    mockReviewer.reviewPlan.mockResolvedValue({
      response: "OK",
      raw: { exitCode: 0, stdout: "", stderr: "" },
    });

    mockJudge.judgeReview
      .mockResolvedValueOnce(makeJudgment(false))
      .mockResolvedValueOnce(makeJudgment(false))
      .mockResolvedValueOnce(makeJudgment(false));

    mockUi.promptPlanApproval
      .mockResolvedValueOnce({ action: "modify", instruction: "エラー処理追加" })
      .mockResolvedValueOnce({ action: "approve" });

    mockGenerator.generateCode.mockResolvedValue({
      response: "Code",
      raw: { exitCode: 0, stdout: "", stderr: "" },
    });
    mockReviewer.reviewCode.mockResolvedValue({
      response: "LGTM",
      raw: { exitCode: 0, stdout: "", stderr: "" },
    });

    await runWorkflow(defaultOptions);

    // CODE_REVIEW プロンプトにリトライ後の全文が渡ること
    const codeReviewPrompt = mockReviewer.reviewCode.mock.calls[0][0] as string;
    expect(codeReviewPrompt).toContain(retryFullPlan);
  });

  it("リトライ失敗時に lastKnownFullPlan にフォールバック + 警告表示", async () => {
    const initialPlan = "A".repeat(200);
    const diffResponse = "変更点: 追加";
    const retryDiffAgain = "まだ差分です";

    mockGenerator.generatePlan
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

    mockReviewer.reviewPlan.mockResolvedValue({
      response: "OK",
      raw: { exitCode: 0, stdout: "", stderr: "" },
    });

    mockJudge.judgeReview
      .mockResolvedValueOnce(makeJudgment(false))
      .mockResolvedValueOnce(makeJudgment(false))
      .mockResolvedValueOnce(makeJudgment(false));

    mockUi.promptPlanApproval
      .mockResolvedValueOnce({ action: "modify", instruction: "追加して" })
      .mockResolvedValueOnce({ action: "approve" });

    // フォールバック時の続行確認
    mockUi.confirmYesNo.mockResolvedValue(true);

    mockGenerator.generateCode.mockResolvedValue({
      response: "Code",
      raw: { exitCode: 0, stdout: "", stderr: "" },
    });
    mockReviewer.reviewCode.mockResolvedValue({
      response: "LGTM",
      raw: { exitCode: 0, stdout: "", stderr: "" },
    });

    await runWorkflow(defaultOptions);

    // 警告が表示されること
    expect(mockUi.display).toHaveBeenCalledWith(
      expect.stringContaining("修正指示が反映されていない可能性があります"),
    );
    // CODE_REVIEW に初回全文プランが渡ること（フォールバック）
    const codeReviewPrompt = mockReviewer.reviewCode.mock.calls[0][0] as string;
    expect(codeReviewPrompt).toContain(initialPlan);
  });

  it("リトライ API が throw した場合に lastKnownFullPlan にフォールバック + 警告表示", async () => {
    const initialPlan = "A".repeat(200);
    const diffResponse = "変更点: 追加";

    mockGenerator.generatePlan
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

    mockReviewer.reviewPlan.mockResolvedValue({
      response: "OK",
      raw: { exitCode: 0, stdout: "", stderr: "" },
    });

    mockJudge.judgeReview
      .mockResolvedValueOnce(makeJudgment(false))
      .mockResolvedValueOnce(makeJudgment(false))
      .mockResolvedValueOnce(makeJudgment(false));

    mockUi.promptPlanApproval
      .mockResolvedValueOnce({ action: "modify", instruction: "追加して" })
      .mockResolvedValueOnce({ action: "approve" });

    mockUi.confirmYesNo.mockResolvedValue(true);

    mockGenerator.generateCode.mockResolvedValue({
      response: "Code",
      raw: { exitCode: 0, stdout: "", stderr: "" },
    });
    mockReviewer.reviewCode.mockResolvedValue({
      response: "LGTM",
      raw: { exitCode: 0, stdout: "", stderr: "" },
    });

    await runWorkflow(defaultOptions);

    // フォールバック警告
    expect(mockUi.display).toHaveBeenCalledWith(
      expect.stringContaining("全文再取得に失敗しました"),
    );
    // CODE_REVIEW に初回プランが渡ること
    const codeReviewPrompt = mockReviewer.reviewCode.mock.calls[0][0] as string;
    expect(codeReviewPrompt).toContain(initialPlan);
  });

  it("フォールバック確認で n を選んだ場合にワークフローが中止される", async () => {
    const initialPlan = "A".repeat(200);
    const diffResponse = "変更点: 追加";
    const retryDiffAgain = "まだ差分";

    mockGenerator.generatePlan
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

    mockReviewer.reviewPlan.mockResolvedValue({
      response: "OK",
      raw: { exitCode: 0, stdout: "", stderr: "" },
    });

    mockJudge.judgeReview.mockResolvedValue(makeJudgment(false));

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
    expect(mockGenerator.generateCode).not.toHaveBeenCalled();
  });

  it("正当に短くなったプラン（パターン不一致かつ 30%以上）がリトライされずそのまま採用される", async () => {
    const initialPlan = "A".repeat(100);
    // 30%以上でパターン不一致 → リトライされない
    const shorterPlan = "B".repeat(40);

    mockGenerator.generatePlan
      .mockResolvedValueOnce({
        response: initialPlan,
        raw: { exitCode: 0, stdout: "", stderr: "" },
      })
      .mockResolvedValueOnce({
        response: shorterPlan,
        raw: { exitCode: 0, stdout: "", stderr: "" },
      });

    mockReviewer.reviewPlan.mockResolvedValue({
      response: "OK",
      raw: { exitCode: 0, stdout: "", stderr: "" },
    });

    mockJudge.judgeReview
      .mockResolvedValueOnce(makeJudgment(false))
      .mockResolvedValueOnce(makeJudgment(false))
      .mockResolvedValueOnce(makeJudgment(false));

    mockUi.promptPlanApproval
      .mockResolvedValueOnce({ action: "modify", instruction: "簡略化して" })
      .mockResolvedValueOnce({ action: "approve" });

    mockGenerator.generateCode.mockResolvedValue({
      response: "Code",
      raw: { exitCode: 0, stdout: "", stderr: "" },
    });
    mockReviewer.reviewCode.mockResolvedValue({
      response: "LGTM",
      raw: { exitCode: 0, stdout: "", stderr: "" },
    });

    await runWorkflow(defaultOptions);

    // リトライなし（generatePlan は2回のみ: 初回 + ユーザー修正）
    expect(mockGenerator.generatePlan).toHaveBeenCalledTimes(2);
    // CODE_REVIEW に短縮されたプランが渡ること
    const codeReviewPrompt = mockReviewer.reviewCode.mock.calls[0][0] as string;
    expect(codeReviewPrompt).toContain(shorterPlan);
  });

  it("validateProviderCapabilities がエラーを返す場合、createProviders を呼ばずに throw する", async () => {
    mockValidateProviderCapabilities.mockResolvedValue(
      "CLI の互換性チェックに失敗しました:\nclaude: 以下のフラグが非対応です: --resume",
    );

    await expect(runWorkflow(defaultOptions)).rejects.toThrow("互換性チェックに失敗しました");

    expect(mockCreateProviders).not.toHaveBeenCalled();
    expect(mockGenerator.generatePlan).not.toHaveBeenCalled();
  });

  it("codexSandbox オプションが createProviders に渡される", async () => {
    const opts = { ...defaultOptions, codexSandbox: "read-only" as const };

    mockGenerator.generatePlan.mockResolvedValue({
      response: "Plan",
      raw: { exitCode: 0, stdout: "", stderr: "" },
    });
    mockReviewer.reviewPlan.mockResolvedValue({
      response: "OK",
      raw: { exitCode: 0, stdout: "", stderr: "" },
    });
    mockJudge.judgeReview.mockResolvedValue(makeJudgment(false));
    mockUi.promptPlanApproval.mockResolvedValue({ action: "approve" });
    mockGenerator.generateCode.mockResolvedValue({
      response: "Code",
      raw: { exitCode: 0, stdout: "", stderr: "" },
    });
    mockReviewer.reviewCode.mockResolvedValue({
      response: "LGTM",
      raw: { exitCode: 0, stdout: "", stderr: "" },
    });

    await runWorkflow(opts);

    expect(mockCreateProviders).toHaveBeenCalledWith(
      expect.objectContaining({ codexSandbox: "read-only" }),
    );
  });

  it("CLI 選択が validateProviderCapabilities に渡される", async () => {
    const opts = {
      ...defaultOptions,
      generatorCli: "codex" as const,
      reviewerCli: "claude" as const,
      judgeCli: "codex" as const,
    };

    mockGenerator.generatePlan.mockResolvedValue({
      response: "Plan",
      raw: { exitCode: 0, stdout: "", stderr: "" },
    });
    mockReviewer.reviewPlan.mockResolvedValue({
      response: "OK",
      raw: { exitCode: 0, stdout: "", stderr: "" },
    });
    mockJudge.judgeReview.mockResolvedValue(makeJudgment(false));
    mockUi.promptPlanApproval.mockResolvedValue({ action: "approve" });
    mockGenerator.generateCode.mockResolvedValue({
      response: "Code",
      raw: { exitCode: 0, stdout: "", stderr: "" },
    });
    mockReviewer.reviewCode.mockResolvedValue({
      response: "LGTM",
      raw: { exitCode: 0, stdout: "", stderr: "" },
    });

    await runWorkflow(opts);

    expect(mockValidateProviderCapabilities).toHaveBeenCalledWith(
      false,
      "/tmp",
      expect.objectContaining({
        generatorCli: "codex",
        reviewerCli: "claude",
        judgeCli: "codex",
      }),
    );
  });

  it("CLI 選択が createProviders に渡される", async () => {
    const opts = {
      ...defaultOptions,
      generatorCli: "codex" as const,
      reviewerCli: "claude" as const,
    };

    mockGenerator.generatePlan.mockResolvedValue({
      response: "Plan",
      raw: { exitCode: 0, stdout: "", stderr: "" },
    });
    mockReviewer.reviewPlan.mockResolvedValue({
      response: "OK",
      raw: { exitCode: 0, stdout: "", stderr: "" },
    });
    mockJudge.judgeReview.mockResolvedValue(makeJudgment(false));
    mockUi.promptPlanApproval.mockResolvedValue({ action: "approve" });
    mockGenerator.generateCode.mockResolvedValue({
      response: "Code",
      raw: { exitCode: 0, stdout: "", stderr: "" },
    });
    mockReviewer.reviewCode.mockResolvedValue({
      response: "LGTM",
      raw: { exitCode: 0, stdout: "", stderr: "" },
    });

    await runWorkflow(opts);

    expect(mockCreateProviders).toHaveBeenCalledWith(
      expect.objectContaining({
        generatorCli: "codex",
        reviewerCli: "claude",
      }),
    );
  });

  it("全 codex 構成で canStreamClaude チェックがスキップされる", async () => {
    const opts = {
      ...defaultOptions,
      verbose: true,
      generatorCli: "codex" as const,
      reviewerCli: "codex" as const,
      judgeCli: "codex" as const,
    };

    mockGenerator.generatePlan.mockResolvedValue({
      response: "Plan",
      raw: { exitCode: 0, stdout: "", stderr: "" },
    });
    mockReviewer.reviewPlan.mockResolvedValue({
      response: "OK",
      raw: { exitCode: 0, stdout: "", stderr: "" },
    });
    mockJudge.judgeReview.mockResolvedValue(makeJudgment(false));
    mockUi.promptPlanApproval.mockResolvedValue({ action: "approve" });
    mockGenerator.generateCode.mockResolvedValue({
      response: "Code",
      raw: { exitCode: 0, stdout: "", stderr: "" },
    });
    mockReviewer.reviewCode.mockResolvedValue({
      response: "LGTM",
      raw: { exitCode: 0, stdout: "", stderr: "" },
    });

    await runWorkflow(opts);

    // Claude streaming check がスキップされること
    expect(mockCheckClaudeStreamingCapability).not.toHaveBeenCalled();
  });

  it("fallbackContext が常に渡される（2回目以降のレビュー時）", async () => {
    mockGenerator.generatePlan.mockResolvedValue({
      response: "Plan",
      raw: { exitCode: 0, stdout: "", stderr: "" },
    });

    mockReviewer.reviewPlan.mockResolvedValue({
      response: "Review",
      raw: { exitCode: 0, stdout: "", stderr: "" },
    });

    // First review: concerns, second: no concerns
    mockJudge.judgeReview
      .mockResolvedValueOnce(
        makeJudgment(true, [{ severity: "P2", description: "Fix this" }]),
      )
      .mockResolvedValueOnce(makeJudgment(false))
      .mockResolvedValueOnce(makeJudgment(false));

    mockUi.promptPlanApproval.mockResolvedValue({ action: "approve" });

    mockGenerator.generateCode.mockResolvedValue({
      response: "Code",
      raw: { exitCode: 0, stdout: "", stderr: "" },
    });

    mockReviewer.reviewCode.mockResolvedValue({
      response: "LGTM",
      raw: { exitCode: 0, stdout: "", stderr: "" },
    });

    await runWorkflow(defaultOptions);

    // 初回: fallbackContext は undefined
    expect(mockReviewer.reviewPlan.mock.calls[0][1]).toBeUndefined();
    // 2回目: fallbackContext が渡される
    expect(mockReviewer.reviewPlan.mock.calls[1][1]).toEqual(
      expect.objectContaining({
        planSummary: expect.any(String),
        reviewSummary: expect.any(String),
      }),
    );
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

  it("結語先頭パターン（「以上が修正後の...全文です」）で差分と判定", () => {
    const suffix = "---\n\n以上が修正後の計画全文です。レビュー指摘への対応まとめ:\n" + "A".repeat(200);
    expect(isDiffLikeResponse(suffix, "A".repeat(200))).toBe(true);
  });

  it("結語先頭パターン（「上記が反映...プラン全文」）で差分と判定", () => {
    const suffix = "---\n上記が反映済みのプラン全文です。";
    expect(isDiffLikeResponse(suffix, "A".repeat(200))).toBe(true);
  });

  it("結語先頭パターン（「以上が変更後...」）で差分と判定", () => {
    const suffix = "以上が変更後の計画です。\nレビュー指摘への対応まとめ:";
    expect(isDiffLikeResponse(suffix, "A".repeat(200))).toBe(true);
  });

  it("---で始まるが結語フレーズがない通常の計画は差分と判定しない", () => {
    const plan = "---\n# Implementation Plan\nStep 1: Do something\n" + "A".repeat(200);
    expect(isDiffLikeResponse(plan, "A".repeat(200))).toBe(false);
  });

  it("front matter (---のみ) の正当な計画を差分と判定しない", () => {
    const plan = "---\ntitle: Plan\n---\n# 計画\n以上が" + "A".repeat(200);
    expect(isDiffLikeResponse(plan, "A".repeat(200))).toBe(false);
  });

  it("先頭に「以上が」を含むが結語語彙がない通常本文は差分と判定しない", () => {
    const plan = "以上が前提条件です。以下に手順を示します。\n## Step 1\n" + "A".repeat(200);
    expect(isDiffLikeResponse(plan, "A".repeat(200))).toBe(false);
  });

  it("先頭に「以上が計画の背景です」のような正当な本文冒頭は差分と判定しない", () => {
    const plan = "以上が計画の背景です。以下に詳細を示します。\n## Step 1\n" + "A".repeat(200);
    expect(isDiffLikeResponse(plan, "A".repeat(200))).toBe(false);
  });
});
