import type { CliBackend } from "./backend.js";
import type { CodexSandboxMode } from "../types.js";
import type { Reviewer, ProviderResult } from "./types.js";
import { buildSummaryContext, buildCodeReviewSummaryContext } from "./context-utils.js";
import * as logger from "../logger.js";

export interface ReviewerImplOptions {
  sandboxMode?: CodexSandboxMode;
}

export class ReviewerImpl implements Reviewer {
  /** プランレビュー用セッション */
  private planSessionId: string | null = null;
  /** コードレビュー用セッション（プランレビューとは完全に独立） */
  private codeReviewSessionId: string | null = null;
  private firstPlanRun = true;
  private readonly backend: CliBackend;
  private readonly codeSandboxMode: CodexSandboxMode;

  constructor(backend: CliBackend, options: ReviewerImplOptions = {}) {
    this.backend = backend;
    this.codeSandboxMode = options.sandboxMode ?? "workspace-write";
  }

  hasPlanSession(): boolean {
    return this.planSessionId !== null;
  }

  hasCodeReviewSession(): boolean {
    return this.codeReviewSessionId !== null;
  }

  async reviewPlan(
    prompt: string,
    fallbackContext?: { planSummary: string; reviewSummary: string },
  ): Promise<ProviderResult> {
    let effectivePrompt = prompt;

    // セッション再開不可 + フォールバックコンテキストあり → プロンプトに付加
    if (!this.firstPlanRun && !this.planSessionId && fallbackContext) {
      effectivePrompt = `${buildSummaryContext(
        fallbackContext.planSummary, fallbackContext.reviewSummary,
      )}\n\n${prompt}`;
    }

    const result = await this.backend.run({
      prompt: effectivePrompt,
      resumeSessionId: this.firstPlanRun ? null : this.planSessionId,
      hints: { operation: "reviewPlan", sandboxMode: "read-only" },
    });

    if (result.raw.exitCode !== 0) {
      throw new Error(
        `プランレビューが失敗しました (exit code: ${result.raw.exitCode})\n${result.raw.stderr}`,
      );
    }

    // セッション ID 未取得なら毎回抽出を試行（回復可能設計）
    if (!this.planSessionId && result.sessionId) {
      this.planSessionId = result.sessionId;
      logger.debug(`Reviewer プランセッション ID 抽出成功: ${result.sessionId}`);
    } else if (this.firstPlanRun && !result.sessionId) {
      logger.verbose("Reviewer プランセッション ID の抽出に失敗しました。フォールバックモードで継続します。");
    }
    this.firstPlanRun = false;

    return { response: result.response, raw: result.raw };
  }

  async reviewCode(
    prompt: string,
    fallbackContext?: { diffSummary: string; reviewSummary: string },
  ): Promise<ProviderResult> {
    let effectivePrompt = prompt;

    if (!this.codeReviewSessionId && fallbackContext) {
      effectivePrompt = `${buildCodeReviewSummaryContext(
        fallbackContext.diffSummary, fallbackContext.reviewSummary,
      )}\n\n${prompt}`;
    }

    const result = await this.backend.run({
      prompt: effectivePrompt,
      resumeSessionId: this.codeReviewSessionId,
      hints: { operation: "reviewCode", sandboxMode: this.codeSandboxMode },
    });

    if (result.raw.exitCode !== 0) {
      throw new Error(
        `コードレビューが失敗しました (exit code: ${result.raw.exitCode})\n${result.raw.stderr}`,
      );
    }

    // セッション ID 未取得なら毎回抽出を試行（回復可能設計）
    if (!this.codeReviewSessionId && result.sessionId) {
      this.codeReviewSessionId = result.sessionId;
      logger.debug(`Reviewer コードレビューセッション ID 抽出成功: ${result.sessionId}`);
    } else if (!this.codeReviewSessionId && !result.sessionId) {
      logger.verbose("Reviewer コードレビューセッション ID の抽出に失敗しました。フォールバックモードで継続します。");
    }

    return { response: result.response, raw: result.raw };
  }
}
