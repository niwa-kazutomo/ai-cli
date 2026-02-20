import { runCli } from "../cli-runner.js";
import { PROMPTS } from "../constants.js";
import type { ReviewJudgment } from "../types.js";
import type { Judge } from "./types.js";
import { extractCodexResponse } from "./codex-reviewer.js";
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

export interface CodexJudgeConfig {
  cwd: string;
  model?: string;
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
}

export class CodexJudge implements Judge {
  private readonly config: CodexJudgeConfig;

  constructor(config: CodexJudgeConfig) {
    this.config = config;
  }

  async judgeReview(reviewOutput: string): Promise<ReviewJudgment> {
    const prompt = PROMPTS.REVIEW_JUDGMENT(reviewOutput);

    const args = ["exec", "--sandbox", "read-only", "--json"];

    if (this.config.model) {
      args.push("--model", this.config.model);
    }

    args.push(prompt);

    let result;
    try {
      result = await runCli("codex", {
        args,
        cwd: this.config.cwd,
        onStdout: this.config.onStdout,
        onStderr: this.config.onStderr,
      });
    } catch (err) {
      logger.error(`レビュー判定の実行に失敗しました: ${err}`);
      return createFailSafeJudgment();
    }

    if (result.exitCode !== 0) {
      logger.error(
        `レビュー判定が非ゼロで終了しました (exit code: ${result.exitCode})`,
      );
      return createFailSafeJudgment();
    }

    const text = extractCodexResponse(result.stdout);

    // agent_message が取得できず生の stdout にフォールバックした場合は fail-safe
    if (text === result.stdout) {
      logger.warn(
        "Codex からの応答に agent_message が含まれていません。安全側に倒します。",
      );
      return createFailSafeJudgment();
    }

    // 優先5: stdout が空
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
