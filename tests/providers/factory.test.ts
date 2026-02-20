import { describe, it, expect, vi, beforeEach } from "vitest";
import { createProviders, validateProviderCapabilities, checkClaudeStreamingCapability } from "../../src/providers/factory.js";

vi.mock("../../src/cli-runner.js", () => ({
  runCli: vi.fn(),
  checkCapabilities: vi.fn(),
}));

vi.mock("../../src/logger.js", () => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  verbose: vi.fn(),
  debug: vi.fn(),
}));

import { checkCapabilities } from "../../src/cli-runner.js";
const mockCheckCapabilities = vi.mocked(checkCapabilities);

describe("validateProviderCapabilities", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("dangerous=false では --dangerously-skip-permissions を要求しない", async () => {
    mockCheckCapabilities.mockResolvedValue({ supported: true, missingFlags: [] });

    const result = await validateProviderCapabilities(false);
    expect(result).toBeNull();

    // claude の requiredFlags に --dangerously-skip-permissions が含まれないこと
    const claudeCall = mockCheckCapabilities.mock.calls[0];
    expect(claudeCall[2]).not.toContain("--dangerously-skip-permissions");
  });

  it("dangerous=true では --dangerously-skip-permissions を必須化する", async () => {
    mockCheckCapabilities.mockResolvedValue({ supported: true, missingFlags: [] });

    const result = await validateProviderCapabilities(true);
    expect(result).toBeNull();

    // claude の requiredFlags に --dangerously-skip-permissions が含まれること
    const claudeCall = mockCheckCapabilities.mock.calls[0];
    expect(claudeCall[2]).toContain("--dangerously-skip-permissions");
  });

  it("claude 非対応時にエラーメッセージを返す", async () => {
    mockCheckCapabilities
      .mockResolvedValueOnce({ supported: false, missingFlags: ["--resume"] })
      .mockResolvedValueOnce({ supported: true, missingFlags: [] });

    const result = await validateProviderCapabilities(false);
    expect(result).toContain("claude");
    expect(result).toContain("--resume");
  });

  it("codex 非対応時にエラーメッセージを返す", async () => {
    mockCheckCapabilities
      .mockResolvedValueOnce({ supported: true, missingFlags: [] })
      .mockResolvedValueOnce({ supported: false, missingFlags: ["--json"] });

    const result = await validateProviderCapabilities(false);
    expect(result).toContain("codex");
    expect(result).toContain("--json");
  });

  it("両方対応時に null を返す", async () => {
    mockCheckCapabilities.mockResolvedValue({ supported: true, missingFlags: [] });

    const result = await validateProviderCapabilities(false);
    expect(result).toBeNull();
  });

  it("全ロール codex の場合、claude チェックをスキップする", async () => {
    mockCheckCapabilities.mockResolvedValue({ supported: true, missingFlags: [] });

    const result = await validateProviderCapabilities(false, undefined, {
      generatorCli: "codex",
      reviewerCli: "codex",
      judgeCli: "codex",
    });
    expect(result).toBeNull();

    // checkCapabilities は codex のみ 1 回呼ばれる
    expect(mockCheckCapabilities).toHaveBeenCalledTimes(1);
    expect(mockCheckCapabilities.mock.calls[0][0]).toBe("codex");
  });

  it("全ロール claude の場合、codex チェックをスキップする", async () => {
    mockCheckCapabilities.mockResolvedValue({ supported: true, missingFlags: [] });

    const result = await validateProviderCapabilities(false, undefined, {
      generatorCli: "claude",
      reviewerCli: "claude",
      judgeCli: "claude",
    });
    expect(result).toBeNull();

    // checkCapabilities は claude のみ 1 回呼ばれる
    expect(mockCheckCapabilities).toHaveBeenCalledTimes(1);
    expect(mockCheckCapabilities.mock.calls[0][0]).toBe("claude");
  });

  it("Generator が codex の場合、codex フラグに resume が含まれる", async () => {
    mockCheckCapabilities.mockResolvedValue({ supported: true, missingFlags: [] });

    await validateProviderCapabilities(false, undefined, {
      generatorCli: "codex",
      reviewerCli: "claude",
      judgeCli: "claude",
    });

    // codex 呼び出しの requiredFlags に resume が含まれること
    const codexCall = mockCheckCapabilities.mock.calls.find(c => c[0] === "codex");
    expect(codexCall).toBeDefined();
    expect(codexCall![2]).toContain("resume");
  });

  it("Judge のみ codex の場合、codex フラグに resume が含まれない", async () => {
    mockCheckCapabilities.mockResolvedValue({ supported: true, missingFlags: [] });

    await validateProviderCapabilities(false, undefined, {
      generatorCli: "claude",
      reviewerCli: "claude",
      judgeCli: "codex",
    });

    // codex 呼び出しの requiredFlags に resume が含まれないこと
    const codexCall = mockCheckCapabilities.mock.calls.find(c => c[0] === "codex");
    expect(codexCall).toBeDefined();
    expect(codexCall![2]).not.toContain("resume");
  });

  it("Reviewer が claude の場合、claude フラグに --no-session-persistence が含まれる", async () => {
    mockCheckCapabilities.mockResolvedValue({ supported: true, missingFlags: [] });

    await validateProviderCapabilities(false, undefined, {
      generatorCli: "codex",
      reviewerCli: "claude",
      judgeCli: "codex",
    });

    const claudeCall = mockCheckCapabilities.mock.calls.find(c => c[0] === "claude");
    expect(claudeCall).toBeDefined();
    expect(claudeCall![2]).toContain("--no-session-persistence");
    expect(claudeCall![2]).toContain("--resume");
  });
});

