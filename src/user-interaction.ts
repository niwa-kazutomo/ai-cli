import { createInterface } from "node:readline";
import type { ReviewQuestion } from "./types.js";

function createReadlineInterface() {
  return createInterface({
    input: process.stdin,
    output: process.stderr, // stderr に出力（stdout を汚染しない）
  });
}

/**
 * ユーザーに yes/no の確認を求める。
 */
export async function confirmYesNo(message: string): Promise<boolean> {
  const rl = createReadlineInterface();
  return new Promise((resolve) => {
    rl.question(message, (answer) => {
      rl.close();
      const normalized = answer.trim().toLowerCase();
      resolve(normalized === "yes" || normalized === "y");
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

  for (const q of questions) {
    await new Promise<void>((resolve) => {
      process.stderr.write(`\n📋 ${q.question}\n`);
      q.choices.forEach((choice, i) => {
        process.stderr.write(`  ${i + 1}. ${choice}\n`);
      });
      process.stderr.write(`  0. その他（自由入力）\n`);

      rl.question("選択してください (番号): ", (answer) => {
        const num = parseInt(answer.trim(), 10);
        if (num > 0 && num <= q.choices.length) {
          answers.push(`Q: ${q.question}\nA: ${q.choices[num - 1]}`);
          resolve();
        } else {
          // 自由入力
          rl.question("回答を入力してください: ", (freeAnswer) => {
            answers.push(`Q: ${q.question}\nA: ${freeAnswer.trim()}`);
            resolve();
          });
        }
      });
    });
  }

  rl.close();
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
