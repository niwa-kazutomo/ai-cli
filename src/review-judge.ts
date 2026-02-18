import { runCli } from "./cli-runner.js";
import { BLOCKER_SEVERITIES, PROMPTS } from "./constants.js";
import type { ReviewJudgment, ReviewConcern } from "./types.js";
import * as logger from "./logger.js";

/**
 * concerns の severity から has_p3_plus_concerns を再計算する。
 * P0〜P3 をブロッカー扱い（P4 のみ非ブロッカー）。
 */
export function recalculateHasBlockers(concerns: ReviewConcern[]): boolean {
  return concerns.some((c) => BLOCKER_SEVERITIES.has(c.severity));
}

/**
 * LLM の判定結果に対する二重検証を行う。
 * - アプリ側で severity を再計算
 * - LLM が true だがアプリ計算が false の場合は保守側（true）に倒す
 */
export function validateJudgment(judgment: ReviewJudgment): ReviewJudgment {
  const appCalculated = recalculateHasBlockers(judgment.concerns);

  if (appCalculated) {
    // アプリ計算でブロッカーあり → true に強制
    judgment.has_p3_plus_concerns = true;
  } else if (judgment.has_p3_plus_concerns && !appCalculated) {
    // LLM が true だがアプリ計算は false → 保守側（true）に倒す
    logger.verbose(
      "LLM は has_p3_plus_concerns=true と判定しましたが、concerns にブロッカー severity がありません。安全側に倒して true を維持します。",
    );
  } else {
    judgment.has_p3_plus_concerns = false;
  }

  return judgment;
}

/**
 * JSON 文字列を ReviewJudgment としてパースし、基本的なスキーマ検証を行う。
 * 失敗時は null を返す。
 */
export function parseJudgment(jsonStr: string): ReviewJudgment | null {
  try {
    const parsed = JSON.parse(jsonStr);

    // 基本的なスキーマ検証
    if (typeof parsed.has_p3_plus_concerns !== "boolean") return null;
    if (!Array.isArray(parsed.concerns)) return null;
    if (!Array.isArray(parsed.questions_for_user)) return null;
    if (typeof parsed.summary !== "string") return null;

    // concerns の各要素を検証
    for (const concern of parsed.concerns) {
      if (
        !concern.severity ||
        !["P0", "P1", "P2", "P3", "P4"].includes(concern.severity)
      )
        return null;
      if (typeof concern.description !== "string") return null;
    }

    // questions_for_user の各要素を検証
    for (const q of parsed.questions_for_user) {
      if (typeof q.question !== "string") return null;
      if (!Array.isArray(q.choices) || q.choices.length === 0) return null;
    }

    return parsed as ReviewJudgment;
  } catch {
    return null;
  }
}

/**
 * fail-safe: 判定不能時のデフォルト ReviewJudgment を返す。
 */
export function createFailSafeJudgment(): ReviewJudgment {
  return {
    has_p3_plus_concerns: true,
    concerns: [
      {
        severity: "P0",
        description: "レビュー判定の解析に失敗しました（判定不能）",
      },
    ],
    questions_for_user: [],
    summary: "レビュー判定の解析に失敗したため、安全側に倒してブロッカーありと判定しました。",
  };
}

/**
 * フェンスドコードブロック（```...```）を除去する。
 * コードブロック内の偽マーカーを防止するために使用。
 */
export function stripCodeBlocks(text: string): string {
  return text.replace(/```[\s\S]*?```/g, "");
}

/**
 * テキストから重大度マーカー付きの懸念事項を抽出する。
 * 正規表現で `- [P0]`〜`- [P4]` 形式の行をパースする。
 */
export function extractConcernsFromText(text: string): ReviewConcern[] {
  const cleaned = stripCodeBlocks(text);
  const pattern = /^[ \t]*(?:[-*]|\d+\.)\s*\[(P[0-4])\]\s*(.*)/gm;
  const concerns: ReviewConcern[] = [];

  let match;
  while ((match = pattern.exec(cleaned)) !== null) {
    const severity = match[1] as ReviewConcern["severity"];
    let description = match[2].trim();
    if (!description) {
      description = "（説明なし）";
      logger.warn(`重大度 ${severity} の懸念事項に説明がありません`);
    }
    concerns.push({ severity, description });
  }

  return concerns;
}

/**
 * テキストから概要セクションを抽出する。
 * 1. `### 概要` または `## 概要` セクションを探す
 * 2. なければマーカー行前のテキスト
 * 3. 最終手段は先頭 200 文字
 */
