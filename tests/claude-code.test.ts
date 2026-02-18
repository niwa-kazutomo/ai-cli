import { describe, it, expect } from "vitest";
import { extractResponse } from "../src/claude-code.js";

describe("extractResponse", () => {
  it("result フィールドからテキストを抽出する", () => {
    const json = JSON.stringify({ result: "Hello World" });
    expect(extractResponse(json)).toBe("Hello World");
  });

  it("content 配列からテキストを抽出する", () => {
    const json = JSON.stringify({
      content: [
        { type: "text", text: "First part" },
        { type: "tool_use", id: "123" },
        { type: "text", text: "Second part" },
      ],
    });
    expect(extractResponse(json)).toBe("First part\nSecond part");
  });

  it("text フィールドからテキストを抽出する", () => {
    const json = JSON.stringify({ text: "Simple text" });
    expect(extractResponse(json)).toBe("Simple text");
  });

  it("JSON パース失敗時に生テキストを返す", () => {
    const raw = "This is not JSON {invalid";
    expect(extractResponse(raw)).toBe(raw);
  });

  it("文字列の JSON を返す", () => {
    const json = JSON.stringify("Just a string");
    expect(extractResponse(json)).toBe("Just a string");
  });

  it("既知のフィールドがないオブジェクトを JSON 文字列化して返す", () => {
    const obj = { unknown: "field", data: [1, 2, 3] };
    const json = JSON.stringify(obj);
    expect(extractResponse(json)).toBe(json);
  });
});
