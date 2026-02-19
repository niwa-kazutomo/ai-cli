import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import { SigintError } from "../src/errors.js";

// Mock readline
const mockRl = {
  on: vi.fn(),
  question: vi.fn(),
  close: vi.fn(),
  removeListener: vi.fn(),
};

vi.mock("node:readline", () => ({
  createInterface: vi.fn(() => {
    // Reset listeners for each createInterface call
    const emitter = new EventEmitter();
    mockRl.on = vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      emitter.on(event, handler);
      return mockRl;
    });
    mockRl.close = vi.fn(() => {
      emitter.emit("close");
    });
    mockRl.question = vi.fn();
    mockRl.removeListener = vi.fn();
    (mockRl as Record<string, unknown>)._emitter = emitter;
    return mockRl;
  }),
}));

import { promptPlanApproval } from "../src/user-interaction.js";

function simulateAnswer(answer: string) {
  // Get the callback passed to rl.question and invoke it
  const questionCall = mockRl.question.mock.calls[0];
  const callback = questionCall[1] as (answer: string) => void;
  callback(answer);
}

function simulateSigint() {
  const emitter = (mockRl as Record<string, unknown>)._emitter as EventEmitter;
  emitter.emit("SIGINT");
}

function simulateEof() {
  // close without SIGINT = EOF
  const emitter = (mockRl as Record<string, unknown>)._emitter as EventEmitter;
  emitter.emit("close");
}

describe("promptPlanApproval", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("'y' で approve を返す", async () => {
    const promise = promptPlanApproval("prompt: ");
    simulateAnswer("y");
    await expect(promise).resolves.toEqual({ action: "approve" });
  });

  it("'yes' で approve を返す", async () => {
    const promise = promptPlanApproval("prompt: ");
    simulateAnswer("yes");
    await expect(promise).resolves.toEqual({ action: "approve" });
  });

  it("'Y' (大文字) で approve を返す", async () => {
    const promise = promptPlanApproval("prompt: ");
    simulateAnswer("Y");
    await expect(promise).resolves.toEqual({ action: "approve" });
  });

  it("'n' で abort を返す", async () => {
    const promise = promptPlanApproval("prompt: ");
    simulateAnswer("n");
    await expect(promise).resolves.toEqual({ action: "abort" });
  });

  it("'no' で abort を返す", async () => {
    const promise = promptPlanApproval("prompt: ");
    simulateAnswer("no");
    await expect(promise).resolves.toEqual({ action: "abort" });
  });

  it("空文字（Enter のみ）で abort を返す", async () => {
    const promise = promptPlanApproval("prompt: ");
    simulateAnswer("");
    await expect(promise).resolves.toEqual({ action: "abort" });
  });

  it("任意テキストで modify を返す", async () => {
    const promise = promptPlanApproval("prompt: ");
    simulateAnswer("エラーハンドリングを追加して");
    await expect(promise).resolves.toEqual({
      action: "modify",
      instruction: "エラーハンドリングを追加して",
    });
  });

  it("前後の空白がトリムされた modify を返す", async () => {
    const promise = promptPlanApproval("prompt: ");
    simulateAnswer("  テスト追加  ");
    await expect(promise).resolves.toEqual({
      action: "modify",
      instruction: "テスト追加",
    });
  });

  it("EOF (close) で abort を返す", async () => {
    const promise = promptPlanApproval("prompt: ");
    simulateEof();
    await expect(promise).resolves.toEqual({ action: "abort" });
  });

  it("SIGINT (Ctrl+C) で SigintError を reject する", async () => {
    const promise = promptPlanApproval("prompt: ");
    simulateSigint();
    await expect(promise).rejects.toThrow(SigintError);
  });
});