export function extractSummaryFromText(text: string): string {
  // `### 概要` または `## 概要` セクションを探す
  const sectionMatch = text.match(
    /#{2,3}\s*概要\s*\n([\s\S]*?)(?=\n#{2,3}\s|$)/,
  );
  if (sectionMatch) {
    const content = sectionMatch[1].trim();
    if (content) return content;
  }

  // マーカー行前のテキストを使用
  const markerIndex = text.search(
    /^[ \t]*(?:[-*]|\d+\.)\s*\[(P[0-4])\]/m,
  );
  if (markerIndex > 0) {
    const before = text.substring(0, markerIndex).trim();
    if (before) return before;
  }

  // 最終手段: 先頭 200 文字
  const trimmed = text.trim();
  if (trimmed.length <= 200) return trimmed;
  return trimmed.substring(0, 200) + "…";
}

/**
 * 「懸念事項なし」等のインジケータを検出する。
 * 否定の否定（「〜ありませんとは言えない」等）を除外する。
 * `### 懸念事項` セクションがある場合はそのセクション内のみを検索対象にする。
 */
export function hasNoConcernsIndicator(text: string): boolean {
  const cleaned = stripCodeBlocks(text);

  // 「### 懸念事項」セクションがあればその内容のみ抽出
  const sectionMatch = cleaned.match(
    /#{2,3}\s*懸念事項\s*\n([\s\S]*?)(?=\n#{2,3}\s|$)/,
  );
  const target = sectionMatch ? sectionMatch[1] : cleaned;

  // 行単位でマッチ（^...$ + m）し、否定の否定を除外
  const noConcernPatterns = [
    /^[ \t]*懸念事項なし[ \t]*[。.]?[ \t]*$/m,
    /^[ \t]*懸念事項はありません[ \t]*[。.]?[ \t]*$/m,
    /^.*(?:懸念|問題|指摘)(?:事項)?(?:は|が)(?:ありません|見(?:当た|つか)りません|ない)[ \t]*[。.]?[ \t]*$/m,
  ];

  return noConcernPatterns.some((pattern) => {
    const match = target.match(pattern);
    if (!match) return false;
    const line = match[0];
    // 否定の否定パターンを除外
    if (/(?:とは言えない|わけではない|とは限らない)/.test(line)) return false;
    return true;
  });
}

/**
 * レビュー対象が不在・レビュー実施不能であることを示すインジケータを検出する。
 * コードブロック内のテキストは除外する。
 */
export function hasUnableToReviewIndicator(text: string): boolean {
  const cleaned = stripCodeBlocks(text);

  const patterns = [
    /レビュー対象が含まれておらず/,
    /レビュー対象が含まれていません/,
    /レビュー対象が(?:ありません|ない|存在しません|見当たりません)/,
    /レビューを実施できない/,
    /レビューを行うことができません/,
    /レビュー(?:が|を)実施できません/,
    /レビューする(?:内容|対象)が(?:ありません|ない)/,
    /nothing to review/i,
    /no (?:code |changes )?to review/i,
    /unable to (?:perform |conduct )?review/i,
  ];

  return patterns.some((pattern) => pattern.test(cleaned));
}

/**
 * コードブロック除去後のテキストに裸の P0〜P3 トークンが含まれるか検出する。
 * マーカー形式 [Pn] は除外した上で検出する。
 */
export function hasBareSeverityTokens(text: string): boolean {
  const cleaned = stripCodeBlocks(text);
  // マーカー形式 [Pn] を除去した上で、裸の P0〜P3 トークンを検出
  const withoutMarkers = cleaned.replace(/\[P[0-4]\]/g, "");
  return /\bP[0-3]\b/.test(withoutMarkers);
}

/**
 * Codex のレビュー出力を Claude Code に渡し、テキストベースのマーカー解析で判定する。
 */
export async function judgeReview(
  reviewOutput: string,
  options: { cwd: string; model?: string },
): Promise<ReviewJudgment> {
  const prompt = PROMPTS.REVIEW_JUDGMENT(reviewOutput);

  const args = ["--print", "--no-session-persistence"];

  if (options.model) {
    args.push("--model", options.model);
  }

  args.push(prompt);

  let result;
  try {
    result = await runCli("claude", {
      args,
      cwd: options.cwd,
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

  const text = result.stdout;

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
