import type { CliRunResult, ReviewJudgment } from "../types.js";

export interface ProviderResult {
  response: string;
  raw: CliRunResult;
}

export interface Generator {
  generatePlan(prompt: string): Promise<ProviderResult>;
  generateCode(prompt: string): Promise<ProviderResult>;
}

export interface Reviewer {
  reviewPlan(
    prompt: string,
    fallbackContext?: { planSummary: string; reviewSummary: string },
  ): Promise<ProviderResult>;
  reviewCode(
    prompt: string,
    fallbackContext?: { diffSummary: string; reviewSummary: string },
  ): Promise<ProviderResult>;
}

export interface Judge {
  judgeReview(reviewOutput: string): Promise<ReviewJudgment>;
}
