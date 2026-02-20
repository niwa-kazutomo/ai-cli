import { describe, it, expect, vi, beforeEach } from "vitest";
import { CodexGenerator } from "../../src/providers/codex-generator.js";

vi.mock("../../src/cli-runner.js", () => ({
  runCli: vi.fn(),
}));

vi.mock("../../src/logger.js", () => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  verbose: vi.fn(),
  debug: vi.fn(),
}));

import { runCli } from "../../src/cli-runner.js";
const mockRunCli = vi.mocked(runCli);

describe("CodexGenerator CLI引数", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("デフォルトで --sandbox workspace-write が使用される", async () => {
    mockRunCli.mockImplementation(async (_cmd, opts) => {
      const line = JSON.stringify({ type: "item.completed", item: { id: "item_1", type: "agent_message", text: "ok" } }) + "\n";
      opts.onStdout?.(line);
      return { exitCode: 0, stdout: line, stderr: "" };
    });

    const generator = new CodexGenerator({
      cwd: "/tmp",
      streaming: true,
      onStdout: () => {},
    });
    await generator.generatePlan("test prompt");

    const callArgs = mockRunCli.mock.calls[0][1].args;
    expect(callArgs).toContain("--sandbox");
    expect(callArgs).toContain("workspace-write");
    expect(callArgs).toContain("--json");
    expect(callArgs).toContain("test prompt");
  });

  it("dangerous=true で --sandbox danger-full-access が使用される", async () => {
    mockRunCli.mockImplementation(async (_cmd, opts) => {
      const line = JSON.stringify({ type: "item.completed", item: { id: "item_1", type: "agent_message", text: "ok" } }) + "\n";
      opts.onStdout?.(line);
      return { exitCode: 0, stdout: line, stderr: "" };
    });

    const generator = new CodexGenerator({
      cwd: "/tmp",
      dangerous: true,
      streaming: true,
      onStdout: () => {},
    });
    await generator.generatePlan("test prompt");

    const callArgs = mockRunCli.mock.calls[0][1].args;
    expect(callArgs).toContain("danger-full-access");
    expect(callArgs).not.toContain("workspace-write");
  });

  it("model が指定されていれば --model が引数に含まれる", async () => {
    mockRunCli.mockImplementation(async (_cmd, opts) => {
      const line = JSON.stringify({ type: "item.completed", item: { id: "item_1", type: "agent_message", text: "ok" } }) + "\n";
      opts.onStdout?.(line);
      return { exitCode: 0, stdout: line, stderr: "" };
    });

    const generator = new CodexGenerator({
      cwd: "/tmp",
      model: "o3-mini",
      streaming: true,
      onStdout: () => {},
    });
    await generator.generatePlan("test prompt");

    const callArgs = mockRunCli.mock.calls[0][1].args as string[];
    expect(callArgs).toContain("--model");
    expect(callArgs).toContain("o3-mini");
  });

  it("初回 generatePlan で exec が使用される（resume ではない）", async () => {
    mockRunCli.mockResolvedValue({
      exitCode: 0,
      stdout: JSON.stringify({ type: "item.completed", item: { id: "item_1", type: "agent_message", text: "plan" } }),
      stderr: "",
    });

    const generator = new CodexGenerator({ cwd: "/tmp" });
    await generator.generatePlan("test prompt");

    const callArgs = mockRunCli.mock.calls[0][1].args as string[];
    expect(callArgs[0]).toBe("exec");
    expect(callArgs).not.toContain("resume");
  });
});

