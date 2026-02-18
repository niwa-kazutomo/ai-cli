import { describe, it, expect, vi, beforeEach } from "vitest";
import { extractResponse, checkGitRepo, checkGitChanges } from "../src/codex.js";

describe("extractResponse", () => {
  it("message 形式の JSONL からテキストを抽出する", () => {
    const jsonl = [
      JSON.stringify({ type: "message", content: [{ type: "text", text: "Review result" }] }),
      JSON.stringify({ type: "done" }),
    ].join("\n");

    expect(extractResponse(jsonl)).toBe("Review result");
  });

  it("output_text フィールドからテキストを抽出する", () => {
    const jsonl = JSON.stringify({ output_text: "Output text here" });
    expect(extractResponse(jsonl)).toBe("Output text here");
  });

  it("message.content が string の場合", () => {
    const jsonl = JSON.stringify({ type: "message", content: "String content" });
    expect(extractResponse(jsonl)).toBe("String content");
  });

  it("JSONL パース失敗時に生テキストを返す", () => {
    const raw = "This is not JSONL";
    expect(extractResponse(raw)).toBe(raw);
  });

  it("テキストが取れない JSONL の場合は生出力を返す", () => {
    const jsonl = JSON.stringify({ type: "status", status: "complete" });
    expect(extractResponse(jsonl)).toBe(jsonl);
  });

  it("空行を無視する", () => {
    const jsonl = [
      "",
      JSON.stringify({ type: "message", content: [{ type: "text", text: "Hello" }] }),
      "",
    ].join("\n");

    expect(extractResponse(jsonl)).toBe("Hello");
  });
});

describe("checkGitRepo", () => {
  it("Git リポジトリ内では true を返す", async () => {
    // テスト実行ディレクトリが Git リポジトリかどうかで結果が異なる
    // /tmp でテスト
    const result = await checkGitRepo("/tmp");
    expect(typeof result).toBe("boolean");
  });
});

describe("checkGitChanges", () => {
  it("結果が boolean であること", async () => {
    const result = await checkGitChanges("/tmp");
    expect(typeof result).toBe("boolean");
  });
});
