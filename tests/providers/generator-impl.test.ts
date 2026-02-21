import { describe, it, expect, vi, beforeEach } from "vitest";
import { GeneratorImpl } from "../../src/providers/generator-impl.js";
import type { CliBackend, BackendRunResult } from "../../src/providers/backend.js";

vi.mock("../../src/logger.js", () => ({
  error: vi.fn(),
  warn: vi.fn(),
  verbose: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
}));

function createMockBackend(runFn?: CliBackend["run"]): CliBackend {
  return {
    run: runFn ?? vi.fn(),
  };
}

function makeResult(overrides: Partial<BackendRunResult> = {}): BackendRunResult {
  return {
    raw: { exitCode: 0, stdout: "", stderr: "" },
    response: "default response",
    sessionId: null,
    extractionSucceeded: true,
    ...overrides,
  };
}

describe("GeneratorImpl セッション管理", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("初回 generatePlan で resumeSessionId が null", async () => {
    const run = vi.fn().mockResolvedValue(makeResult({ sessionId: "sess-1" }));
    const backend = createMockBackend(run);
    const generator = new GeneratorImpl(backend);

    await generator.generatePlan("test prompt");

    expect(run.mock.calls[0][0].resumeSessionId).toBeNull();
  });

  it("初回レスポンスから session_id を保存し、2回目で resumeSessionId を渡す", async () => {
    const run = vi.fn()
      .mockResolvedValueOnce(makeResult({ sessionId: "sess-1", response: "plan" }))
      .mockResolvedValueOnce(makeResult({ response: "revised plan" }));
    const backend = createMockBackend(run);
    const generator = new GeneratorImpl(backend);

    await generator.generatePlan("first");
    await generator.generatePlan("second");

    expect(run.mock.calls[1][0].resumeSessionId).toBe("sess-1");
  });

  it("requireSessionId=true で session_id 抽出失敗時にエラーで停止する", async () => {
    const run = vi.fn().mockResolvedValue(makeResult({ sessionId: null }));
    const backend = createMockBackend(run);
    const generator = new GeneratorImpl(backend, { requireSessionId: true });

    await expect(generator.generatePlan("test")).rejects.toThrow("セッション ID");
  });

  it("requireSessionId=false で session_id 抽出失敗時に新規セッションで継続する", async () => {
    const run = vi.fn()
      .mockResolvedValueOnce(makeResult({ sessionId: null, response: "ok" }))
      .mockResolvedValueOnce(makeResult({ sessionId: null, response: "ok" }));
    const backend = createMockBackend(run);
    const generator = new GeneratorImpl(backend, { requireSessionId: false });

    await generator.generatePlan("first");
    await generator.generatePlan("second");

    // 2回目も resumeSessionId は null（セッション ID 未取得のため）
    expect(run.mock.calls[1][0].resumeSessionId).toBeNull();
  });

  it("初回セッション ID 抽出失敗後、2回目で回復できる", async () => {
    const run = vi.fn()
      .mockResolvedValueOnce(makeResult({ sessionId: null, response: "ok" }))
      .mockResolvedValueOnce(makeResult({ sessionId: "sess-recovered", response: "ok" }))
      .mockResolvedValueOnce(makeResult({ response: "ok" }));
    const backend = createMockBackend(run);
    const generator = new GeneratorImpl(backend, { requireSessionId: false });

    await generator.generatePlan("first");
    await generator.generatePlan("second");
    await generator.generatePlan("third");

    expect(run.mock.calls[2][0].resumeSessionId).toBe("sess-recovered");
  });

  it("generateCode でセッション ID がある場合は resumeSessionId を使う", async () => {
    const run = vi.fn()
      .mockResolvedValueOnce(makeResult({ sessionId: "sess-1" }))
      .mockResolvedValueOnce(makeResult({ response: "code" }));
    const backend = createMockBackend(run);
    const generator = new GeneratorImpl(backend);

    await generator.generatePlan("plan");
    await generator.generateCode("code prompt");

    expect(run.mock.calls[1][0].resumeSessionId).toBe("sess-1");
    expect(run.mock.calls[1][0].hints.operation).toBe("generateCode");
  });

  it("generateCode でセッション ID がない場合は resumeSessionId が null", async () => {
    const run = vi.fn().mockResolvedValue(makeResult({ response: "code" }));
    const backend = createMockBackend(run);
    const generator = new GeneratorImpl(backend);

    await generator.generateCode("code prompt");

    expect(run.mock.calls[0][0].resumeSessionId).toBeNull();
  });
});

describe("GeneratorImpl hints", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("generatePlan で operation が 'generatePlan' になる", async () => {
    const run = vi.fn().mockResolvedValue(makeResult({ sessionId: "s" }));
    const backend = createMockBackend(run);
    const generator = new GeneratorImpl(backend);

    await generator.generatePlan("test");

    expect(run.mock.calls[0][0].hints.operation).toBe("generatePlan");
  });

  it("generateCode (dangerous=true) で hints.dangerous が true になる", async () => {
    const run = vi.fn().mockResolvedValue(makeResult({ sessionId: "s" }));
    const backend = createMockBackend(run);
    const generator = new GeneratorImpl(backend, { dangerous: true });

    await generator.generateCode("test");

    expect(run.mock.calls[0][0].hints.operation).toBe("generateCode");
    expect(run.mock.calls[0][0].hints.dangerous).toBe(true);
  });

  it("generateCode (dangerous=false) で hints.dangerous が false になる", async () => {
    const run = vi.fn().mockResolvedValue(makeResult({ sessionId: "s" }));
    const backend = createMockBackend(run);
    const generator = new GeneratorImpl(backend, { dangerous: false });

    await generator.generateCode("test");

    expect(run.mock.calls[0][0].hints.dangerous).toBe(false);
  });
});

describe("GeneratorImpl エラーハンドリング", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("generatePlan で exit code 非ゼロ時にエラーを投げる", async () => {
    const run = vi.fn().mockResolvedValue(makeResult({
      raw: { exitCode: 1, stdout: "", stderr: "error" },
    }));
    const backend = createMockBackend(run);
    const generator = new GeneratorImpl(backend);

    await expect(generator.generatePlan("test")).rejects.toThrow("プラン生成が失敗しました");
  });

  it("generateCode で exit code 非ゼロ時にエラーを投げる", async () => {
    const run = vi.fn().mockResolvedValue(makeResult({
      raw: { exitCode: 1, stdout: "", stderr: "error" },
    }));
    const backend = createMockBackend(run);
    const generator = new GeneratorImpl(backend);

    await expect(generator.generateCode("test")).rejects.toThrow("コード生成が失敗しました");
  });

  it("エラーメッセージに exit code と stderr が含まれる", async () => {
    const run = vi.fn().mockResolvedValue(makeResult({
      raw: { exitCode: 2, stdout: "", stderr: "detailed error info" },
    }));
    const backend = createMockBackend(run);
    const generator = new GeneratorImpl(backend);

    await expect(generator.generatePlan("test")).rejects.toThrow("exit code: 2");
  });
});
