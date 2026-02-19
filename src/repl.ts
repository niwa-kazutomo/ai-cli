import { createInterface } from "node:readline";
import { readFileSync, writeFileSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { runWorkflow } from "./orchestrator.js";
import { readLine } from "./line-editor.js";
import { SigintError } from "./errors.js";
import { REPL_PROMPT, REPL_CONTINUATION_PROMPT, REPL_MESSAGES } from "./constants.js";
import * as logger from "./logger.js";
import type { ReplOptions } from "./types.js";

const HISTORY_FILE = join(homedir(), ".ai_cli_history");
const MAX_HISTORY_SIZE = 500;
const HISTORY_FORMAT_HEADER = "AIH2\n";

function loadHistory(filePath: string): string[] {
  try {
    const content = readFileSync(filePath, "utf-8");
    if (content.startsWith(HISTORY_FORMAT_HEADER)) {
      const body = content.slice(HISTORY_FORMAT_HEADER.length);
      return body.split("\0").filter((s) => s.length > 0).slice(0, MAX_HISTORY_SIZE);
    }
    // Legacy format fallback: newline-separated
    return content.split("\n").map((s) => s.trim()).filter((s) => s.length > 0).slice(0, MAX_HISTORY_SIZE);
  } catch {
    return [];
  }
}

function saveHistory(filePath: string, history: string[]): void {
  try {
    const body = history.slice(0, MAX_HISTORY_SIZE).join("\0") + "\0";
    writeFileSync(filePath, HISTORY_FORMAT_HEADER + body, { mode: 0o600 });
    chmodSync(filePath, 0o600);
  } catch (err) {
    logger.debug(`ヒストリーファイルの保存に失敗: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Fallback prompt for non-TTY or environments without setRawMode.
 * Uses node:readline createInterface.
 */
function promptOnceSimple(history: string[]): Promise<string | null> {
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
        resolve("");
      }
    });

    rl.on("close", () => {
      if (!settled) {
        settled = true;
        resolve(null);
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

/**
 * Read one prompt input. Uses the custom line editor for TTY with setRawMode,
 * falls back to node:readline otherwise.
 *
 * @returns Input string. Ctrl+C → "" (re-prompt), EOF (Ctrl+D) → null.
 */
async function promptOnce(history: string[]): Promise<string | null> {
  if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== "function") {
    return promptOnceSimple(history);
  }
  const result = await readLine({
    prompt: REPL_PROMPT,
    continuationPrompt: REPL_CONTINUATION_PROMPT,
    history,
    output: process.stderr,
    input: process.stdin,
  });
  switch (result.type) {
    case "input": return result.value;
    case "cancel": return "";
    case "eof": return null;
  }
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

    if (!trimmed) continue;

    if (trimmed === "exit" || trimmed === "quit") {
      process.stderr.write(`${REPL_MESSAGES.GOODBYE}\n`);
      break;
    }

    // Save raw input to history (dedup consecutive)
    if (history[0] !== result) {
      history.unshift(result);
      if (history.length > MAX_HISTORY_SIZE) history.pop();
    }
    saveHistory(historyFile, history);

    const sigintHandler = () => {
      /* swallow — handled by child processes or readline */
    };
    process.on("SIGINT", sigintHandler);

    try {
      await runWorkflow({ ...options, prompt: result });
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
