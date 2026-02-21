/**
 * セッション ID 抽出失敗時のフォールバック用要約コンテキストを生成する。
 */
export function buildSummaryContext(
  planSummary: string,
  reviewSummary: string,
): string {
  return `## これまでの経緯\n\n### 計画の要約\n${planSummary}\n\n### レビューの要約\n${reviewSummary}`;
}

/**
 * コードレビューのセッション ID 抽出失敗時のフォールバック用要約コンテキストを生成する。
 */
export function buildCodeReviewSummaryContext(
  diffSummary: string,
  reviewSummary: string,
): string {
  return `## これまでの経緯\n\n### 前回の差分要約\n${diffSummary}\n\n### 前回のレビュー要約\n${reviewSummary}`;
}
