#!/usr/bin/env node
import { Command } from "commander";
import { runWorkflow } from "./orchestrator.js";
import { configureLogger } from "./logger.js";
import {
  DEFAULT_MAX_PLAN_ITERATIONS,
  DEFAULT_MAX_CODE_ITERATIONS,
} from "./constants.js";

const program = new Command();

program
  .name("ai")
  .description(
    "Claude Code と Codex を連携し、高品質なコード生成を実現する CLI ツール",
  )
  .version("0.1.0");

program
  .command("plan")
  .description("プロンプトに基づいてプラン生成・レビュー・コード生成を実行する")
  .argument("<prompt>", "実装内容を記述したプロンプト")
  .option(
    "--max-plan-iterations <n>",
    "プランレビュー最大回数",
    String(DEFAULT_MAX_PLAN_ITERATIONS),
  )
  .option(
    "--max-code-iterations <n>",
    "コードレビュー最大回数",
    String(DEFAULT_MAX_CODE_ITERATIONS),
  )
  .option("--claude-model <model>", "Claude Code のモデル指定")
  .option("--codex-model <model>", "Codex のモデル指定")
  .option(
    "--dangerous",
    "コード生成時に --dangerously-skip-permissions を使用",
    false,
  )
  .option("--verbose", "詳細ログ出力（内容は切り詰め）", false)
  .option("--debug", "全文ログ出力（開発用）", false)
  .option("--cwd <dir>", "作業ディレクトリ指定", process.cwd())
  .action(async (prompt: string, opts) => {
    configureLogger({
      verbose: opts.verbose || opts.debug,
      debug: opts.debug,
    });

    try {
      await runWorkflow({
        prompt,
        maxPlanIterations: parseInt(opts.maxPlanIterations, 10),
        maxCodeIterations: parseInt(opts.maxCodeIterations, 10),
        claudeModel: opts.claudeModel,
        codexModel: opts.codexModel,
        dangerous: opts.dangerous,
        verbose: opts.verbose,
        debug: opts.debug,
        cwd: opts.cwd,
      });
    } catch (err) {
      process.stderr.write(
        `\n❌ エラーが発生しました: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      process.exit(1);
    }
  });

program.parse();
