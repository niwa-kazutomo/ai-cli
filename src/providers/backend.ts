import type { CliRunResult } from "../types.js";

export interface BackendRunResult {
  raw: CliRunResult;
  /** 抽出されたテキストレスポンス */
  response: string;
  /** 抽出されたセッションID（存在する場合） */
  sessionId: string | null;
  /**
   * レスポンス抽出が成功したか（false の場合 response は生stdout）。
   * Claude Judge: プレーンテキスト出力 → 常に true
   * Codex Judge: JSONL から agent_message 抽出 → 抽出成否を反映
   * その他: JSON/JSONL パース成否を反映
   */
  extractionSucceeded: boolean;
}

export interface RunOptions {
  prompt: string;
  resumeSessionId: string | null;
  /** 操作ごとに設定するヒント（ロール実装が各メソッドで明示的に構築） */
  hints: OperationHints;
}

export interface OperationHints {
  /** 操作種別: バックエンドが出力形式・sandbox/permission を適切に設定するために使用 */
  operation: "generatePlan" | "generateCode" | "reviewPlan" | "reviewCode" | "judge";
  /** Generator code phase 用: dangerous モードか否か */
  dangerous?: boolean;
  /** Reviewer 用: sandbox モード指定 */
  sandboxMode?: "read-only" | "workspace-write" | "danger-full-access";
  /** Judge 用: セッション永続化を無効にするか */
  noSessionPersistence?: boolean;
}

export interface CliBackendConfig {
  cwd: string;
  model?: string;
  streaming?: boolean;
  /** streaming とは独立に渡す（Judge 等 streaming=false でも callback が必要） */
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
}

export interface CliBackend {
  run(options: RunOptions): Promise<BackendRunResult>;
}
