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

async function runWithProgress<T>(
  shouldStream: boolean,
  label: string,
  task: () => Promise<T>,
): Promise<T> {
  const progress = shouldStream ? null : ui.startProgress(label);
  try {
    const result = await task();
    progress?.stop(true);
    return result;
  } catch (err) {
    progress?.stop(false);
    throw err;
  }
}

export async function runWorkflow(options: OrchestratorOptions): Promise<void> {
  const { prompt, maxPlanIterations, maxCodeIterations, dangerous, cwd } = options;
  const shouldStream = options.verbose || options.debug;
  const stdoutCallback = shouldStream
    ? (chunk: string) => {
        process.stderr.write(chunk);
      }
    : undefined;
  const stderrCallback = shouldStream
    ? (chunk: string) => {
        process.stderr.write(chunk);
      }
    : undefined;

  // Step 0: Capability check
  ui.display("🔍 CLI の互換性をチェックしています...");
  const capError = await validateCapabilities(dangerous, cwd);
  if (capError) {
    throw new Error(capError);
  }
  ui.display("✅ CLI の互換性チェックに成功しました");

  const session = createSession();
  const claudeOpts = {
    cwd,
    model: options.claudeModel,
    dangerous,
    onStdout: stdoutCallback,
    onStderr: stderrCallback,
  };
  const codexOpts = {
    cwd,
    model: options.codexModel,
    onStdout: stdoutCallback,
    onStderr: stderrCallback,
  };

  // ===== Plan Phase =====
  ui.displaySeparator();
  ui.display("📝 Step 1: プラン生成を開始します...");
  logger.verbose("プロンプト", prompt);

  const planPrompt = PROMPTS.PLAN_GENERATION(prompt);
  let planResult = await runWithProgress(shouldStream, "プラン生成中...", () =>
    claudeCode.generatePlan(session, planPrompt, claudeOpts),
  );
  let currentPlan = planResult.response;
  logger.verbose("生成されたプラン", currentPlan);

  // 空プランのバリデーション
  if (!currentPlan.trim()) {
    throw new Error("プラン生成結果が空です。Claude Code からの応答が正しく取得できませんでした。");
  }

  // Plan review loop
  let planIteration = 0;
  let lastPlanJudgment: ReviewJudgment | null = null;
  let planReviewSummary = "";

  while (planIteration < maxPlanIterations) {
    planIteration++;
    ui.displaySeparator();
    ui.display(`🔎 Step 2: プランレビュー (${planIteration}/${maxPlanIterations})...`);

    const reviewPrompt: string =
      planIteration === 1
        ? PROMPTS.PLAN_REVIEW(currentPlan)
        : PROMPTS.PLAN_REVIEW_CONTINUATION(formatConcerns(lastPlanJudgment!));

    const reviewResult: Awaited<ReturnType<typeof codex.reviewPlan>> =
      await runWithProgress(shouldStream, "プランレビュー中...", () =>
        codex.reviewPlan(
          session,
          reviewPrompt,
          codexOpts,
          planIteration > 1 && !session.codexSessionId
            ? {
                planSummary: currentPlan.slice(0, 500),
                reviewSummary: planReviewSummary.slice(0, 500),
              }
            : undefined,
        ),
      );
    const reviewOutput: string = reviewResult.response;
    planReviewSummary = reviewOutput.slice(0, 500);
    logger.verbose("レビュー結果", reviewOutput);

    // Step 2.5: Judge review
    ui.display("⚖️ Step 2.5: レビュー判定中...");
    const judgment: ReviewJudgment = await runWithProgress(
      shouldStream,
      "レビュー判定中...",
      () =>
        judgeReview(reviewOutput, {
          cwd,
          model: options.claudeModel,
          onStdout: stdoutCallback,
          onStderr: stderrCallback,
        }),
    );
    lastPlanJudgment = judgment;

    ui.display(`\n📊 レビュー判定結果: ${judgment.summary}`);
    if (judgment.concerns.length > 0) {
      ui.display(`\n懸念事項:\n${formatConcerns(judgment)}`);
    }

    if (!judgment.has_p3_plus_concerns) {
      ui.display("✅ P3以上の懸念事項はありません。プランレビュー完了。");
      break;
    }

    // Check if we've hit the limit
    if (planIteration >= maxPlanIterations) {
      break;
    }

    // Handle questions and revise plan
    let userAnswers = "";
    if (judgment.questions_for_user.length > 0) {
      userAnswers = await ui.askQuestions(judgment.questions_for_user);
    }

    ui.displaySeparator();
    ui.display("🔄 Step 3: プランを修正中...");
    const revisionPrompt = PROMPTS.PLAN_REVISION(
      formatConcerns(judgment),
      userAnswers || undefined,
    );
    planResult = await runWithProgress(shouldStream, "プラン修正中...", () =>
      claudeCode.generatePlan(session, revisionPrompt, claudeOpts),
    );
    currentPlan = planResult.response;
    logger.verbose("修正されたプラン", currentPlan);

    // 修正後プランの空チェック
    if (!currentPlan.trim()) {
      throw new Error("プラン修正結果が空です。Claude Code からの応答が正しく取得できませんでした。");
    }
  }

  // Loop limit check
  if (
    lastPlanJudgment &&
    lastPlanJudgment.has_p3_plus_concerns &&
    planIteration >= maxPlanIterations
  ) {
    ui.displaySeparator();
    ui.display(MESSAGES.LOOP_LIMIT_WARNING("プラン", maxPlanIterations));
    ui.display(`\n残存懸念事項:\n${formatConcerns(lastPlanJudgment)}`);

    const shouldContinue = await ui.confirmYesNo(MESSAGES.UNRESOLVED_CONCERNS_CONTINUE);
    if (!shouldContinue) {
      ui.display(MESSAGES.WORKFLOW_ABORTED);
      return;
    }
  }

  // Present plan and get approval
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

  // Code generation confirmation
  const codeConfirmed = await ui.confirmYesNo(MESSAGES.CODE_GEN_CONFIRM);
  if (!codeConfirmed) {
    ui.display(MESSAGES.WORKFLOW_ABORTED);
    return;
  }

  // ===== Code Phase =====
  ui.displaySeparator();
  ui.display("💻 Step 4: コード生成を開始します...");

  const codePrompt = PROMPTS.CODE_GENERATION();
  const codeResult = await runWithProgress(shouldStream, "コード生成中...", () =>
    claudeCode.generateCode(session, codePrompt, claudeOpts),
  );
  logger.verbose("コード生成結果", codeResult.response);

  // Code review loop
  let codeIteration = 0;
  let lastCodeJudgment: ReviewJudgment | null = null;

  while (codeIteration < maxCodeIterations) {
    codeIteration++;
    ui.displaySeparator();
    ui.display(`🔎 Step 5: コードレビュー (${codeIteration}/${maxCodeIterations})...`);

    const isGitRepo = await codex.checkGitRepo(cwd);
    if (!isGitRepo) {
      throw new Error(MESSAGES.NO_GIT_REPO);
    }

    const hasChanges = await codex.checkGitChanges(cwd);
    if (!hasChanges) {
      throw new Error(MESSAGES.NO_GIT_CHANGES);
    }

    // Code review with Codex
    const codeReviewResult = await runWithProgress(shouldStream, "コードレビュー中...", () =>
      codex.reviewCode(codexOpts),
    );
    const codeReviewOutput = codeReviewResult.response;
    logger.verbose("コードレビュー結果", codeReviewOutput);

    // Step 5.5: Judge code review
    ui.display("⚖️ Step 5.5: コードレビュー判定中...");
    const codeJudgment = await runWithProgress(shouldStream, "コードレビュー判定中...", () =>
      judgeReview(codeReviewOutput, {
        cwd,
        model: options.claudeModel,
        onStdout: stdoutCallback,
        onStderr: stderrCallback,
      }),
    );
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

    // Step 6: Revise code
    ui.displaySeparator();
    ui.display("🔄 Step 6: コードを修正中...");
    const codeRevisionPrompt = PROMPTS.CODE_REVISION(formatConcerns(codeJudgment));
    await runWithProgress(shouldStream, "コード修正中...", () =>
      claudeCode.generateCode(session, codeRevisionPrompt, claudeOpts),
    );
    logger.verbose("コード修正完了");
  }

  // Loop limit check
  if (
    lastCodeJudgment &&
    lastCodeJudgment.has_p3_plus_concerns &&
    codeIteration >= maxCodeIterations
  ) {
    ui.displaySeparator();
    ui.display(MESSAGES.LOOP_LIMIT_WARNING("コード", maxCodeIterations));
    ui.display(`\n残存懸念事項:\n${formatConcerns(lastCodeJudgment)}`);

    const shouldFinish = await ui.confirmYesNo(MESSAGES.UNRESOLVED_CONCERNS_FINISH);
    if (!shouldFinish) {
      ui.display(MESSAGES.WORKFLOW_ABORTED);
      return;
    }
  }

  // Complete
  ui.displaySeparator();
  ui.display(MESSAGES.WORKFLOW_COMPLETE);
}
