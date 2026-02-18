export const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes
export const DEFAULT_MAX_PLAN_ITERATIONS = 5;
export const DEFAULT_MAX_CODE_ITERATIONS = 5;
export const LOG_TRUNCATE_HEAD = 300;
export const LOG_TRUNCATE_TAIL = 100;

export const BLOCKER_SEVERITIES = new Set(["P0", "P1", "P2", "P3"]);

export const PROMPTS = {
  PLAN_GENERATION: (userPrompt: string) =>
    `以下の要件に基づいて、実装計画を作成してください。コードは書かず、計画のみを出力してください。\n\n${userPrompt}`,

  PLAN_REVISION: (concerns: string, userAnswers?: string) => {
    let prompt = `以下のレビュー指摘事項に基づいて、計画を修正してください。コードは書かず、修正した計画のみを出力してください。\n\n## レビュー指摘事項\n${concerns}`;
    if (userAnswers) {
      prompt += `\n\n## ユーザーからの回答\n${userAnswers}`;
    }
    return prompt;
  },

  CODE_GENERATION: () =>
    `上記の計画に基づいて、コードを生成してください。計画に記載された内容をすべて実装してください。`,

  CODE_REVISION: (concerns: string) =>
    `以下のコードレビュー指摘事項に基づいて、コードを修正してください。\n\n## レビュー指摘事項\n${concerns}`,

  PLAN_REVIEW: (plan: string) =>
    `以下の実装計画をレビューしてください。セキュリティ、パフォーマンス、設計上の問題点があれば指摘してください。重大度を P0（致命的）から P4（軽微）で評価してください。\n\n${plan}`,

  PLAN_REVIEW_CONTINUATION: (concerns: string) =>
    `前回のレビュー指摘事項に基づいて計画が修正されました。修正後の計画を再レビューしてください。特に前回の指摘事項が適切に対処されているか確認してください。\n\n前回の指摘事項:\n${concerns}`,

  CODE_REVIEW: () =>
    `コミットされていない変更をレビューしてください。セキュリティ、パフォーマンス、バグ、設計上の問題点があれば指摘してください。重大度を P0（致命的）から P4（軽微）で評価してください。`,

  REVIEW_JUDGMENT: (reviewOutput: string) =>
    `あなたはコードレビュー判定の専門家です。以下のレビュー結果を分析し、下記のフォーマットで出力してください。

## 出力フォーマット（厳守）

### 概要
レビュー全体の要約を1〜3文で記述してください。

### 懸念事項
各懸念事項を箇条書きで記述してください。各行の先頭に重大度マーカーを付けてください。
マーカーは [P0] [P1] [P2] [P3] [P4] のいずれかです。

- [P0] 致命的: セキュリティ脆弱性、データ損失リスクなど
- [P1] 重大: 主要機能の不具合、重大なパフォーマンス問題など
- [P2] 中程度: 設計上の問題、エッジケースの未処理など
- [P3] 軽度: コード品質の問題、改善推奨事項など
- [P4] 軽微: スタイル、命名、ドキュメントの改善など

懸念事項がない場合は「懸念事項なし」とだけ記述してください。

## 重要なルール
- 各懸念事項の行は必ず「- [P0]」「- [P1]」「- [P2]」「- [P3]」「- [P4]」のいずれかで始めてください
- 説明文中で重大度レベルに言及する場合は角括弧を使わないでください（例: 「P2レベルの問題」は OK、「[P2]」は NG）
- コードブロックの中にマーカーを書かないでください

## レビュー結果
${reviewOutput}`,
} as const;

export const MESSAGES = {
  CODE_GEN_CONFIRM: `⚠ コード生成を開始します。Claude Code がファイルの作成・編集を行います。\n続行しますか？ (yes/no): `,
  PLAN_APPROVE: `上記の計画で進めてよろしいですか？ (yes/no): `,
  LOOP_LIMIT_WARNING: (phase: string, max: number) =>
    `⚠ ${phase}のレビューループが上限（${max}回）に達しました。`,
  UNRESOLVED_CONCERNS_CONTINUE: `未解消の懸念事項があります。このまま続行しますか？ (yes/no): `,
  UNRESOLVED_CONCERNS_FINISH: `未解消の懸念事項があります。このまま完了してよいですか？ (yes/no): `,
  WORKFLOW_ABORTED: `ワークフローを中止しました。`,
  WORKFLOW_COMPLETE: `✅ コード生成が完了しました。`,
  NO_GIT_REPO: `エラー: 現在のディレクトリは Git リポジトリ内ではありません。コードレビューには Git リポジトリが必要です。`,
  NO_GIT_CHANGES: `エラー: Git の変更が検出されませんでした。コードレビューには未コミットの変更が必要です。`,
} as const;
