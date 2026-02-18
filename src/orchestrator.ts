import { createSession } from "./session.js";
import * as claudeCode from "./claude-code.js";
import * as codex from "./codex.js";
import { judgeReview } from "./review-judge.js";
import * as ui from "./user-interaction.js";
import { PROMPTS, MESSAGES } from "./constants.js";
import { validateCapabilities } from "./cli-runner.js";
import type { OrchestratorOptions, ReviewJudgment, SessionState } from "./types.js";
import * as logger from "./logger.js";

function formatConcerns(judgment: ReviewJudgment): string {
  if (judgment.concerns.length === 0) return "懸念事項なし";
  return judgment.concerns
    .map(
      (c, i) =>
        `${i + 1}. [${c.severity}] ${c.description}${c.suggestion ? `\n   提案: ${c.suggestion}` : ""}`,
    )
    .join("\n");
}

export async function runWorkflow(options: OrchestratorOptions): Promise<void> {
  const { prompt, maxPlanIterations, maxCodeIterations, dangerous, cwd } = options;

  // Step 0: Capability check
  ui.display("🔍 CLI の互換性をチェックしています...");
  const capError = await validateCapabilities(dangerous, cwd);
  if (capError) {
    logger.error(capError);
    process.exit(1);
  }
  ui.display("✅ CLI の互換性チェックに成功しました");

  const session = createSession();
  const claudeOpts = {
    cwd,
    model: options.claudeModel,
    dangerous,
  };
  const codexOpts = {
    cwd,
    model: options.codexModel,
  };

  // ===== Plan Phase =====
  ui.displaySeparator();
  ui.display("📝 Step 1: プラン生成を開始します...");
  logger.verbose("プロンプト", prompt);

  // Step 2: Generate plan
  const planPrompt = PROMPTS.PLAN_GENERATION(prompt);
  let planResult = await claudeCode.generatePlan(session, planPrompt, claudeOpts);
  let currentPlan = planResult.response;
  logger.verbose("生成されたプラン", currentPlan);

  // Plan review loop
  let planIteration = 0;
  let lastPlanJudgment: ReviewJudgment | null = null;
  let planReviewSummary = "";

  while (planIteration < maxPlanIterations) {
    planIteration++;
    ui.displaySeparator();
    ui.display(`🔎 Step 3: プランレビュー (${planIteration}/${maxPlanIterations})...`);

    // Step 3: Review plan with Codex
    const reviewPrompt =
      planIteration === 1
        ? PROMPTS.PLAN_REVIEW(currentPlan)
        : PROMPTS.PLAN_REVIEW_CONTINUATION(formatConcerns(lastPlanJudgment!));

    const reviewResult = await codex.reviewPlan(
      session,
      reviewPrompt,
      codexOpts,
      planIteration > 1 && !session.codexSessionId
        ? { planSummary: currentPlan.slice(0, 500), reviewSummary: planReviewSummary.slice(0, 500) }
        : undefined,
    );
    const reviewOutput = reviewResult.response;
    planReviewSummary = reviewOutput.slice(0, 500);
    logger.verbose("レビュー結果", reviewOutput);

    // Step 3.5: Judge review
    ui.display("⚖️ Step 3.5: レビュー判定中...");
    const judgment = await judgeReview(reviewOutput, {
      cwd,
      model: options.claudeModel,
    });
    lastPlanJudgment = judgment;

    ui.display(`\n📊 レビュー判定結果: ${judgment.summary}`);
    if (judgment.concerns.length > 0) {
      ui.display(`\n懸念事項:\n${formatConcerns(judgment)}`);
    }

    // Step 4: Check if P3+ concerns exist
    if (!judgment.has_p3_plus_concerns) {
      ui.display("✅ P3以上の懸念事項はありません。プランレビュー完了。");
      break;
    }

    // Check if we've hit the limit
    if (planIteration >= maxPlanIterations) {
      break;
    }

    // Step 4: Handle questions and revise plan
    let userAnswers = "";
    if (judgment.questions_for_user.length > 0) {
      userAnswers = await ui.askQuestions(judgment.questions_for_user);
    }

    ui.displaySeparator();
    ui.display("🔄 Step 4: プランを修正中...");
    const revisionPrompt = PROMPTS.PLAN_REVISION(
      formatConcerns(judgment),
      userAnswers || undefined,
    );
    planResult = await claudeCode.generatePlan(session, revisionPrompt, claudeOpts);
    currentPlan = planResult.response;
    logger.verbose("修正されたプラン", currentPlan);
  }

  // Step 5: Loop limit check
  if (
    lastPlanJudgment &&
    lastPlanJudgment.has_p3_plus_concerns &&
    planIteration >= maxPlanIterations
  ) {
    ui.displaySeparator();
    ui.display(MESSAGES.LOOP_LIMIT_WARNING("プラン", maxPlanIterations));
    ui.display(`\n残存懸念事項:\n${formatConcerns(lastPlanJudgment)}`);

    // Step 5.5: Confirm continuation
    const shouldContinue = await ui.confirmYesNo(MESSAGES.UNRESOLVED_CONCERNS_CONTINUE);
    if (!shouldContinue) {
      ui.display(MESSAGES.WORKFLOW_ABORTED);
      return;
    }
  }

  // Step 6: Present plan and get approval
  ui.displaySeparator();
  ui.display("📋 完成したプラン:");
  ui.displaySeparator();
  ui.display(currentPlan);
  ui.displaySeparator();

  const approved = await ui.confirmYesNo(MESSAGES.PLAN_APPROVE);
  if (!approved) {
    ui.display(MESSAGES.WORKFLOW_ABORTED);
    return;
  }

  // Step 6.5: Code generation confirmation
  const codeConfirmed = await ui.confirmYesNo(MESSAGES.CODE_GEN_CONFIRM);
  if (!codeConfirmed) {
    ui.display(MESSAGES.WORKFLOW_ABORTED);
    return;
  }

  // ===== Code Phase =====
  ui.displaySeparator();
  ui.display("💻 Step 7: コード生成を開始します...");

  // Step 7: Generate code
  const codePrompt = PROMPTS.CODE_GENERATION();
  const codeResult = await claudeCode.generateCode(session, codePrompt, claudeOpts);
  logger.verbose("コード生成結果", codeResult.response);

  // Code review loop
  let codeIteration = 0;
  let lastCodeJudgment: ReviewJudgment | null = null;

  while (codeIteration < maxCodeIterations) {
    codeIteration++;
    ui.displaySeparator();
    ui.display(`🔎 Step 8: コードレビュー (${codeIteration}/${maxCodeIterations})...`);

    // Step 8: Check Git repo and changes
    const isGitRepo = await codex.checkGitRepo(cwd);
    if (!isGitRepo) {
      logger.error(MESSAGES.NO_GIT_REPO);
      process.exit(1);
    }

    const hasChanges = await codex.checkGitChanges(cwd);
    if (!hasChanges) {
      logger.error(MESSAGES.NO_GIT_CHANGES);
      process.exit(1);
    }

    // Code review with Codex
    const codeReviewResult = await codex.reviewCode(codexOpts);
    const codeReviewOutput = codeReviewResult.response;
    logger.verbose("コードレビュー結果", codeReviewOutput);

    // Step 8.5: Judge code review
    ui.display("⚖️ Step 8.5: コードレビュー判定中...");
    const codeJudgment = await judgeReview(codeReviewOutput, {
      cwd,
      model: options.claudeModel,
    });
    lastCodeJudgment = codeJudgment;

    ui.display(`\n📊 コードレビュー判定結果: ${codeJudgment.summary}`);
    if (codeJudgment.concerns.length > 0) {
      ui.display(`\n懸念事項:\n${formatConcerns(codeJudgment)}`);
    }

    if (!codeJudgment.has_p3_plus_concerns) {
      ui.display("✅ P3以上の懸念事項はありません。コードレビュー完了。");
      break;
    }

    // Check if we've hit the limit
    if (codeIteration >= maxCodeIterations) {
      break;
    }

    // Step 9: Revise code
    ui.displaySeparator();
    ui.display("🔄 Step 9: コードを修正中...");
    const codeRevisionPrompt = PROMPTS.CODE_REVISION(formatConcerns(codeJudgment));
    await claudeCode.generateCode(session, codeRevisionPrompt, claudeOpts);
    logger.verbose("コード修正完了");
  }

  // Step 10: Loop limit check
  if (
    lastCodeJudgment &&
    lastCodeJudgment.has_p3_plus_concerns &&
    codeIteration >= maxCodeIterations
  ) {
    ui.displaySeparator();
    ui.display(MESSAGES.LOOP_LIMIT_WARNING("コード", maxCodeIterations));
    ui.display(`\n残存懸念事項:\n${formatConcerns(lastCodeJudgment)}`);

    // Step 10.5: Final confirmation
    const shouldFinish = await ui.confirmYesNo(MESSAGES.UNRESOLVED_CONCERNS_FINISH);
    if (!shouldFinish) {
      ui.display(MESSAGES.WORKFLOW_ABORTED);
      return;
    }
  }

  // Step 11: Complete
  ui.displaySeparator();
  ui.display(MESSAGES.WORKFLOW_COMPLETE);
}
