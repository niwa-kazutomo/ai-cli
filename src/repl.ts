import { createInterface } from "node:readline";
import { runWorkflow } from "./orchestrator.js";
import { SigintError } from "./errors.js";
import { REPL_PROMPT, REPL_MESSAGES } from "./constants.js";
import type { ReplOptions } from "./types.js";

/**
 * プロンプトを1行読み取って返す。
 * ワークフロー実行中は readline が存在しないため、user-interaction.ts と競合しない。
 *
 * @returns 入力文字列。Ctrl+C → ""（再プロンプト）、EOF (Ctrl+D) → null。
 */
function promptOnce(): Promise<string | null> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stderr });
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

export async function startRepl(options: ReplOptions, version: string): Promise<void> {
  process.stderr.write(REPL_MESSAGES.WELCOME(version));

  while (true) {
    const result = await promptOnce();

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
