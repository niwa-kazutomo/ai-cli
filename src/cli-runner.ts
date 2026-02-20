import { spawn } from "node:child_process";
import { DEFAULT_TIMEOUT_MS } from "./constants.js";
import type { CliRunResult, CliRunOptions, CapabilityCheckResult } from "./types.js";
import * as logger from "./logger.js";

/**
 * 子プロセスを spawn で実行し、stdout/stderr をキャプチャする。
 * CLAUDECODE 環境変数を削除してネストセッション検出を回避する。
 */
export async function runCli(
  command: string,
  options: CliRunOptions,
): Promise<CliRunResult> {
  const { args, cwd, timeoutMs = DEFAULT_TIMEOUT_MS, onStdout, onStderr, env: extraEnv } = options;

  return new Promise((resolve, reject) => {
    const env = { ...process.env, ...extraEnv };
    // ネストセッション検出の回避
    delete env.CLAUDECODE;

    logger.debug(`実行: ${command} ${args.join(" ")}`);

    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stdout += text;
      onStdout?.(text);
    });

    child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stderr += text;
      onStderr?.(text);
    });

    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      // SIGTERM で停止しない場合に備えて SIGKILL
      setTimeout(() => {
        if (!child.killed) {
          child.kill("SIGKILL");
        }
      }, 5000);
      reject(
        new Error(
          `コマンドがタイムアウトしました (${timeoutMs / 1000}秒): ${command} ${args.join(" ")}`,
        ),
      );
    }, timeoutMs);

    child.on("error", (err) => {
      clearTimeout(timer);
      reject(
        new Error(
          `コマンドの起動に失敗しました: ${command} - ${err.message}`,
        ),
      );
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        exitCode: code ?? 1,
        stdout,
        stderr,
      });
    });
  });
}

/**
 * 指定コマンドの --help 出力から、必要なフラグが存在するかチェックする。
 */
export async function checkCapabilities(
  command: string,
  helpArgs: string[],
  requiredFlags: string[],
  cwd?: string,
): Promise<CapabilityCheckResult> {
  try {
    const result = await runCli(command, {
      args: helpArgs,
      cwd,
      timeoutMs: 30_000,
    });

    const helpText = result.stdout + result.stderr;
    const missingFlags: string[] = [];

    for (const flag of requiredFlags) {
      if (!helpText.includes(flag)) {
        missingFlags.push(flag);
      }
    }

    return {
      supported: missingFlags.length === 0,
      missingFlags,
    };
  } catch {
    return {
      supported: false,
      missingFlags: requiredFlags,
    };
  }
}

