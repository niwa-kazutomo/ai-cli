import type { CliBackend, BackendRunResult } from "./backend.js";
import type { Generator, ProviderResult } from "./types.js";
import * as logger from "../logger.js";

export interface GeneratorImplOptions {
  dangerous?: boolean;
  /** Claude=true（初回抽出失敗で例外）, Codex=false（警告のみ、後続実行で回復可能） */
  requireSessionId?: boolean;
}

export class GeneratorImpl implements Generator {
  private sessionId: string | null = null;
  private readonly backend: CliBackend;
  private readonly dangerous: boolean;
  private readonly requireSessionId: boolean;

  constructor(backend: CliBackend, options: GeneratorImplOptions = {}) {
    this.backend = backend;
    this.dangerous = options.dangerous ?? false;
    this.requireSessionId = options.requireSessionId ?? false;
  }

  async generatePlan(prompt: string): Promise<ProviderResult> {
    const result = await this.backend.run({
      prompt,
      resumeSessionId: this.sessionId,
      hints: { operation: "generatePlan", dangerous: this.dangerous },
    });

    if (result.raw.exitCode !== 0) {
      throw new Error(
        `プラン生成が失敗しました (exit code: ${result.raw.exitCode})\n${result.raw.stderr}`,
      );
    }

    this.tryExtractSession(result);

    if (!result.response.trim()) {
      const summary = `exitCode: ${result.raw.exitCode}, stdout(${result.raw.stdout.length}chars): ${result.raw.stdout.slice(0, 200)}${result.raw.stdout.length > 200 ? "..." : ""}\nstderr(${result.raw.stderr.length}chars): ${result.raw.stderr.slice(-200)}`;
      logger.debug("generatePlan: 空レスポンス検出", summary);
    }

    return { response: result.response, raw: result.raw };
  }

  async generateCode(prompt: string): Promise<ProviderResult> {
    const result = await this.backend.run({
      prompt,
      resumeSessionId: this.sessionId,
      hints: { operation: "generateCode", dangerous: this.dangerous },
    });

    if (result.raw.exitCode !== 0) {
      throw new Error(
        `コード生成が失敗しました (exit code: ${result.raw.exitCode})\n${result.raw.stderr}`,
      );
    }

    this.tryExtractSession(result);
    return { response: result.response, raw: result.raw };
  }

  hasActiveSession(): boolean {
    return this.sessionId !== null;
  }

  /**
   * セッション ID 未取得なら毎回抽出を試行。
   * - requireSessionId=true (Claude): 初回抽出失敗で例外
   * - requireSessionId=false (Codex): 警告のみ、後続実行で回復可能
   */
  private tryExtractSession(result: BackendRunResult): void {
    if (this.sessionId) return; // 既に取得済み

    if (result.sessionId) {
      this.sessionId = result.sessionId;
      logger.debug(`Generator セッション ID 抽出成功: ${result.sessionId}`);
    } else if (this.requireSessionId) {
      throw new Error(
        "セッション ID を取得できませんでした。セッション継続が必要なワークフローのため停止します。",
      );
    } else {
      logger.verbose("セッション ID 抽出失敗。次回は新規セッションで実行します。");
    }
  }
}
