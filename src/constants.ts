export const REPL_PROMPT = "ai> ";
export const REPL_MESSAGES = {
  WELCOME: (version: string) =>
    `\n🤖 AI CLI v${version}\nプロンプトを入力してください。終了: "exit" / "quit" / Ctrl+D\n\n`,
  GOODBYE: "👋 終了します。",
  NEXT_PROMPT: "次のプロンプトを入力してください。",
} as const;

export const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

const TRUNCATE_SEPARATOR = "\n...(中略)...\n";

function truncateMiddle(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  const available = maxLen - TRUNCATE_SEPARATOR.length;
  if (available <= 0) return text.slice(0, maxLen);
  const headLen = Math.ceil(available / 2);
  const tailLen = available - headLen;
  return text.slice(0, headLen) + TRUNCATE_SEPARATOR + text.slice(-tailLen);
}
export const DEFAULT_MAX_PLAN_ITERATIONS = 10;
export const DEFAULT_MAX_CODE_ITERATIONS = 10;
export const BLOCKER_SEVERITIES = new Set(["P0", "P1", "P2", "P3"]);

export const PROMPTS = {
  PLAN_GENERATION: (userPrompt: string) =>
    `以下の要件に基づいて、実装計画を作成してください。コードは書かず、計画のみを出力してください。\n\n${userPrompt}`,

  PLAN_REVISION: (currentPlan: string, concerns: string, userAnswers?: string) => {
    let prompt = `以下のレビュー指摘事項に基づいて、計画を修正してください。コードは書かず、修正後の計画を最初から最後まで省略せずに全文出力してください。変更箇所の差分だけでなく、計画全体を出力してください。\n\n## 現在の計画\n${currentPlan}\n\n## レビュー指摘事項\n${concerns}`;
    if (userAnswers) {
      prompt += `\n\n## ユーザーからの回答\n${userAnswers}`;
    }
    return prompt;
  },

  PLAN_USER_REVISION: (currentPlan: string, instruction: string) =>
    `ユーザーから以下の修正指示がありました。指示に基づいて計画を修正してください。コードは書かず、修正後の計画を最初から最後まで省略せずに全文出力してください。変更箇所の差分だけでなく、計画全体を出力してください。\n\n## 現在の計画\n${currentPlan}\n\n## ユーザーの修正指示\n${instruction}`,

  PLAN_FULLTEXT_RETRY: (lastKnownFullPlan: string, diffResponse: string, originalContext: string) => {
    const trimmedDiff = truncateMiddle(diffResponse, 5000);
    const trimmedContext = truncateMiddle(originalContext, 5000);
    return `先ほどの出力は変更箇所のみでした。以下のベースとなる計画に、先ほど出力された修正内容を反映した全文を出力してください。差分や要約ではなく、修正を反映した計画全体をそのまま出力してください。\n\n## ベースとなる計画\n${lastKnownFullPlan}\n\n## 元の修正要求\n${trimmedContext}\n\n## 先ほどの修正出力\n${trimmedDiff}`;
  },

  CODE_GENERATION: () =>
    `上記の計画に基づいて、コードを生成してください。計画に記載された内容をすべて実装してください。`,

  CODE_REVISION: (concerns: string) =>
    `以下のコードレビュー指摘事項に基づいて、コードを修正してください。\n\n## レビュー指摘事項\n${concerns}`,

  PLAN_REVIEW: (plan: string) =>
    `あなたは実装計画のレビュー担当です。以下に提示する実装計画テキストを主な分析対象としてレビューしてください。\nコードベースの参照はプランの理解を補助する目的でのみ行い、レビュー結果は必ず計画テキストの内容に基づいて記述してください。\n重大度を P0（致命的）から P4（軽微）で評価してください。\n\n## 実装計画\n${plan}`,

  PLAN_REVIEW_CONTINUATION: (concerns: string, plan: string) =>
    `あなたは実装計画のレビュー担当です。前回のレビュー指摘事項に基づいて計画が修正されました。以下に提示する修正後の計画テキストを主な分析対象として再レビューしてください。\nコードベースの参照はプランの理解を補助する目的でのみ行い、レビュー結果は必ず計画テキストの内容に基づいて記述してください。\n特に前回の指摘事項が適切に対処されているか確認してください。\n\n## 修正後の計画\n${plan}\n\n## 前回の指摘事項\n${concerns}`,

  CODE_REVIEW: (plan: string, diff: string) =>
    `あなたはコードレビューの担当です。以下の実装計画に基づいて生成されたコード変更をレビューしてください。

## 重要なルール
- レビュー対象は「実装計画に関連する変更」のみです。計画に無関係な既存の変更は無視してください。
- 重大度を P0（致命的）から P4（軽微）で評価してください。
- 計画の意図に対してコードが正しく実装されているかを重点的に確認してください。

## 実装計画
${plan}

## コード変更（diff）
\`\`\`diff
${diff}
\`\`\``,

  REVIEW_JUDGMENT: (reviewOutput: string) =>
    `あなたはコードレビュー判定の専門家です。以下のレビュー結果を分析し、下記のフォーマットで出力してください。

## 出力フォーマット（厳守）

### 概要
レビュー全体の要約を1〜3文で記述してください。

### 懸念事項
各懸念事項を箇条書きで記述してください。各行の先頭に重大度マーカーを付けてください。
マーカーは [P0] [P1] [P2] [P3] [P4] のいずれかです。

- [P0] 致命的: 実装不能、セキュリティ脆弱性、データ損失リスクなど
- [P1] 重大: 主要機能の不具合、重大なパフォーマンス問題など
- [P2] 中程度: 設計上の問題、エッジケースの未処理など
- [P3] 軽度: コード品質の問題、改善推奨事項など
- [P4] 軽微: スタイル、命名、ドキュメントの改善など

懸念事項がない場合は「懸念事項なし」とだけ記述してください。

## 重要なルール
- 各懸念事項の行は必ず「- [P0]」「- [P1]」「- [P2]」「- [P3]」「- [P4]」のいずれかで始めてください
- 説明文中で重大度レベルに言及する場合は角括弧を使わないでください（例: 「P2レベルの問題」は OK、「[P2]」は NG）
- コードブロックの中にマーカーを書かないでください
- レビュー対象が不在（コード変更なし、計画内容なし等）の場合は「- [P0] レビュー対象が含まれていません」と出力してください

## レビュー結果
${reviewOutput}`,
} as const;

export const MESSAGES = {
  PLAN_APPROVE: `承認: y / 修正指示を入力 / 中止: Enter: `,
  LOOP_LIMIT_WARNING: (phase: string, max: number) =>
    `⚠ ${phase}のレビューループが上限（${max}回）に達しました。`,
  UNRESOLVED_CONCERNS_CONTINUE: `未解消の懸念事項があります。このまま続行しますか？ (y/n): `,
  UNRESOLVED_CONCERNS_FINISH: `未解消の懸念事項があります。このまま完了してよいですか？ (y/n): `,
  WORKFLOW_ABORTED: `ワークフローを中止しました。`,
  WORKFLOW_COMPLETE: `✅ コード生成が完了しました。`,
  NO_GIT_REPO: `エラー: 現在のディレクトリは Git リポジトリ内ではありません。コードレビューには Git リポジトリが必要です。`,
  NO_GIT_CHANGES: `エラー: Git の変更が検出されませんでした。コードレビューには未コミットの変更が必要です。`,
} as const;
