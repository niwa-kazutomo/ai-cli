import { describe, it, expect } from "vitest";
import {
  recalculateHasBlockers,
  validateJudgment,
  parseJudgment,
  createFailSafeJudgment,
  stripCodeBlocks,
  extractConcernsFromText,
  extractSummaryFromText,
  hasNoConcernsIndicator,
  hasBareSeverityTokens,
  hasUnableToReviewIndicator,
} from "../src/review-judge.js";
import type { ReviewJudgment, ReviewConcern } from "../src/types.js";

describe("recalculateHasBlockers", () => {
  it("P0 の懸念がある場合は true を返す", () => {
    const concerns: ReviewConcern[] = [
      { severity: "P0", description: "Critical issue" },
    ];
    expect(recalculateHasBlockers(concerns)).toBe(true);
  });

  it("P1 の懸念がある場合は true を返す", () => {
    const concerns: ReviewConcern[] = [
      { severity: "P1", description: "Important issue" },
    ];
    expect(recalculateHasBlockers(concerns)).toBe(true);
  });

  it("P2 の懸念がある場合は true を返す", () => {
    const concerns: ReviewConcern[] = [
      { severity: "P2", description: "Moderate issue" },
    ];
    expect(recalculateHasBlockers(concerns)).toBe(true);
  });

  it("P3 の懸念がある場合は true を返す", () => {
    const concerns: ReviewConcern[] = [
      { severity: "P3", description: "Minor-ish issue" },
    ];
    expect(recalculateHasBlockers(concerns)).toBe(true);
  });

  it("P4 のみの場合は false を返す", () => {
    const concerns: ReviewConcern[] = [
      { severity: "P4", description: "Trivial issue" },
    ];
    expect(recalculateHasBlockers(concerns)).toBe(false);
  });

  it("空の配列では false を返す", () => {
    expect(recalculateHasBlockers([])).toBe(false);
  });

  it("P3 と P4 が混在する場合は true を返す", () => {
    const concerns: ReviewConcern[] = [
      { severity: "P4", description: "Trivial" },
      { severity: "P3", description: "Minor-ish" },
    ];
    expect(recalculateHasBlockers(concerns)).toBe(true);
  });
});

describe("validateJudgment", () => {
  it("アプリ計算でブロッカーありの場合は true に強制する", () => {
    const judgment: ReviewJudgment = {
      has_p3_plus_concerns: false,
      concerns: [{ severity: "P2", description: "Issue" }],
      questions_for_user: [],
      summary: "Test",
    };

    const result = validateJudgment(judgment);
    expect(result.has_p3_plus_concerns).toBe(true);
  });

  it("LLM が true でアプリ計算が false の場合は true を維持（保守側）", () => {
    const judgment: ReviewJudgment = {
      has_p3_plus_concerns: true,
      concerns: [{ severity: "P4", description: "Trivial" }],
      questions_for_user: [],
      summary: "Test",
    };

    const result = validateJudgment(judgment);
    expect(result.has_p3_plus_concerns).toBe(true);
  });

  it("LLM も false でアプリ計算も false の場合は false を返す", () => {
    const judgment: ReviewJudgment = {
      has_p3_plus_concerns: false,
      concerns: [{ severity: "P4", description: "Trivial" }],
      questions_for_user: [],
      summary: "Test",
    };

    const result = validateJudgment(judgment);
    expect(result.has_p3_plus_concerns).toBe(false);
  });

  it("懸念なしで false を返す", () => {
    const judgment: ReviewJudgment = {
      has_p3_plus_concerns: false,
      concerns: [],
      questions_for_user: [],
      summary: "No issues",
    };

    const result = validateJudgment(judgment);
    expect(result.has_p3_plus_concerns).toBe(false);
  });
});

