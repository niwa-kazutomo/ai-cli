import { describe, it, expect } from "vitest";
import {
  StreamJsonLineBuffer,
  extractTextFromEvent,
  extractFromStreamEvents,
  type StreamJsonEvent,
} from "../src/stream-json-parser.js";

describe("StreamJsonLineBuffer", () => {
  it("完全な1行をパースして返す", () => {
    const buf = new StreamJsonLineBuffer();
    const events = buf.feed('{"type":"system","session_id":"s1"}\n');
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("system");
    expect(events[0].session_id).toBe("s1");
  });

  it("複数行を一括でパースする", () => {
    const buf = new StreamJsonLineBuffer();
    const events = buf.feed(
      '{"type":"system","session_id":"s1"}\n{"type":"assistant","message":{"content":[{"type":"text","text":"hi"}]}}\n',
    );
    expect(events).toHaveLength(2);
    expect(events[0].type).toBe("system");
    expect(events[1].type).toBe("assistant");
  });

  it("分割されたチャンクをバッファして正しくパースする", () => {
    const buf = new StreamJsonLineBuffer();
    const e1 = buf.feed('{"type":"sys');
    expect(e1).toHaveLength(0);

    const e2 = buf.feed('tem","session_id":"s1"}\n');
    expect(e2).toHaveLength(1);
    expect(e2[0].type).toBe("system");
  });

  it("空行をスキップする", () => {
    const buf = new StreamJsonLineBuffer();
    const events = buf.feed('\n\n{"type":"system"}\n\n');
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("system");
  });

  it("不正な JSON 行をスキップする", () => {
    const buf = new StreamJsonLineBuffer();
    const events = buf.feed('not json\n{"type":"system"}\n');
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("system");
  });

  it("type フィールドがないオブジェクトをスキップする", () => {
    const buf = new StreamJsonLineBuffer();
    const events = buf.feed('{"data":"no type"}\n{"type":"system"}\n');
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("system");
  });

  it("flush で残バッファを処理する", () => {
    const buf = new StreamJsonLineBuffer();
    buf.feed('{"type":"result","result":"done"}');
    // 改行がないので feed では返らない
    const e1 = buf.feed("");
    expect(e1).toHaveLength(0);

    const flushed = buf.flush();
    expect(flushed).toHaveLength(1);
    expect(flushed[0].type).toBe("result");
  });

  it("flush で空バッファは空配列を返す", () => {
    const buf = new StreamJsonLineBuffer();
    expect(buf.flush()).toHaveLength(0);
  });

  it("flush で不正な JSON は空配列を返す", () => {
    const buf = new StreamJsonLineBuffer();
    buf.feed("invalid json");
    expect(buf.flush()).toHaveLength(0);
  });
});

describe("extractTextFromEvent", () => {
  it("assistant イベントからテキストを抽出する", () => {
    const event: StreamJsonEvent = {
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "Hello " },
          { type: "text", text: "World" },
        ],
      },
    };
    expect(extractTextFromEvent(event)).toBe("Hello World");
  });

  it("text ブロックがない assistant イベントは null を返す", () => {
    const event: StreamJsonEvent = {
      type: "assistant",
      message: {
        content: [{ type: "tool_use", id: "123" }],
      },
    };
    expect(extractTextFromEvent(event)).toBeNull();
  });

  it("assistant 以外のイベントは null を返す", () => {
    expect(extractTextFromEvent({ type: "system" })).toBeNull();
    expect(extractTextFromEvent({ type: "result", result: "done" })).toBeNull();
  });

  it("message.content が配列でない場合は null を返す", () => {
    const event: StreamJsonEvent = {
      type: "assistant",
      message: { content: "not an array" },
    };
    expect(extractTextFromEvent(event)).toBeNull();
  });

  it("message がない assistant イベントは null を返す", () => {
    const event: StreamJsonEvent = { type: "assistant" };
    expect(extractTextFromEvent(event)).toBeNull();
  });
});

describe("extractFromStreamEvents", () => {
  it("result イベントから response と sessionId を抽出する", () => {
    const events: StreamJsonEvent[] = [
      { type: "system", session_id: "sess-123" },
      {
        type: "assistant",
        message: { content: [{ type: "text", text: "partial" }] },
      },
      { type: "result", result: "final answer", session_id: "sess-123" },
    ];
    const result = extractFromStreamEvents(events);
    expect(result.response).toBe("final answer");
    expect(result.sessionId).toBe("sess-123");
  });

  it("result イベントがない場合、最後の assistant イベントのテキストを使う", () => {
    const events: StreamJsonEvent[] = [
      { type: "system", session_id: "sess-456" },
      {
        type: "assistant",
        message: { content: [{ type: "text", text: "partial 1" }] },
      },
      {
        type: "assistant",
        message: { content: [{ type: "text", text: "partial 1 complete" }] },
      },
    ];
    const result = extractFromStreamEvents(events);
    expect(result.response).toBe("partial 1 complete");
    expect(result.sessionId).toBe("sess-456");
  });

  it("result イベントの session_id が system イベントの session_id を上書きする", () => {
    const events: StreamJsonEvent[] = [
      { type: "system", session_id: "old" },
      { type: "result", result: "done", session_id: "new" },
    ];
    const result = extractFromStreamEvents(events);
    expect(result.sessionId).toBe("new");
  });

  it("空イベント列では空の response と null sessionId を返す", () => {
    const result = extractFromStreamEvents([]);
    expect(result.response).toBe("");
    expect(result.sessionId).toBeNull();
  });

  it("session_id が system イベントのみにある場合はそちらを使う", () => {
    const events: StreamJsonEvent[] = [
      { type: "system", session_id: "sys-id" },
      { type: "result", result: "ok" },
    ];
    const result = extractFromStreamEvents(events);
    expect(result.sessionId).toBe("sys-id");
  });

  it("assistant イベントのみ（result なし、system なし）", () => {
    const events: StreamJsonEvent[] = [
      {
        type: "assistant",
        message: { content: [{ type: "text", text: "only text" }] },
      },
    ];
    const result = extractFromStreamEvents(events);
    expect(result.response).toBe("only text");
    expect(result.sessionId).toBeNull();
  });
});