describe("CodexGenerator セッション管理", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("初回レスポンスから session_id を保存し、2回目で resume を使う", async () => {
    // 1回目: セッション ID 取得
    mockRunCli.mockImplementation(async (_cmd, opts) => {
      const line1 = JSON.stringify({ type: "thread.started", thread_id: "sess-gen-resume" }) + "\n";
      const line2 = JSON.stringify({ type: "item.completed", item: { id: "item_1", type: "agent_message", text: "plan" } }) + "\n";
      opts.onStdout?.(line1 + line2);
      return { exitCode: 0, stdout: line1 + line2, stderr: "" };
    });

    const generator = new CodexGenerator({
      cwd: "/tmp",
      streaming: true,
      onStdout: () => {},
    });
    await generator.generatePlan("first prompt");

    // 2回目: resume を使う
    mockRunCli.mockImplementation(async (_cmd, opts) => {
      const line = JSON.stringify({ type: "item.completed", item: { id: "item_1", type: "agent_message", text: "revised" } }) + "\n";
      opts.onStdout?.(line);
      return { exitCode: 0, stdout: line, stderr: "" };
    });
    await generator.generatePlan("second prompt");

    const secondArgs = mockRunCli.mock.calls[1][1].args as string[];
    expect(secondArgs).toContain("resume");
    expect(secondArgs).toContain("sess-gen-resume");
  });

  it("generateCode でセッション ID がある場合は resume を使う", async () => {
    // 1回目: generatePlan でセッション ID 取得
    mockRunCli.mockImplementation(async (_cmd, opts) => {
      const line1 = JSON.stringify({ type: "thread.started", thread_id: "sess-code" }) + "\n";
      const line2 = JSON.stringify({ type: "item.completed", item: { id: "item_1", type: "agent_message", text: "plan" } }) + "\n";
      opts.onStdout?.(line1 + line2);
      return { exitCode: 0, stdout: line1 + line2, stderr: "" };
    });

    const generator = new CodexGenerator({
      cwd: "/tmp",
      streaming: true,
      onStdout: () => {},
    });
    await generator.generatePlan("plan prompt");

    // 2回目: generateCode で resume を使う
    mockRunCli.mockImplementation(async (_cmd, opts) => {
      const line = JSON.stringify({ type: "item.completed", item: { id: "item_1", type: "agent_message", text: "code" } }) + "\n";
      opts.onStdout?.(line);
      return { exitCode: 0, stdout: line, stderr: "" };
    });
    await generator.generateCode("code prompt");

    const secondArgs = mockRunCli.mock.calls[1][1].args as string[];
    expect(secondArgs).toContain("resume");
    expect(secondArgs).toContain("sess-code");
  });

  it("セッション ID 抽出失敗時に新規セッションで継続する", async () => {
    // 1回目: セッション ID なし
    mockRunCli.mockResolvedValue({
      exitCode: 0,
      stdout: JSON.stringify({ type: "item.completed", item: { id: "item_1", type: "agent_message", text: "ok" } }),
      stderr: "",
    });

    const generator = new CodexGenerator({ cwd: "/tmp" });
    await generator.generatePlan("first");

    // 2回目: セッション ID がないので新規セッション（resume ではない）
    mockRunCli.mockResolvedValue({
      exitCode: 0,
      stdout: JSON.stringify({ type: "item.completed", item: { id: "item_1", type: "agent_message", text: "ok" } }),
      stderr: "",
    });
    await generator.generatePlan("second");

    const secondArgs = mockRunCli.mock.calls[1][1].args as string[];
    expect(secondArgs).not.toContain("resume");
    expect(secondArgs).toContain("--sandbox");
    expect(secondArgs).toContain("workspace-write");
  });

  it("初回セッション ID 抽出失敗後、2回目の generatePlan でセッション ID を再抽出できる", async () => {
    // 1回目: セッション ID なし
    mockRunCli.mockResolvedValue({
      exitCode: 0,
      stdout: JSON.stringify({ type: "item.completed", item: { id: "item_1", type: "agent_message", text: "ok" } }),
      stderr: "",
    });

    const generator = new CodexGenerator({ cwd: "/tmp" });
    await generator.generatePlan("first");

    // 2回目: セッション ID が返ってくる → 再抽出して resume 可能に
    const line1 = JSON.stringify({ type: "thread.started", thread_id: "sess-recovered" });
    const line2 = JSON.stringify({ type: "item.completed", item: { id: "item_1", type: "agent_message", text: "revised" } });
    mockRunCli.mockResolvedValue({
      exitCode: 0,
      stdout: line1 + "\n" + line2,
      stderr: "",
    });
    await generator.generatePlan("second");

    // 3回目: 再抽出した ID で resume が使われる
    mockRunCli.mockResolvedValue({
      exitCode: 0,
      stdout: JSON.stringify({ type: "item.completed", item: { id: "item_1", type: "agent_message", text: "ok" } }),
      stderr: "",
    });
    await generator.generatePlan("third");

    const thirdArgs = mockRunCli.mock.calls[2][1].args as string[];
    expect(thirdArgs).toContain("resume");
    expect(thirdArgs).toContain("sess-recovered");
  });

  it("generateCode でセッション ID がない場合は新規セッションを使う", async () => {
    mockRunCli.mockResolvedValue({
      exitCode: 0,
      stdout: JSON.stringify({ type: "item.completed", item: { id: "item_1", type: "agent_message", text: "code" } }),
      stderr: "",
    });

    const generator = new CodexGenerator({ cwd: "/tmp" });
    await generator.generateCode("code prompt");

    const callArgs = mockRunCli.mock.calls[0][1].args as string[];
    expect(callArgs).not.toContain("resume");
    expect(callArgs).toContain("--sandbox");
    expect(callArgs).toContain("workspace-write");
  });
});