describe("parseJudgment", () => {
  it("有効な JSON を正しくパースする", () => {
    const json = JSON.stringify({
      has_p3_plus_concerns: true,
      concerns: [
        { severity: "P2", description: "Important issue", suggestion: "Fix it" },
      ],
      questions_for_user: [
        { question: "Which approach?", choices: ["A", "B"] },
      ],
      summary: "Review summary",
    });

    const result = parseJudgment(json);
    expect(result).not.toBeNull();
    expect(result!.has_p3_plus_concerns).toBe(true);
    expect(result!.concerns).toHaveLength(1);
    expect(result!.concerns[0].severity).toBe("P2");
    expect(result!.questions_for_user).toHaveLength(1);
  });

  it("不正な JSON で null を返す", () => {
    expect(parseJudgment("not json")).toBeNull();
  });

  it("has_p3_plus_concerns が boolean でない場合は null を返す", () => {
    const json = JSON.stringify({
      has_p3_plus_concerns: "yes",
      concerns: [],
      questions_for_user: [],
      summary: "Test",
    });
    expect(parseJudgment(json)).toBeNull();
  });

  it("concerns が配列でない場合は null を返す", () => {
    const json = JSON.stringify({
      has_p3_plus_concerns: true,
      concerns: "not array",
      questions_for_user: [],
      summary: "Test",
    });
    expect(parseJudgment(json)).toBeNull();
  });

  it("concerns の severity が不正な場合は null を返す", () => {
    const json = JSON.stringify({
      has_p3_plus_concerns: true,
      concerns: [{ severity: "P5", description: "Invalid" }],
      questions_for_user: [],
      summary: "Test",
    });
    expect(parseJudgment(json)).toBeNull();
  });

  it("questions_for_user の choices が空配列の場合は null を返す", () => {
    const json = JSON.stringify({
      has_p3_plus_concerns: false,
      concerns: [],
      questions_for_user: [{ question: "Q?", choices: [] }],
      summary: "Test",
    });
    expect(parseJudgment(json)).toBeNull();
  });

  it("summary が欠けている場合は null を返す", () => {
    const json = JSON.stringify({
      has_p3_plus_concerns: false,
      concerns: [],
      questions_for_user: [],
    });
    expect(parseJudgment(json)).toBeNull();
  });
});

describe("createFailSafeJudgment", () => {
  it("has_p3_plus_concerns が true の判定を返す", () => {
    const judgment = createFailSafeJudgment();
    expect(judgment.has_p3_plus_concerns).toBe(true);
  });

  it("P0 の判定不能 concern を含む", () => {
    const judgment = createFailSafeJudgment();
    expect(judgment.concerns).toHaveLength(1);
    expect(judgment.concerns[0].severity).toBe("P0");
    expect(judgment.concerns[0].description).toContain("判定不能");
  });

  it("questions_for_user が空配列", () => {
    const judgment = createFailSafeJudgment();
    expect(judgment.questions_for_user).toEqual([]);
  });

  it("summary が存在する", () => {
    const judgment = createFailSafeJudgment();
    expect(typeof judgment.summary).toBe("string");
    expect(judgment.summary.length).toBeGreaterThan(0);
  });
});

// --- 新規テスト ---

describe("stripCodeBlocks", () => {
  it("フェンスドコードブロックを除去する", () => {
    const text = "前文\n```\ncode here\n```\n後文";
    expect(stripCodeBlocks(text)).toBe("前文\n\n後文");
  });

  it("言語指定付きコードブロックを除去する", () => {
    const text = "前文\n```typescript\nconst x = 1;\n```\n後文";
    expect(stripCodeBlocks(text)).toBe("前文\n\n後文");
  });

  it("コードブロックがない場合はそのまま返す", () => {
    const text = "テキストのみ";
    expect(stripCodeBlocks(text)).toBe("テキストのみ");
  });

  it("複数のコードブロックを除去する", () => {
    const text = "A\n```\nblock1\n```\nB\n```\nblock2\n```\nC";
    expect(stripCodeBlocks(text)).toBe("A\n\nB\n\nC");
  });
});

