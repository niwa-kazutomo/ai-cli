import { PROMPTS } from "../constants.js";
import type { ReviewJudgment } from "../types.js";
import type { Judge } from "./types.js";
import type { CliBackend, BackendRunResult } from "./backend.js";
import {
  extractConcernsFromText,
  extractSummaryFromText,
  recalculateHasBlockers,
  createFailSafeJudgment,
  hasBareSeverityTokens,
  hasUnableToReviewIndicator,
  hasNoConcernsIndicator,
} from "../review-judge.js";
import * as logger from "../logger.js";

export class JudgeImpl implements Judge {
  private readonly backend: CliBackend;

  constructor(backend: CliBackend) {
    this.backend = backend;
  }

  async judgeReview(reviewOutput: string, context?: string): Promise<ReviewJudgment> {
    const prompt = PROMPTS.REVIEW_JUDGMENT(reviewOutput, context);

    // fail-safe 1: backend.run() 例外 → 安全側
    let result: BackendRunResult;
    try {
      result = await this.backend.run({
        prompt,
        resumeSessionId: null,
        hints: { operation: "judge", noSessionPersistence: true, sandboxMode: "read-only" },
      });
    } catch (err) {
      logger.error(`レビュー判定の実行に失敗しました: ${err}`);
      return createFailSafeJudgment();
    }

    // fail-safe 2: 非ゼロ終了 → 安全側
    if (result.raw.exitCode !== 0) {
      logger.error(
        `レビュー判定が非ゼロで終了しました (exit code: ${result.raw.exitCode})`,
      );
      return createFailSafeJudgment();
    }

    // fail-safe 3: レスポンス抽出失敗（Codex: agent_message 未検出等）→ 安全側
    if (!result.extractionSucceeded) {
      logger.warn("レスポンス抽出失敗。安全側にフォールバック。");
      return createFailSafeJudgment();
    }

    const text = result.response;

    // fail-safe 4: 空レスポンス → 安全側
    if (!text.trim()) {
      logger.warn("レビュー判定の出力が空です。安全側に倒します。");
      return createFailSafeJudgment();
    }

    // 優先1: マーカーあり → 正常パース
    const concerns = extractConcernsFromText(text);
    if (concerns.length > 0) {
      const hasBlockers = recalculateHasBlockers(concerns);
      return {
        has_p3_plus_concerns: hasBlockers,
        concerns,
        questions_for_user: [],
        summary: extractSummaryFromText(text),
      };
    }

    // 優先2: マーカーなし + 裸トークン P0-P3 あり → fail-safe
    if (hasBareSeverityTokens(text)) {
      logger.warn(
        "マーカー形式の懸念事項は検出されませんでしたが、裸の重大度トークンが検出されました。安全側に倒します。",
      );
      return createFailSafeJudgment();
    }

    // 優先3: マーカーなし + 裸トークンなし + レビュー不能インジケータ → fail-safe
    if (hasUnableToReviewIndicator(text)) {
      logger.warn(
        "レビュー対象不在または実施不能のインジケータが検出されました。安全側に倒します。",
      );
      return createFailSafeJudgment();
    }

    // 優先4: マーカーなし + 裸トークンなし + 「懸念事項なし」 → PASS
    if (hasNoConcernsIndicator(text)) {
      return {
        has_p3_plus_concerns: false,
        concerns: [],
        questions_for_user: [],
        summary: extractSummaryFromText(text),
      };
    }

    // 優先5: マーカーなし + 裸トークンなし + テキストあり → PASS + warn
    logger.warn(
      "マーカー形式の懸念事項が検出されませんでした。懸念事項なしとして扱います。",
    );
    return {
      has_p3_plus_concerns: false,
      concerns: [],
      questions_for_user: [],
      summary: extractSummaryFromText(text),
    };
  }
}