describe("CodexGenerator ストリーミング", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("streaming=true のとき JSONL をパースしてテキスト差分を onStdout に送出する", async () => {
    const chunks: string[] = [];

    mockRunCli.mockImplementation(async (_cmd, opts) => {
      const line1 = JSON.stringify({ type: "thread.started", thread_id: "sess-stream" }) + "\n";
      const line2 = JSON.stringify({ type: "item.started", item: { id: "item_1", type: "agent_message", text: "" } }) + "\n";
      const line3 = JSON.stringify({ type: "item.updated", item: { id: "item_1", type: "agent_message", text: "Hello" } }) + "\n";
      const line4 = JSON.stringify({ type: "item.completed", item: { id: "item_1", type: "agent_message", text: "Hello World" } }) + "\n";
      opts.onStdout?.(line1 + line2 + line3 + line4);
      return { exitCode: 0, stdout: line1 + line2 + line3 + line4, stderr: "" };
    });

    const generator = new CodexGenerator({
      cwd: "/tmp",
      streaming: true,
      onStdout: (chunk) => chunks.push(chunk),
    });
    const result = await generator.generatePlan("test prompt");

    expect(result.response).toBe("Hello World");
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.join("")).toBe("Hello World");
  });

  it("streaming=false のとき raw stdout パススルー", async () => {
    const chunks: string[] = [];

    const jsonl = JSON.stringify({ type: "item.completed", item: { id: "item_1", type: "agent_message", text: "Raw output" } }) + "\n";
    mockRunCli.mockImplementation(async (_cmd, opts) => {
      opts.onStdout?.(jsonl);
      return { exitCode: 0, stdout: jsonl, stderr: "" };
    });

    const generator = new CodexGenerator({
      cwd: "/tmp",
      streaming: false,
      onStdout: (chunk) => chunks.push(chunk),
    });
    const result = await generator.generatePlan("test prompt");

    expect(result.response).toBe("Raw output");
    expect(chunks).toEqual([jsonl]);
  });

  it("streaming=true で複数 item の agent_message が正しく結合される", async () => {
    const chunks: string[] = [];

    mockRunCli.mockImplementation(async (_cmd, opts) => {
      const line1 = JSON.stringify({ type: "item.completed", item: { id: "item_1", type: "agent_message", text: "First item" } }) + "\n";
      const line2 = JSON.stringify({ type: "item.completed", item: { id: "item_2", type: "agent_message", text: "Second item" } }) + "\n";
      opts.onStdout?.(line1 + line2);
      return { exitCode: 0, stdout: line1 + line2, stderr: "" };
    });

    const generator = new CodexGenerator({
      cwd: "/tmp",
      streaming: true,
      onStdout: (chunk) => chunks.push(chunk),
    });
    const result = await generator.generatePlan("test prompt");

    expect(result.response).toBe("First item\nSecond item");
    expect(chunks.join("")).toBe("First item\nSecond item");
  });
});

describe("CodexGenerator エラーハンドリング", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("generatePlan で exit code 非ゼロ時にエラーを投げる", async () => {
    mockRunCli.mockResolvedValue({
      exitCode: 1,
      stdout: "",
      stderr: "something went wrong",
    });

    const generator = new CodexGenerator({ cwd: "/tmp" });

    await expect(
      generator.generatePlan("test prompt"),
    ).rejects.toThrow("プラン生成が失敗しました");
  });

  it("generateCode で exit code 非ゼロ時にエラーを投げる", async () => {
    mockRunCli.mockResolvedValue({
      exitCode: 1,
      stdout: "",
      stderr: "code generation error",
    });

    const generator = new CodexGenerator({ cwd: "/tmp" });

    await expect(
      generator.generateCode("test prompt"),
    ).rejects.toThrow("コード生成が失敗しました");
  });

  it("generatePlan のエラーメッセージに exit code と stderr が含まれる", async () => {
    mockRunCli.mockResolvedValue({
      exitCode: 2,
      stdout: "",
      stderr: "detailed error info",
    });

    const generator = new CodexGenerator({ cwd: "/tmp" });

    await expect(
      generator.generatePlan("test prompt"),
    ).rejects.toThrow("exit code: 2");
  });
});

describe("CodexGenerator generateCode ストリーミング", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("streaming=true のとき JSONL をパースしてテキスト差分を送出する", async () => {
    const chunks: string[] = [];

    mockRunCli.mockImplementation(async (_cmd, opts) => {
      const line = JSON.stringify({ type: "item.completed", item: { id: "item_1", type: "agent_message", text: "Generated code" } }) + "\n";
      opts.onStdout?.(line);
      return { exitCode: 0, stdout: line, stderr: "" };
    });

    const generator = new CodexGenerator({
      cwd: "/tmp",
      streaming: true,
      onStdout: (chunk) => chunks.push(chunk),
    });
    const result = await generator.generateCode("generate prompt");

    expect(result.response).toBe("Generated code");
    expect(chunks.join("")).toBe("Generated code");
  });

  it("generateCode でセッション ID がない場合は sandboxMode を使う", async () => {
    mockRunCli.mockImplementation(async (_cmd, opts) => {
      const line = JSON.stringify({ type: "item.completed", item: { id: "item_1", type: "agent_message", text: "ok" } }) + "\n";
      opts.onStdout?.(line);
      return { exitCode: 0, stdout: line, stderr: "" };
    });

    const generator = new CodexGenerator({
      cwd: "/tmp",
      dangerous: true,
      streaming: true,
      onStdout: () => {},
    });
    await generator.generateCode("prompt");

    const callArgs = mockRunCli.mock.calls[0][1].args;
    expect(callArgs).toContain("--sandbox");
    expect(callArgs).toContain("danger-full-access");
    expect(callArgs).toContain("--json");
  });
});