describe("extractConcernsFromText", () => {
  it("標準形式のマーカーを抽出する", () => {
    const text = "### 懸念事項\n- [P2] 設計上の問題\n- [P4] スタイルの問題";
    const concerns = extractConcernsFromText(text);
    expect(concerns).toHaveLength(2);
    expect(concerns[0]).toEqual({ severity: "P2", description: "設計上の問題" });
    expect(concerns[1]).toEqual({ severity: "P4", description: "スタイルの問題" });
  });

  it("全 P0〜P4 レベルを抽出する", () => {
    const text = [
      "- [P0] 致命的な問題",
      "- [P1] 重大な問題",
      "- [P2] 中程度の問題",
      "- [P3] 軽度の問題",
      "- [P4] 軽微な問題",
    ].join("\n");
    const concerns = extractConcernsFromText(text);
    expect(concerns).toHaveLength(5);
    expect(concerns.map((c) => c.severity)).toEqual(["P0", "P1", "P2", "P3", "P4"]);
  });

  it("コードブロック内の偽マーカーを無視する", () => {
    const text = "- [P2] 実際の問題\n```\n- [P0] コード内のコメント\n```";
    const concerns = extractConcernsFromText(text);
    expect(concerns).toHaveLength(1);
    expect(concerns[0].severity).toBe("P2");
  });

  it("バレットなし行内の [Pn] を無視する", () => {
    const text = "この問題は [P2] レベルです。";
    const concerns = extractConcernsFromText(text);
    expect(concerns).toHaveLength(0);
  });

  it("* バレットリストを対応する", () => {
    const text = "* [P1] アスタリスクの問題";
    const concerns = extractConcernsFromText(text);
    expect(concerns).toHaveLength(1);
    expect(concerns[0]).toEqual({ severity: "P1", description: "アスタリスクの問題" });
  });

  it("番号付きリストを対応する", () => {
    const text = "1. [P3] 番号付きの問題";
    const concerns = extractConcernsFromText(text);
    expect(concerns).toHaveLength(1);
    expect(concerns[0]).toEqual({ severity: "P3", description: "番号付きの問題" });
  });

  it("空説明の場合「（説明なし）」で補完する", () => {
    const text = "- [P1]";
    const concerns = extractConcernsFromText(text);
    expect(concerns).toHaveLength(1);
    expect(concerns[0]).toEqual({ severity: "P1", description: "（説明なし）" });
  });

  it("P5 以上のマーカーは無視する", () => {
    const text = "- [P5] 不正なレベル\n- [P2] 正常な問題";
    const concerns = extractConcernsFromText(text);
    expect(concerns).toHaveLength(1);
    expect(concerns[0].severity).toBe("P2");
  });

  it("インデント付きマーカーを抽出する", () => {
    const text = "  - [P3] インデントされた問題";
    const concerns = extractConcernsFromText(text);
    expect(concerns).toHaveLength(1);
    expect(concerns[0]).toEqual({ severity: "P3", description: "インデントされた問題" });
  });
});

describe("extractSummaryFromText", () => {
  it("### 概要 セクションを抽出する", () => {
    const text = "### 概要\nレビュー全体の要約です。\n\n### 懸念事項\n- [P2] 問題";
    expect(extractSummaryFromText(text)).toBe("レビュー全体の要約です。");
  });

  it("## 概要 (h2) セクションを抽出する", () => {
    const text = "## 概要\nH2の要約です。\n\n## 懸念事項\n- [P2] 問題";
    expect(extractSummaryFromText(text)).toBe("H2の要約です。");
  });

  it("見出しなしの場合、マーカー行前のテキストをフォールバックする", () => {
    const text = "全体としては良好です。\n- [P4] 軽微な問題";
    expect(extractSummaryFromText(text)).toBe("全体としては良好です。");
  });

  it("構造なしの場合、先頭 200 文字をフォールバックする", () => {
    const text = "短いテキスト";
    expect(extractSummaryFromText(text)).toBe("短いテキスト");
  });

  it("長いテキストの場合、先頭 200 文字 + 省略記号を返す", () => {
    const text = "あ".repeat(300);
    const result = extractSummaryFromText(text);
    expect(result).toHaveLength(201); // 200 + "…"
    expect(result.endsWith("…")).toBe(true);
  });
});

