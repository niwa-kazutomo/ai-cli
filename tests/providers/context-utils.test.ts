import { describe, it, expect } from "vitest";
import { buildSummaryContext, buildCodeReviewSummaryContext } from "../../src/providers/context-utils.js";

describe("buildSummaryContext", () => {
  it("要約コンテキストを正しく構築する", () => {
    const result = buildSummaryContext("計画の内容", "レビューの内容");

    expect(result).toContain("計画の要約");
    expect(result).toContain("計画の内容");
    expect(result).toContain("レビューの要約");
    expect(result).toContain("レビューの内容");
  });
});

describe("buildCodeReviewSummaryContext", () => {
  it("コードレビュー用要約コンテキストを正しく構築する", () => {
    const result = buildCodeReviewSummaryContext("差分の内容", "レビューの内容");

    expect(result).toContain("前回の差分要約");
    expect(result).toContain("差分の内容");
    expect(result).toContain("前回のレビュー要約");
    expect(result).toContain("レビューの内容");
  });
});
