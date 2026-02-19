import { createInterface } from "node:readline";
import { readFileSync, writeFileSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { runWorkflow } from "./orchestrator.js";
import { SigintError } from "./errors.js";
import { REPL_PROMPT, REPL_MESSAGES } from "./constants.js";
import * as logger from "./logger.js";
import type { ReplOptions } from "./types.js";

const HISTORY_FILE = join(homedir(), ".ai_cli_history");
const MAX_HISTORY_SIZE = 500;

function loadHistory(filePath: string): string[] {
  try {
    return readFileSync(filePath, "utf-8")
      .split("\n")
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
      .slice(0, MAX_HISTORY_SIZE);
  } catch {
    return [];
  }
}

function saveHistory(filePath: string, history: string[]): void {
  try {
    writeFileSync(filePath, history.slice(0, MAX_HISTORY_SIZE).join("\n") + "\n", { mode: 0o600 });
    chmodSync(filePath, 0o600);
  } catch (err) {
    logger.debug(`ヒストリーファイルの保存に失敗: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * プロンプトを1行読み取って返す。
 * ワークフロー実行中は readline が存在しないため、user-interaction.ts と競合しない。
 *
 * @returns 入力文字列。Ctrl+C → ""（再プロンプト）、EOF (Ctrl+D) → null。
 */
function promptOnce(history: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    const rl = createInterface({
      input: process.stdin,
      output: process.stderr,
      history: [...history],
      historySize: MAX_HISTORY_SIZE,
    });
    let settled = false;

    rl.on("SIGINT", () => {
      if (!settled) {
        settled = true;
        rl.close();
        resolve(""); // Ctrl+C → 空文字 → ループで continue → 再プロンプト
      }
    });

    rl.on("close", () => {
      if (!settled) {
        settled = true;
        resolve(null); // EOF
      }
    });

    rl.question(REPL_PROMPT, (answer) => {
      if (!settled) {
        settled = true;
        rl.close();
        resolve(answer);
      }
    });
  });
}

export async function startRepl(
  options: ReplOptions,
  version: string,
  activeOptionsLine?: string | null,
  historyFile: string = HISTORY_FILE,
): Promise<void> {
  process.stderr.write(REPL_MESSAGES.WELCOME(version));
  if (activeOptionsLine) {
    process.stderr.write(activeOptionsLine + "\n");
  }

  const history = loadHistory(historyFile);

  while (true) {
    const result = await promptOnce(history);

    if (result === null) {
      // EOF (Ctrl+D)
      process.stderr.write(`\n${REPL_MESSAGES.GOODBYE}\n`);
      break;
    }

    const trimmed = result.trim();

    if (!trimmed) continue; // 空入力・空白のみ → 再プロンプト

    if (trimmed === "exit" || trimmed === "quit") {
      process.stderr.write(`${REPL_MESSAGES.GOODBYE}\n`);
      break;
    }

    // マスター履歴を手動管理（連続重複のみ除去）
    if (history[0] !== trimmed) {
      history.unshift(trimmed);
      if (history.length > MAX_HISTORY_SIZE) history.pop();
    }
    saveHistory(historyFile, history);

    // ワークフロー実行中は process レベルの SIGINT を飲み込み、親プロセスの終了を防ぐ。
    // 子プロセスにはプロセスグループ経由で SIGINT が届く。
    // confirmYesNo/askQuestions は独自の readline SIGINT ハンドラで SigintError を throw する。
    const sigintHandler = () => {
      /* swallow — 子プロセスや readline 側で処理される */
    };
    process.on("SIGINT", sigintHandler);

    try {
      await runWorkflow({ ...options, prompt: trimmed });
    } catch (err) {
      if (err instanceof SigintError) {
        process.stderr.write("\n⚠ 中断しました。\n");
      } else {
        process.stderr.write(
          `\n❌ エラーが発生しました: ${err instanceof Error ? err.message : String(err)}\n`,
        );
      }
      process.stderr.write(`${REPL_MESSAGES.NEXT_PROMPT}\n`);
    } finally {
      process.removeListener("SIGINT", sigintHandler);
    }

    process.stderr.write("\n");
  }
}
