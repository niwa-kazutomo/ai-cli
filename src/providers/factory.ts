import { checkCapabilities } from "../cli-runner.js";
import { DEFAULT_GENERATOR_CLI, DEFAULT_REVIEWER_CLI, DEFAULT_JUDGE_CLI } from "../constants.js";
import type { CliChoice, CodexSandboxMode } from "../types.js";
import type { Generator, Reviewer, Judge } from "./types.js";
import type { CliBackend } from "./backend.js";
import { ClaudeCliBackend } from "./claude-backend.js";
import { CodexCliBackend } from "./codex-backend.js";
import { GeneratorImpl } from "./generator-impl.js";
import { ReviewerImpl } from "./reviewer-impl.js";
import { JudgeImpl } from "./judge-impl.js";

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
  const genCli = config.generatorCli ?? DEFAULT_GENERATOR_CLI;
  const revCli = config.reviewerCli ?? DEFAULT_REVIEWER_CLI;
  const judCli = config.judgeCli ?? DEFAULT_JUDGE_CLI;

  const canStreamClaude = config.streaming && config.canStreamClaude;

  // ロールごとに独立したバックエンドインスタンスを生成（セッション汚染防止）
  function createBackend(cli: CliChoice, forRole: "generator" | "reviewer" | "judge"): CliBackend {
    // Judge は Claude/Codex とも streaming: false 固定
    const isJudge = forRole === "judge";

    if (cli === "codex") {
      return new CodexCliBackend({
        cwd: config.cwd,
        model: config.codexModel,
        streaming: isJudge ? false : config.streaming,
        onStdout: config.onStdout,
        onStderr: config.onStderr,
      });
    }
    // Claude: streaming は canStreamClaude で制御
    const streaming = isJudge ? false : canStreamClaude;
    return new ClaudeCliBackend({
      cwd: config.cwd,
      model: config.claudeModel,
      streaming: streaming || undefined,
      onStdout: (streaming || isJudge) ? config.onStdout : undefined,
      onStderr: config.onStderr,
    });
  }

  const generator = new GeneratorImpl(
    createBackend(genCli, "generator"),
    { dangerous: config.dangerous, requireSessionId: genCli === "claude" },
  );

  const reviewer = new ReviewerImpl(
    createBackend(revCli, "reviewer"),
    { sandboxMode: config.codexSandbox },
  );

  const judge = new JudgeImpl(
    createBackend(judCli, "judge"),
  );

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
  const gen = selections?.generatorCli ?? DEFAULT_GENERATOR_CLI;
  const rev = selections?.reviewerCli ?? DEFAULT_REVIEWER_CLI;
  const jud = selections?.judgeCli ?? DEFAULT_JUDGE_CLI;

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