describe("hasNoConcernsIndicator", () => {
  it("「懸念事項なし」を検出する", () => {
    expect(hasNoConcernsIndicator("### 懸念事項\n懸念事項なし")).toBe(true);
  });

  it("「懸念事項なし。」（句点付き）を検出する", () => {
    expect(hasNoConcernsIndicator("懸念事項なし。")).toBe(true);
  });

  it("「懸念事項はありません」を検出する", () => {
    expect(hasNoConcernsIndicator("懸念事項はありません")).toBe(true);
  });

  it("「問題は見当たりません」を検出する", () => {
    expect(hasNoConcernsIndicator("問題は見当たりません")).toBe(true);
  });

  it("「懸念事項が見つかりません」を検出する", () => {
    expect(hasNoConcernsIndicator("懸念事項が見つかりません")).toBe(true);
  });

  it("「指摘はありません」を検出する", () => {
    expect(hasNoConcernsIndicator("指摘はありません")).toBe(true);
  });

  it("コードブロック内の偽陽性を回避する", () => {
    expect(
      hasNoConcernsIndicator("```\n懸念事項なし\n```\n- [P2] 実際の問題"),
    ).toBe(false);
  });

  it("否定の否定「ありませんとは言えない」を false とする", () => {
    expect(
      hasNoConcernsIndicator("懸念事項はありませんとは言えない"),
    ).toBe(false);
  });

  it("否定の否定「わけではない」を false とする", () => {
    expect(
      hasNoConcernsIndicator("問題がないわけではない"),
    ).toBe(false);
  });

  it("懸念事項セクション内のみを検索する", () => {
    const text =
      "### 概要\n特に問題はありません\n\n### 懸念事項\n- [P2] 実際の問題あり";
    // 「問題はありません」は概要セクションにあるが、懸念事項セクション内にはない
    // 懸念事項セクションが存在するのでそのセクション内のみ検索
    expect(hasNoConcernsIndicator(text)).toBe(false);
  });
});

describe("hasBareSeverityTokens", () => {
  it("「P1レベル」等の裸トークンを検出する", () => {
    expect(hasBareSeverityTokens("P1レベルの脆弱性があります")).toBe(true);
  });

  it("P0 の裸トークンを検出する", () => {
    expect(hasBareSeverityTokens("これは P0 の問題です")).toBe(true);
  });

  it("[P1] マーカー形式は除外する", () => {
    expect(hasBareSeverityTokens("- [P1] マーカー形式の問題")).toBe(false);
  });

  it("P4 のみは false を返す", () => {
    expect(hasBareSeverityTokens("P4レベルの軽微な問題")).toBe(false);
  });

  it("コードブロック内の裸トークンは無視する", () => {
    expect(hasBareSeverityTokens("```\nP1レベルの問題\n```")).toBe(false);
  });

  it("[P0]〜[P4] マーカーのみのテキストは false を返す", () => {
    expect(hasBareSeverityTokens("- [P0] 問題\n- [P4] 軽微")).toBe(false);
  });
});

describe("hasUnableToReviewIndicator", () => {
  it("「レビュー対象が含まれておらず」を検出する", () => {
    expect(hasUnableToReviewIndicator("レビュー対象が含まれておらず、レビューできません")).toBe(true);
  });

  it("「レビュー対象が含まれていません」を検出する（プロンプト指示文言）", () => {
    expect(hasUnableToReviewIndicator("レビュー対象が含まれていません")).toBe(true);
  });

  it("「レビューを実施できない」を検出する", () => {
    expect(hasUnableToReviewIndicator("計画が空のためレビューを実施できない")).toBe(true);
  });

  it("「レビュー対象がありません」を検出する", () => {
    expect(hasUnableToReviewIndicator("レビュー対象がありません")).toBe(true);
  });

  it("「レビューする内容がありません」を検出する", () => {
    expect(hasUnableToReviewIndicator("レビューする内容がありません")).toBe(true);
  });

  it("「レビューを行うことができません」を検出する", () => {
    expect(hasUnableToReviewIndicator("レビューを行うことができません")).toBe(true);
  });

  it("英語 'nothing to review' を検出する", () => {
    expect(hasUnableToReviewIndicator("There is nothing to review")).toBe(true);
  });

  it("英語 'no code to review' を検出する", () => {
    expect(hasUnableToReviewIndicator("No code to review")).toBe(true);
  });

  it("英語 'unable to review' を検出する", () => {
    expect(hasUnableToReviewIndicator("Unable to perform review")).toBe(true);
  });

  it("コードブロック内のテキストは除外する", () => {
    expect(
      hasUnableToReviewIndicator("```\nレビュー対象がありません\n```\n問題なし"),
    ).toBe(false);
  });

  it("通常のレビュー結果では false を返す", () => {
    expect(hasUnableToReviewIndicator("全体的に問題ありません。懸念事項なし")).toBe(false);
  });

  it("レビュー内容がある通常テキストでは false", () => {
    expect(hasUnableToReviewIndicator("- [P2] 設計上の問題があります")).toBe(false);
  });
});

