import type { SessionState } from "./types.js";
import * as logger from "./logger.js";

export function createSession(): SessionState {
  return {
    claudeSessionId: null,
    claudeFirstRun: true,
    codexSessionId: null,
    codexFirstRun: true,
  };
}

export function markClaudeUsed(session: SessionState): void {
  session.claudeFirstRun = false;
}

export function markCodexUsed(session: SessionState): void {
  session.codexFirstRun = false;
}

/**
 * Codex の JSONL 出力からセッション ID を抽出する。
 * thread.started イベントの thread_id を優先し、フォールバックとして session_id フィールドも探す。
 * 抽出失敗時は null を返す。
 */
export function extractCodexSessionId(jsonlOutput: string): string | null {
  const lines = jsonlOutput.trim().split("\n");
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line);
      // thread.started の thread_id を優先
      if (parsed.type === "thread.started" && typeof parsed.thread_id === "string") {
        return parsed.thread_id;
      }
      // フォールバック: session_id フィールド
      if (typeof parsed.session_id === "string") {
        return parsed.session_id;
      }
    } catch {
      // 不正 JSON 行はスキップして次の行へ
      continue;
    }
  }
  return null;
}

/**
 * セッション ID 抽出失敗時のフォールバック用要約コンテキストを生成する。
 */
export function buildSummaryContext(
  planSummary: string,
  reviewSummary: string,
): string {
  return `## これまでの経緯\n\n### 計画の要約\n${planSummary}\n\n### レビューの要約\n${reviewSummary}`;
}
