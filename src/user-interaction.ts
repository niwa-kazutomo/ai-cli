import { createInterface } from "node:readline";
import type { ReviewQuestion } from "./types.js";
import { SigintError } from "./errors.js";

function createReadlineInterface() {
  return createInterface({
    input: process.stdin,
    output: process.stderr, // stderr に出力（stdout を汚染しない）
  });
}

/**
 * ユーザーに yes/no の確認を求める。
 * Ctrl+C (SIGINT) → SigintError を reject。
 * EOF (close) → false を resolve。
 */
export async function confirmYesNo(message: string): Promise<boolean> {
  const rl = createReadlineInterface();
  return new Promise((resolve, reject) => {
    let settled = false;
    let interrupted = false;

    rl.on("SIGINT", () => {
      interrupted = true;
      rl.close();
    });

    rl.on("close", () => {
      if (!settled) {
        settled = true;
        if (interrupted) {
          reject(new SigintError());
        } else {
          resolve(false);
        }
      }
    });

    rl.question(message, (answer) => {
      if (!settled) {
        settled = true;
        rl.close();
        const normalized = answer.trim().toLowerCase();
        resolve(normalized === "yes" || normalized === "y");
      }
    });
  });
}

/**
 * readline の question を SIGINT/close セーフにラップする。
 * per-question スコープで settled/interrupted を管理する。
 */
function safeQuestion(
  rl: ReturnType<typeof createInterface>,
  prompt: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let interrupted = false;

    const onSigint = () => {
      interrupted = true;
      rl.close();
    };
    const onClose = () => {
      if (!settled) {
        settled = true;
        rl.removeListener("SIGINT", onSigint);
        rl.removeListener("close", onClose);
        // Ctrl+C (SIGINT) も Ctrl+D (EOF) もワークフロー中断として扱う
        reject(new SigintError());
      }
    };

    rl.on("SIGINT", onSigint);
    rl.on("close", onClose);

    rl.question(prompt, (answer) => {
      if (!settled) {
        settled = true;
        rl.removeListener("SIGINT", onSigint);
        rl.removeListener("close", onClose);
        resolve(answer);
      }
    });
  });
}

/**
 * レビュワーの質問に対してユーザーに選択肢を提示し、回答を収集する。
 */
export async function askQuestions(
  questions: ReviewQuestion[],
): Promise<string> {
  if (questions.length === 0) return "";

  const rl = createReadlineInterface();
  const answers: string[] = [];

  try {
    for (const q of questions) {
      process.stderr.write(`\n📋 ${q.question}\n`);
      q.choices.forEach((choice, i) => {
        process.stderr.write(`  ${i + 1}. ${choice}\n`);
      });
      process.stderr.write(`  0. その他（自由入力）\n`);

      const answer = await safeQuestion(rl, "選択してください (番号): ");
      const num = parseInt(answer.trim(), 10);

      if (num > 0 && num <= q.choices.length) {
        answers.push(`Q: ${q.question}\nA: ${q.choices[num - 1]}`);
      } else {
        const freeAnswer = await safeQuestion(rl, "回答を入力してください: ");
        answers.push(`Q: ${q.question}\nA: ${freeAnswer.trim()}`);
      }
    }
  } finally {
    rl.close();
  }

  return answers.join("\n\n");
}

/**
 * ユーザーにテキストを表示する（stderr に出力）。
 */
export function display(message: string): void {
  process.stderr.write(`${message}\n`);
}

/**
 * 区切り線を表示する。
 */
export function displaySeparator(): void {
  process.stderr.write(`${"─".repeat(60)}\n`);
}
