import { checkCapabilities } from "../cli-runner.js";
import type { CodexSandboxMode } from "../types.js";
import type { Generator, Reviewer, Judge } from "./types.js";
import { ClaudeCodeGenerator } from "./claude-code-generator.js";
import { CodexReviewer } from "./codex-reviewer.js";
import { ClaudeCodeJudge } from "./claude-code-judge.js";

export interface ProviderConfig {
  cwd: string;
  claudeModel?: string;
  codexModel?: string;
  dangerous?: boolean;
  codexSandbox?: CodexSandboxMode;
  streaming?: boolean;
  canStreamClaude?: boolean;
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
}

export interface Providers {
  generator: Generator;
  reviewer: Reviewer;
  judge: Judge;
}

export function createProviders(config: ProviderConfig): Providers {
  const canStream = config.streaming && config.canStreamClaude;

  const generator = new ClaudeCodeGenerator({
    cwd: config.cwd,
    model: config.claudeModel,
    dangerous: config.dangerous,
    streaming: canStream,
    onStdout: canStream ? config.onStdout : undefined,
    onStderr: config.onStderr,
  });

  const reviewer = new CodexReviewer({
    cwd: config.cwd,
    model: config.codexModel,
    sandbox: config.codexSandbox,
    streaming: config.streaming,
    onStdout: config.onStdout,
    onStderr: config.onStderr,
  });

  const judge = new ClaudeCodeJudge({
    cwd: config.cwd,
    model: config.claudeModel,
    onStdout: config.onStdout,
    onStderr: config.onStderr,
  });

  return { generator, reviewer, judge };
}

/**
 * 起動時の capability check を実行する。
 * 非対応フラグが検出された場合はエラーメッセージを返す。
 */
export async function validateProviderCapabilities(
  dangerous: boolean,
  cwd?: string,
): Promise<string | null> {
  const claudeFlags = [
    "--print",
    "--output-format",
    "--resume",
    "--permission-mode",
    "--no-session-persistence",
  ];
  // dangerous=true の場合のみ追加
  if (dangerous) {
    claudeFlags.push("--dangerously-skip-permissions");
  }

  const errors: string[] = [];

  const claudeResult = await checkCapabilities("claude", ["--help"], claudeFlags, cwd);
  if (!claudeResult.supported) {
    errors.push(
      `claude: 以下のフラグが非対応です: ${claudeResult.missingFlags.join(", ")}`,
    );
  }

  const codexResult = await checkCapabilities("codex", ["exec", "--help"], ["--sandbox", "--json"], cwd);
  if (!codexResult.supported) {
    errors.push(
      `codex exec: 以下のフラグが非対応です: ${codexResult.missingFlags.join(", ")}`,
    );
  }

  if (errors.length > 0) {
    return `CLI の互換性チェックに失敗しました:\n${errors.join("\n")}\n\nClaude Code および Codex CLI のバージョンを確認してください。`;
  }

  return null;
}

/**
 * Claude CLI が stream-json ストリーミングに対応しているかチェックする。
 */
export async function checkClaudeStreamingCapability(cwd?: string): Promise<boolean> {
  const result = await checkCapabilities(
    "claude",
    ["--help"],
    ["stream-json", "--include-partial-messages"],
    cwd,
  );
  return result.supported;
}
