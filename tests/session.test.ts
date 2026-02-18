import { describe, it, expect } from "vitest";
import {
  createSession,
  markClaudeUsed,
  markCodexUsed,
  extractCodexSessionId,
  buildSummaryContext,
} from "../src/session.js";

describe("createSession", () => {
  it("claudeSessionId が null で初期化される", () => {
    const session = createSession();

    expect(session.claudeSessionId).toBeNull();
    expect(session.claudeFirstRun).toBe(true);
    expect(session.codexSessionId).toBeNull();
    expect(session.codexFirstRun).toBe(true);
  });
});

describe("markClaudeUsed", () => {
  it("claudeFirstRun を false にする", () => {
    const session = createSession();
    expect(session.claudeFirstRun).toBe(true);

    markClaudeUsed(session);
    expect(session.claudeFirstRun).toBe(false);
  });
});

describe("markCodexUsed", () => {
  it("codexFirstRun を false にする", () => {
    const session = createSession();
    expect(session.codexFirstRun).toBe(true);

    markCodexUsed(session);
    expect(session.codexFirstRun).toBe(false);
  });
});

describe("extractCodexSessionId", () => {
  it("thread.started の thread_id を抽出する", () => {
    const jsonl = JSON.stringify({ type: "thread.started", thread_id: "0199a213-abcd-1234" });
    expect(extractCodexSessionId(jsonl)).toBe("0199a213-abcd-1234");
  });

  it("session_id フィールドをフォールバックで抽出する", () => {
    const jsonl = JSON.stringify({ type: "init", session_id: "sess-abc123" });
    expect(extractCodexSessionId(jsonl)).toBe("sess-abc123");
  });

  it("thread_id が session_id より優先される", () => {
    const jsonl = [
      JSON.stringify({ type: "thread.started", thread_id: "thread-id" }),
      JSON.stringify({ type: "init", session_id: "session-id" }),
    ].join("\n");
    expect(extractCodexSessionId(jsonl)).toBe("thread-id");
  });

  it("複数行の JSONL で thread.started の thread_id を返す", () => {
    const jsonl = [
      JSON.stringify({ type: "thread.started", thread_id: "first-thread" }),
      JSON.stringify({ type: "item.completed", item: { id: "item_1", type: "agent_message", text: "Hello" } }),
    ].join("\n");

    expect(extractCodexSessionId(jsonl)).toBe("first-thread");
  });

  it("thread_id も session_id も存在しない場合は null を返す", () => {
    const jsonl = JSON.stringify({ type: "item.completed", item: { id: "item_1", type: "agent_message", text: "Hello" } });
    expect(extractCodexSessionId(jsonl)).toBeNull();
  });

  it("不正な JSON 行をスキップして後続の thread.started を取る", () => {
    const jsonl = [
      "not valid json",
      JSON.stringify({ type: "thread.started", thread_id: "after-invalid" }),
    ].join("\n");
    expect(extractCodexSessionId(jsonl)).toBe("after-invalid");
  });

  it("全行が不正な JSONL で null を返す", () => {
    expect(extractCodexSessionId("not valid json")).toBeNull();
  });

  it("空文字列で null を返す", () => {
    expect(extractCodexSessionId("")).toBeNull();
  });
});

describe("buildSummaryContext", () => {
  it("要約コンテキストを正しく構築する", () => {
    const result = buildSummaryContext("計画の内容", "レビューの内容");

    expect(result).toContain("計画の要約");
    expect(result).toContain("計画の内容");
    expect(result).toContain("レビューの要約");
    expect(result).toContain("レビューの内容");
  });
});
