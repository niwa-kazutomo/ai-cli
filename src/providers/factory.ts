import { checkCapabilities } from "../cli-runner.js";
import type { CliChoice, CodexSandboxMode } from "../types.js";
import type { Generator, Reviewer, Judge } from "./types.js";
import { ClaudeCodeGenerator } from "./claude-code-generator.js";
import { CodexReviewer } from "./codex-reviewer.js";
import { ClaudeCodeJudge } from "./claude-code-judge.js";
import { CodexGenerator } from "./codex-generator.js";
import { ClaudeCodeReviewer } from "./claude-code-reviewer.js";
import { CodexJudge } from "./codex-judge.js";

export interface ProviderConfig {
  cwd: string;
  claudeModel?: string;
  codexModel?: string;
  dangerous?: boolean;
  codexSandbox?: CodexSandboxMode;
  streaming?: boolean;
  canStreamClaude?: boolean;
  generatorCli?: CliChoice;
  reviewerCli?: CliChoice;
  judgeCli?: CliChoice;
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
}

export interface Providers {
  generator: Generator;
  reviewer: Reviewer;
  judge: Judge;
}

export function createProviders(config: ProviderConfig): Providers {
  const genCli = config.generatorCli ?? "claude";
  const revCli = config.reviewerCli ?? "codex";
  const judCli = config.judgeCli ?? "claude";

  const canStream = config.streaming && config.canStreamClaude;

  // Generator
  let generator: Generator;
  if (genCli === "codex") {
    generator = new CodexGenerator({
      cwd: config.cwd,
      model: config.codexModel,
      dangerous: config.dangerous,
      streaming: config.streaming,
      onStdout: config.onStdout,
      onStderr: config.onStderr,
    });
  } else {
    generator = new ClaudeCodeGenerator({
      cwd: config.cwd,
      model: config.claudeModel,
      dangerous: config.dangerous,
      streaming: canStream,
      onStdout: canStream ? config.onStdout : undefined,
      onStderr: config.onStderr,
    });
  }

  // Reviewer
  let reviewer: Reviewer;
  if (revCli === "claude") {
    reviewer = new ClaudeCodeReviewer({
      cwd: config.cwd,
      model: config.claudeModel,
      streaming: canStream,
      onStdout: canStream ? config.onStdout : undefined,
      onStderr: config.onStderr,
    });
  } else {
    reviewer = new CodexReviewer({
      cwd: config.cwd,
      model: config.codexModel,
      sandbox: config.codexSandbox,
      streaming: config.streaming,
      onStdout: config.onStdout,
      onStderr: config.onStderr,
    });
  }

  // Judge
  let judge: Judge;
  if (judCli === "codex") {
    judge = new CodexJudge({
      cwd: config.cwd,
      model: config.codexModel,
      onStdout: config.onStdout,
      onStderr: config.onStderr,
    });
  } else {
    judge = new ClaudeCodeJudge({
      cwd: config.cwd,
      model: config.claudeModel,
      onStdout: config.onStdout,
      onStderr: config.onStderr,
    });
  }

  return { generator, reviewer, judge };
}

/**
 * 起動時の capability check を実行する。
 * ロール×CLI 単位で必要フラグを組み立て、検証する。
 */
export async function validateProviderCapabilities(
  dangerous: boolean,
  cwd?: string,
  selections?: { generatorCli?: CliChoice; reviewerCli?: CliChoice; judgeCli?: CliChoice },
): Promise<string | null> {
  const gen = selections?.generatorCli ?? "claude";
  const rev = selections?.reviewerCli ?? "codex";
  const jud = selections?.judgeCli ?? "claude";

  // Claude: ロール別に必要フラグを集約
  const claudeFlags = new Set<string>();
  if (gen === "claude") {
    ["--print", "--output-format", "--resume", "--permission-mode"].forEach(f => claudeFlags.add(f));
    if (dangerous) claudeFlags.add("--dangerously-skip-permissions");
  }
  if (rev === "claude") {
    ["--print", "--output-format", "--resume"].forEach(f => claudeFlags.add(f));
  }
  if (jud === "claude") {
    ["--print", "--no-session-persistence"].forEach(f => claudeFlags.add(f));
  }

  // Codex: ロール別に必要フラグを集約
  const codexFlags = new Set<string>(["--sandbox", "--json"]);
  const needsCodex = gen === "codex" || rev === "codex" || jud === "codex";
  // Generator/Reviewer が codex → resume サブコマンドが必要（セッション継続）
  if (gen === "codex" || rev === "codex") {
    codexFlags.add("resume");
  }

  const errors: string[] = [];

  if (claudeFlags.size > 0) {
    const claudeResult = await checkCapabilities("claude", ["--help"], [...claudeFlags], cwd);
    if (!claudeResult.supported) {
      errors.push(
        `claude: 以下のフラグが非対応です: ${claudeResult.missingFlags.join(", ")}`,
      );
    }
  }

  if (needsCodex) {
    const codexResult = await checkCapabilities("codex", ["exec", "--help"], [...codexFlags], cwd);
    if (!codexResult.supported) {
      errors.push(
        `codex exec: 以下のフラグが非対応です: ${codexResult.missingFlags.join(", ")}`,
      );
    }
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
