import { randomUUID } from "node:crypto";
import type { SessionState } from "./types.js";
import * as logger from "./logger.js";

export function createSession(): SessionState {
  return {
    claudeSessionId: randomUUID(),
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
 * 抽出失敗時は null を返す。
 */
export function extractCodexSessionId(jsonlOutput: string): string | null {
  try {
    const lines = jsonlOutput.trim().split("\n");
    for (const line of lines) {
      const parsed = JSON.parse(line);
      if (parsed.session_id) {
        return parsed.session_id as string;
      }
      // session ID が id フィールドに入っている場合もある
      if (parsed.id && typeof parsed.id === "string") {
        return parsed.id;
      }
    }
  } catch {
    logger.debug("Codex セッション ID の抽出に失敗しました");
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
