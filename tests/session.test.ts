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
  it("session_id フィールドを抽出する", () => {
    const jsonl = JSON.stringify({ session_id: "sess-abc123" });
    expect(extractCodexSessionId(jsonl)).toBe("sess-abc123");
  });

  it("type: session の id フィールドを抽出する", () => {
    const jsonl = JSON.stringify({ type: "session", id: "id-xyz789" });
    expect(extractCodexSessionId(jsonl)).toBe("id-xyz789");
  });

  it("type が session でないイベントの id は無視する", () => {
    const jsonl = JSON.stringify({ type: "message", id: "msg_abc123" });
    expect(extractCodexSessionId(jsonl)).toBeNull();
  });

  it("複数行の JSONL で最初の session_id を返す", () => {
    const jsonl = [
      JSON.stringify({ type: "init", session_id: "first-id" }),
      JSON.stringify({ type: "message", content: "Hello" }),
    ].join("\n");

    expect(extractCodexSessionId(jsonl)).toBe("first-id");
  });

  it("session_id も id も存在しない場合は null を返す", () => {
    const jsonl = JSON.stringify({ type: "message", content: "no id" });
    expect(extractCodexSessionId(jsonl)).toBeNull();
  });

  it("不正な JSONL で null を返す", () => {
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
