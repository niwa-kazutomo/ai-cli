import { describe, it, expect, vi, beforeEach } from "vitest";
import { runCli, checkCapabilities } from "../src/cli-runner.js";

describe("runCli", () => {
  it("正常にコマンドを実行して stdout/stderr をキャプチャする", async () => {
    const result = await runCli("echo", {
      args: ["hello"],
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("hello");
  });

  it("非ゼロ終了コードを返す", async () => {
    const result = await runCli("sh", {
      args: ["-c", "exit 42"],
    });

    expect(result.exitCode).toBe(42);
  });

  it("タイムアウトでエラーを投げる", async () => {
    await expect(
      runCli("sleep", {
        args: ["10"],
        timeoutMs: 100,
      }),
    ).rejects.toThrow("タイムアウト");
  });

  it("存在しないコマンドでエラーを投げる", async () => {
    await expect(
      runCli("nonexistent-command-12345", {
        args: [],
      }),
    ).rejects.toThrow("起動に失敗");
  });

  it("CLAUDECODE 環境変数を削除する", async () => {
    // 環境変数をセットしてコマンドを実行
    const originalEnv = process.env.CLAUDECODE;
    process.env.CLAUDECODE = "test-value";

    try {
      const result = await runCli("sh", {
        args: ["-c", "echo $CLAUDECODE"],
      });

      // CLAUDECODE は spawn に渡す env から削除されるので空文字になるはず
      expect(result.stdout.trim()).toBe("");
    } finally {
      if (originalEnv !== undefined) {
        process.env.CLAUDECODE = originalEnv;
      } else {
        delete process.env.CLAUDECODE;
      }
    }
  });

  it("ストリーミングコールバックが呼ばれる", async () => {
    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];

    await runCli("sh", {
      args: ["-c", 'echo "out" && echo "err" >&2'],
      onStdout: (chunk) => stdoutChunks.push(chunk),
      onStderr: (chunk) => stderrChunks.push(chunk),
    });

    expect(stdoutChunks.join("")).toContain("out");
    expect(stderrChunks.join("")).toContain("err");
  });
});

describe("checkCapabilities", () => {
  it("echo の --help で存在するフラグを検出する", async () => {
    // echo は --help をサポートしないが sh -c "echo ..." で代用
    const result = await checkCapabilities("sh", ["-c", "echo '--print --json'"], [
      "--print",
      "--json",
    ]);

    expect(result.supported).toBe(true);
    expect(result.missingFlags).toEqual([]);
  });

  it("存在しないフラグを検出する", async () => {
    const result = await checkCapabilities(
      "sh",
      ["-c", "echo '--print'"],
      ["--print", "--nonexistent-flag"],
    );

    expect(result.supported).toBe(false);
    expect(result.missingFlags).toEqual(["--nonexistent-flag"]);
  });

  it("コマンドが存在しない場合にすべてのフラグを missing とする", async () => {
    const result = await checkCapabilities(
      "nonexistent-cmd-12345",
      ["--help"],
      ["--flag1", "--flag2"],
    );

    expect(result.supported).toBe(false);
    expect(result.missingFlags).toEqual(["--flag1", "--flag2"]);
  });
});