describe("checkClaudeStreamingCapability", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("stream-json 対応時に true を返す", async () => {
    mockCheckCapabilities.mockResolvedValue({ supported: true, missingFlags: [] });

    const result = await checkClaudeStreamingCapability();
    expect(result).toBe(true);
  });

  it("stream-json 非対応時に false を返す", async () => {
    mockCheckCapabilities.mockResolvedValue({ supported: false, missingFlags: ["stream-json"] });

    const result = await checkClaudeStreamingCapability();
    expect(result).toBe(false);
  });
});

describe("createProviders", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("config から Generator/Reviewer/Judge インスタンスを生成する", () => {
    const providers = createProviders({
      cwd: "/tmp",
      claudeModel: "claude-3",
      codexModel: "codex-1",
    });

    expect(providers.generator).toBeDefined();
    expect(providers.reviewer).toBeDefined();
    expect(providers.judge).toBeDefined();
    expect(typeof providers.generator.generatePlan).toBe("function");
    expect(typeof providers.generator.generateCode).toBe("function");
    expect(typeof providers.reviewer.reviewPlan).toBe("function");
    expect(typeof providers.reviewer.reviewCode).toBe("function");
    expect(typeof providers.judge.judgeReview).toBe("function");
  });

  it("streaming=true かつ canStreamClaude=false のとき Claude は non-streaming で動作する", async () => {
    const { runCli } = await import("../../src/cli-runner.js");
    const mockRunCli = vi.mocked(runCli);

    const jsonResponse = JSON.stringify({
      session_id: "sess-1",
      result: "plan output",
    });
    mockRunCli.mockResolvedValue({
      exitCode: 0,
      stdout: jsonResponse,
      stderr: "",
    });

    const onStdout = vi.fn();

    // streaming=true, canStreamClaude=false → Claude は non-streaming
    const providers = createProviders({
      cwd: "/tmp",
      streaming: true,
      canStreamClaude: false,
      onStdout,
    });

    await providers.generator.generatePlan("test prompt");

    // runCli の args に stream-json が含まれないこと（non-streaming）
    const callArgs = mockRunCli.mock.calls[0][1].args;
    expect(callArgs).toContain("json");
    expect(callArgs).not.toContain("stream-json");
    // onStdout が Generator に渡されていないこと（canStream=false なので undefined）
    expect(mockRunCli.mock.calls[0][1].onStdout).toBeUndefined();
  });

  it("streaming=true かつ canStreamClaude=true のとき Claude は streaming で動作する", async () => {
    const { runCli } = await import("../../src/cli-runner.js");
    const mockRunCli = vi.mocked(runCli);

    mockRunCli.mockImplementation(async (_cmd, opts) => {
      const event = JSON.stringify({
        type: "result",
        subtype: "success",
        session_id: "sess-stream",
        result: "streamed plan",
      }) + "\n";
      opts.onStdout?.(event);
      return { exitCode: 0, stdout: event, stderr: "" };
    });

    const onStdout = vi.fn();

    const providers = createProviders({
      cwd: "/tmp",
      streaming: true,
      canStreamClaude: true,
      onStdout,
    });

    await providers.generator.generatePlan("test prompt");

    // runCli の args に stream-json が含まれること（streaming）
    const callArgs = mockRunCli.mock.calls[0][1].args;
    expect(callArgs).toContain("stream-json");
    expect(callArgs).not.toContain("json");
    // onStdout が runCli に渡されていること
    expect(mockRunCli.mock.calls[0][1].onStdout).toBeDefined();
  });

  it("codexSandbox が CodexReviewer の config に伝搬する", async () => {
    const { runCli } = await import("../../src/cli-runner.js");
    const mockRunCli = vi.mocked(runCli);

    mockRunCli.mockImplementation(async (_cmd, opts) => {
      const line = JSON.stringify({ type: "item.completed", item: { id: "item_1", type: "agent_message", text: "ok" } }) + "\n";
      opts.onStdout?.(line);
      return { exitCode: 0, stdout: line, stderr: "" };
    });

    const providers = createProviders({
      cwd: "/tmp",
      codexSandbox: "danger-full-access",
      streaming: true,
      onStdout: () => {},
    });

    await providers.reviewer.reviewCode("prompt");

    const callArgs = mockRunCli.mock.calls[0][1].args;
    expect(callArgs).toContain("danger-full-access");
  });

  it("generatorCli: 'codex' で CodexGenerator インスタンスが生成される", async () => {
    const { runCli } = await import("../../src/cli-runner.js");
    const mockRunCli = vi.mocked(runCli);

    const jsonl = JSON.stringify({ type: "thread.started", thread_id: "tid-1" }) + "\n"
      + JSON.stringify({ type: "item.completed", item: { id: "item_1", type: "agent_message", text: "codex plan" } }) + "\n";

    mockRunCli.mockResolvedValue({
      exitCode: 0,
      stdout: jsonl,
      stderr: "",
    });

    const providers = createProviders({
      cwd: "/tmp",
      codexModel: "o3",
      generatorCli: "codex",
    });

    const result = await providers.generator.generatePlan("test");
    expect(result.response).toBe("codex plan");
    // codex が呼ばれていること
    expect(mockRunCli.mock.calls[0][0]).toBe("codex");
  });

  it("generatorCli: 'codex' で codexModel が使用される", async () => {
    const { runCli } = await import("../../src/cli-runner.js");
    const mockRunCli = vi.mocked(runCli);

    const jsonl = JSON.stringify({ type: "thread.started", thread_id: "tid-1" }) + "\n"
      + JSON.stringify({ type: "item.completed", item: { id: "item_1", type: "agent_message", text: "plan" } }) + "\n";

    mockRunCli.mockResolvedValue({
      exitCode: 0,
      stdout: jsonl,
      stderr: "",
    });

    const providers = createProviders({
      cwd: "/tmp",
      claudeModel: "claude-model",
      codexModel: "codex-model",
      generatorCli: "codex",
    });

    await providers.generator.generatePlan("test");

    const callArgs = mockRunCli.mock.calls[0][1].args as string[];
    expect(callArgs).toContain("codex-model");
    expect(callArgs).not.toContain("claude-model");
  });

  it("reviewerCli: 'claude' で ClaudeCodeReviewer インスタンスが生成される", async () => {
    const { runCli } = await import("../../src/cli-runner.js");
    const mockRunCli = vi.mocked(runCli);

    mockRunCli.mockResolvedValue({
      exitCode: 0,
      stdout: JSON.stringify({ session_id: "sess-1", result: "review" }),
      stderr: "",
    });

    const providers = createProviders({
      cwd: "/tmp",
      reviewerCli: "claude",
    });

    const result = await providers.reviewer.reviewPlan("test");
    expect(result.response).toBe("review");
    // claude が呼ばれていること
    expect(mockRunCli.mock.calls[0][0]).toBe("claude");
  });

  it("judgeCli: 'codex' で CodexJudge インスタンスが生成される", async () => {
    const { runCli } = await import("../../src/cli-runner.js");
    const mockRunCli = vi.mocked(runCli);

    const jsonl = JSON.stringify({
      type: "item.completed",
      item: { id: "item_1", type: "agent_message", text: "### 概要\n問題なし\n\n### 懸念事項\n懸念事項なし" },
    });
    mockRunCli.mockResolvedValue({
      exitCode: 0,
      stdout: jsonl,
      stderr: "",
    });

    const providers = createProviders({
      cwd: "/tmp",
      judgeCli: "codex",
    });

    const result = await providers.judge.judgeReview("review");
    expect(result.has_p3_plus_concerns).toBe(false);
    // codex が呼ばれていること
    expect(mockRunCli.mock.calls[0][0]).toBe("codex");
  });

  it("generatorCli: 'codex' で --codex-sandbox が Generator に影響しない", async () => {
    const { runCli } = await import("../../src/cli-runner.js");
    const mockRunCli = vi.mocked(runCli);

    const jsonl = JSON.stringify({ type: "thread.started", thread_id: "tid-1" }) + "\n"
      + JSON.stringify({ type: "item.completed", item: { id: "item_1", type: "agent_message", text: "plan" } }) + "\n";

    mockRunCli.mockResolvedValue({
      exitCode: 0,
      stdout: jsonl,
      stderr: "",
    });

    const providers = createProviders({
      cwd: "/tmp",
      codexSandbox: "read-only",
      generatorCli: "codex",
    });

    await providers.generator.generatePlan("test");

    // CodexGenerator は codexSandbox を使わず、自身の sandboxMode (workspace-write) を使う
    const callArgs = mockRunCli.mock.calls[0][1].args as string[];
    expect(callArgs).toContain("workspace-write");
    expect(callArgs).not.toContain("read-only");
  });

  it("dangerous=true で CodexGenerator の sandbox が danger-full-access になる", async () => {
    const { runCli } = await import("../../src/cli-runner.js");
    const mockRunCli = vi.mocked(runCli);

    const jsonl = JSON.stringify({ type: "thread.started", thread_id: "tid-1" }) + "\n"
      + JSON.stringify({ type: "item.completed", item: { id: "item_1", type: "agent_message", text: "plan" } }) + "\n";

    mockRunCli.mockResolvedValue({
      exitCode: 0,
      stdout: jsonl,
      stderr: "",
    });

    const providers = createProviders({
      cwd: "/tmp",
      dangerous: true,
      generatorCli: "codex",
    });

    await providers.generator.generatePlan("test");

    const callArgs = mockRunCli.mock.calls[0][1].args as string[];
    expect(callArgs).toContain("danger-full-access");
    expect(callArgs).not.toContain("workspace-write");
  });

  it("reviewerCli: 'claude' + canStreamClaude=false で Reviewer は non-streaming", async () => {
    const { runCli } = await import("../../src/cli-runner.js");
    const mockRunCli = vi.mocked(runCli);

    mockRunCli.mockResolvedValue({
      exitCode: 0,
      stdout: JSON.stringify({ session_id: "sess-1", result: "review" }),
      stderr: "",
    });

    const onStdout = vi.fn();

    const providers = createProviders({
      cwd: "/tmp",
      streaming: true,
      canStreamClaude: false,
      reviewerCli: "claude",
      onStdout,
    });

    await providers.reviewer.reviewPlan("test");

    const callArgs = mockRunCli.mock.calls[0][1].args as string[];
    expect(callArgs).toContain("json");
    expect(callArgs).not.toContain("stream-json");
    expect(mockRunCli.mock.calls[0][1].onStdout).toBeUndefined();
  });
});
