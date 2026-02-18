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
    // process.exit のモック
    vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit called");
    }) as never);
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

    await expect(runWorkflow(defaultOptions)).rejects.toThrow("process.exit");
  });
});
