import { createProviders, validateProviderCapabilities, checkClaudeStreamingCapability } from "./providers/factory.js";
import type { Generator, Reviewer, Judge } from "./providers/types.js";
import { checkGitRepo, checkGitChanges, getGitDiff } from "./git-utils.js";
import * as ui from "./user-interaction.js";
import { PROMPTS, MESSAGES } from "./constants.js";
import type { OrchestratorOptions, PlanApprovalResult, ReviewJudgment } from "./types.js";
import * as logger from "./logger.js";

export function isDiffLikeResponse(response: string, basePlan: string): boolean {
  if (!basePlan) return false;

  // 1. 最初の非空行の日本語差分要約パターン
  const firstNonEmptyLine = response.split("\n").map(l => l.trim()).find(l => l.length > 0) ?? "";
  const summaryPatterns = [/^計画を修正しました/, /^変更点[:：は]/, /^以下の(変更|修正)/, /^修正(内容|箇所)/];
  if (summaryPatterns.some(p => p.test(firstNonEmptyLine))) return true;

  // 2. unified diff / fenced diff 記号パターン（本文全体で判定）
  const lines = response.split("\n");
  const hasHunkHeader = lines.some(l => /^@@\s/.test(l));
  const hasDiffHeader = lines.some(l => /^---\s/.test(l)) && lines.some(l => /^\+\+\+\s/.test(l));
  const hasFencedDiff = lines.some(l => /^```\s*diff/i.test(l));
  if (hasHunkHeader || hasDiffHeader || hasFencedDiff) return true;

  // 2.5. 結語先頭パターン（末尾セクションのみが返された場合のセーフティネット）
  const meaningfulLines = lines
    .map(l => l.trim())
    .filter(l => l.length > 0 && !/^[-*_]{3,}$/.test(l))
    .slice(0, 2);
  const conclusionPatterns = [
    /^以上が.*(?:修正後|反映|全文です|プラン全文|変更後|修正版|対応済み)/,
    /^上記が.*(?:修正後|反映|全文です|プラン全文|変更後|修正版|対応済み)/,
  ];
  if (meaningfulLines.some(line => conclusionPatterns.some(p => p.test(line)))) return true;

  // 3. 長さが極端に短い (30%未満) → diff 判定
  if (response.length < basePlan.length * 0.3) return true;

  return false;
}

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

async function updatePlanWithRetry(
  newResponse: string,
  lastKnownFullPlan: string,
  originalContext: string,
  generator: Generator,
  canStream: boolean,
): Promise<{ plan: string; wasRetried: boolean; fellBack: boolean }> {
  if (!isDiffLikeResponse(newResponse, lastKnownFullPlan)) {
    return { plan: newResponse, wasRetried: false, fellBack: false };
  }

  // 差分検知: lastKnownFullPlan + 差分出力 + 元の修正要求を渡して全文再構成リトライ
  logger.verbose("差分出力を検知、全文再構成をリトライ");
  ui.display("⚠ 差分出力を検知しました。全文を再取得中...");

  try {
    const retryPrompt = PROMPTS.PLAN_FULLTEXT_RETRY(lastKnownFullPlan, newResponse, originalContext);
    const retryResult = await runWithProgress(canStream, "全文再取得中...", () =>
      generator.generatePlan(retryPrompt),
    );

    if (!retryResult.response.trim()) {
      logger.warn("全文再取得も空のためフォールバック");
      ui.display("⚠ 全文取得に失敗しました。前回の全文プランを使用します。");
      return { plan: lastKnownFullPlan, wasRetried: true, fellBack: true };
    }

    if (isDiffLikeResponse(retryResult.response, lastKnownFullPlan)) {
      logger.warn("リトライ後も差分出力のためフォールバック");
      ui.display("⚠ 全文取得に失敗しました。前回の全文プランを使用します。");
      return { plan: lastKnownFullPlan, wasRetried: true, fellBack: true };
    }

    return { plan: retryResult.response, wasRetried: true, fellBack: false };
  } catch (err) {
    // リトライ API 失敗時も lastKnownFullPlan にフォールバック
    logger.warn(`全文再取得のリトライが失敗: ${String(err)}`);
    ui.display("⚠ 全文再取得に失敗しました。前回の全文プランを使用します。");
    return { plan: lastKnownFullPlan, wasRetried: true, fellBack: true };
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

  const generatorCli = options.generatorCli ?? "claude";
  const reviewerCli = options.reviewerCli ?? "codex";

  // Step 0: Capability check
  ui.display("🔍 CLI の互換性をチェックしています...");
  const capError = await validateProviderCapabilities(dangerous, cwd, {
    generatorCli: options.generatorCli,
    reviewerCli: options.reviewerCli,
    judgeCli: options.judgeCli,
  });
  if (capError) {
    throw new Error(capError);
  }
  ui.display("✅ CLI の互換性チェックに成功しました");

  // ストリーミング capability チェック
  // Claude を使うロールがある場合のみ stream-json チェックを実行
  const needsClaudeStreamCheck = [generatorCli, reviewerCli].includes("claude");
  let canStreamClaude = false;
  if (shouldStream && needsClaudeStreamCheck) {
    canStreamClaude = await checkClaudeStreamingCapability(cwd);
    if (!canStreamClaude) {
      logger.warn("Claude CLI が stream-json に非対応のため、Claude のストリーミングは無効になります。");
    }
  }

  // ロール別ストリーミング判定
  const canStreamGenerator = generatorCli === "claude"
    ? (shouldStream && canStreamClaude)
    : shouldStream;
  const canStreamReviewer = reviewerCli === "claude"
    ? (shouldStream && canStreamClaude)
    : shouldStream;

  const { generator, reviewer, judge } = createProviders({
    cwd,
    claudeModel: options.claudeModel,
    codexModel: options.codexModel,
    dangerous,
    codexSandbox: options.codexSandbox,
    generatorCli: options.generatorCli,
    reviewerCli: options.reviewerCli,
    judgeCli: options.judgeCli,
    streaming: shouldStream,
    canStreamClaude,
    onStdout: stdoutCallback,
    onStderr: stderrCallback,
  });

  // ===== Plan Phase =====
  ui.displaySeparator();
  ui.display("📝 Step 1: プラン生成を開始します...");
  logger.verbose("プロンプト", prompt);

  const planPrompt = PROMPTS.PLAN_GENERATION(prompt);
  let planResult = await runWithProgress(canStreamGenerator, "プラン生成中...", () =>
    generator.generatePlan(planPrompt),
  );
  let currentPlan = planResult.response;
  let lastKnownFullPlan = currentPlan;
  logger.verbose("生成されたプラン", currentPlan);

  // 空プランのバリデーション
  if (!currentPlan.trim()) {
    const r = planResult.raw;
    logger.debug("プラン生成結果が空", `exitCode: ${r.exitCode}, stdout(${r.stdout.length}chars): ${r.stdout.slice(0, 200)}${r.stdout.length > 200 ? "..." : ""}\nstderr(${r.stderr.length}chars): ${r.stderr.slice(-200)}`);
    throw new Error("プラン生成結果が空です。Claude Code からの応答が正しく取得できませんでした。");
  }

  // Plan review + approval outer loop
  let planIteration = 0;
  let lastPlanJudgment: ReviewJudgment | null = null;
  let planReviewSummary = "";

  planApprovalLoop: while (true) {
    // Inner review loop
    while (planIteration < maxPlanIterations) {
      planIteration++;
      ui.displaySeparator();
      ui.display(`🔎 Step 2: プランレビュー (${planIteration}/${maxPlanIterations})...`);

      const reviewPrompt: string =
        planIteration === 1
          ? PROMPTS.PLAN_REVIEW(currentPlan)
          : PROMPTS.PLAN_REVIEW_CONTINUATION(formatConcerns(lastPlanJudgment!), currentPlan);

      const reviewResult = await runWithProgress(canStreamReviewer, "プランレビュー中...", () =>
        reviewer.reviewPlan(
          reviewPrompt,
          planIteration > 1
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
        () => judge.judgeReview(reviewOutput),
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
        currentPlan,
        formatConcerns(judgment),
        userAnswers || undefined,
      );
      planResult = await runWithProgress(canStreamGenerator, "プラン修正中...", () =>
        generator.generatePlan(revisionPrompt),
      );

      // 修正後プランの空チェック
      if (!planResult.response.trim()) {
        const r = planResult.raw;
        logger.debug("プラン修正結果が空", `exitCode: ${r.exitCode}, stdout(${r.stdout.length}chars): ${r.stdout.slice(0, 200)}${r.stdout.length > 200 ? "..." : ""}\nstderr(${r.stderr.length}chars): ${r.stderr.slice(-200)}`);
        throw new Error("プラン修正結果が空です。Claude Code からの応答が正しく取得できませんでした。");
      }

      // 差分検知 + リトライ
      let originalContext = formatConcerns(judgment);
      if (userAnswers) {
        originalContext += `\n\nユーザーからの回答:\n${userAnswers}`;
      }
      const updated = await updatePlanWithRetry(
        planResult.response, lastKnownFullPlan,
        originalContext,
        generator, canStreamGenerator,
      );
      currentPlan = updated.plan;
      if (!updated.fellBack) {
        lastKnownFullPlan = currentPlan;
      }
      logger.verbose("修正されたプラン", currentPlan);
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

    const approval: PlanApprovalResult = await ui.promptPlanApproval(MESSAGES.PLAN_APPROVE);

    if (approval.action === "approve") {
      break planApprovalLoop;
    }

    if (approval.action === "abort") {
      ui.display(MESSAGES.WORKFLOW_ABORTED);
      return;
    }

    // approval.action === "modify"
    ui.displaySeparator();
    ui.display("🔄 ユーザーの修正指示に基づいてプランを修正中...");
    const userRevisionPrompt = PROMPTS.PLAN_USER_REVISION(currentPlan, approval.instruction);
    planResult = await runWithProgress(canStreamGenerator, "プラン修正中...", () =>
      generator.generatePlan(userRevisionPrompt),
    );

    // 修正後プランの空チェック
    if (!planResult.response.trim()) {
      const r = planResult.raw;
      logger.debug("ユーザー指示によるプラン修正結果が空", `exitCode: ${r.exitCode}, stdout(${r.stdout.length}chars): ${r.stdout.slice(0, 200)}${r.stdout.length > 200 ? "..." : ""}\nstderr(${r.stderr.length}chars): ${r.stderr.slice(-200)}`);
      throw new Error("プラン修正結果が空です。Claude Code からの応答が正しく取得できませんでした。");
    }

    // 差分検知 + リトライ
    const updated = await updatePlanWithRetry(
      planResult.response, lastKnownFullPlan,
      approval.instruction,
      generator, canStreamGenerator,
    );
    currentPlan = updated.plan;
    if (!updated.fellBack) {
      lastKnownFullPlan = currentPlan;
    }
    logger.verbose("ユーザー指示による修正プラン", currentPlan);

    // フォールバック時: 修正が反映されていない可能性があるためユーザーに明示確認
    if (updated.fellBack) {
      ui.display("⚠ 修正指示が反映されていない可能性があります。前回の全文プランを表示します。");
      ui.displaySeparator();
      ui.display(currentPlan);
      ui.displaySeparator();
      const shouldContinue = await ui.confirmYesNo(
        "前回のプランのまま続行しますか？ (y: このまま続行 / n: 中止): ",
      );
      if (!shouldContinue) {
        ui.display(MESSAGES.WORKFLOW_ABORTED);
        return;
      }
    }

    // Reset review state for re-review
    planIteration = 0;
    lastPlanJudgment = null;
    planReviewSummary = "";
  }

  // ===== Code Phase =====
  ui.displaySeparator();
  ui.display("💻 Step 4: コード生成を開始します...");

  const codePrompt = PROMPTS.CODE_GENERATION();
  const codeResult = await runWithProgress(canStreamGenerator, "コード生成中...", () =>
    generator.generateCode(codePrompt),
  );
  logger.verbose("コード生成結果", codeResult.response);

  // Code review loop
  let codeIteration = 0;
  let lastCodeJudgment: ReviewJudgment | null = null;
  let codeReviewSummary = "";
  let lastCodeDiffSummary = "";

  while (codeIteration < maxCodeIterations) {
    codeIteration++;
    ui.displaySeparator();
    ui.display(`🔎 Step 5: コードレビュー (${codeIteration}/${maxCodeIterations})...`);

    const isGitRepo = await checkGitRepo(cwd);
    if (!isGitRepo) {
      throw new Error(MESSAGES.NO_GIT_REPO);
    }

    const hasChanges = await checkGitChanges(cwd);
    if (!hasChanges) {
      throw new Error(MESSAGES.NO_GIT_CHANGES);
    }

    // Code review with Codex
    const gitDiff = await getGitDiff(cwd);
    if (!gitDiff.trim()) {
      throw new Error("Git の変更が検出されましたが、差分の取得に失敗しました。");
    }

    // 前回レビュー時点の diff 要約を保持（フォールバック用）
    const prevDiffSummary = lastCodeDiffSummary;
    lastCodeDiffSummary = gitDiff.slice(0, 500);

    const codeReviewPrompt =
      codeIteration === 1
        ? PROMPTS.CODE_REVIEW(currentPlan, gitDiff)
        : PROMPTS.CODE_REVIEW_CONTINUATION(
            formatConcerns(lastCodeJudgment!),
            currentPlan,
            gitDiff,
          );

    const codeReviewResult = await runWithProgress(canStreamReviewer, "コードレビュー中...", () =>
      reviewer.reviewCode(
        codeReviewPrompt,
        codeIteration > 1
          ? {
              diffSummary: prevDiffSummary.slice(0, 500),
              reviewSummary: codeReviewSummary.slice(0, 500),
            }
          : undefined,
      ),
    );
    const codeReviewOutput = codeReviewResult.response;
    codeReviewSummary = codeReviewOutput.slice(0, 500);
    logger.verbose("コードレビュー結果", codeReviewOutput);

    // Step 5.5: Judge code review
    ui.display("⚖️ Step 5.5: コードレビュー判定中...");
    const codeJudgment = await runWithProgress(shouldStream, "コードレビュー判定中...", () =>
      judge.judgeReview(codeReviewOutput),
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
    await runWithProgress(canStreamGenerator, "コード修正中...", () =>
      generator.generateCode(codeRevisionPrompt),
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
