import { describe, it, expect } from "vitest";
import {
  StreamJsonLineBuffer,
  extractTextFromEvent,
  extractTextFromCodexEvent,
  extractFromStreamEvents,
  extractFromCodexStreamEvents,
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

  it("type フィールドがないオブジェクトも受け入れる", () => {
    const buf = new StreamJsonLineBuffer();
    const events = buf.feed('{"data":"no type"}\n{"type":"system"}\n');
    expect(events).toHaveLength(2);
    expect(events[0].data).toBe("no type");
    expect(events[1].type).toBe("system");
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
    expect(extractTextFromEvent(event)).toBe("Hello \nWorld");
  });

  it("tool_use を挟む複数 text ブロックを改行で結合する", () => {
    const event: StreamJsonEvent = {
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "Before tool" },
          { type: "tool_use", id: "t1", name: "read_file", input: {} },
          { type: "tool_result", tool_use_id: "t1", content: "file data" },
          { type: "text", text: "After tool" },
        ],
      },
    };
    expect(extractTextFromEvent(event)).toBe("Before tool\nAfter tool");
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

describe("extractTextFromCodexEvent", () => {
  it("item.completed の agent_message からテキストを抽出する", () => {
    const event: StreamJsonEvent = {
      type: "item.completed",
      item: { id: "item_1", type: "agent_message", text: "Hello from Codex" },
    };
    expect(extractTextFromCodexEvent(event)).toBe("Hello from Codex");
  });

  it("item.updated の agent_message からテキストを抽出する", () => {
    const event: StreamJsonEvent = {
      type: "item.updated",
      item: { id: "item_1", type: "agent_message", text: "Partial text" },
    };
    expect(extractTextFromCodexEvent(event)).toBe("Partial text");
  });

  it("item.started の agent_message からテキストを抽出する（空でなければ）", () => {
    const event: StreamJsonEvent = {
      type: "item.started",
      item: { id: "item_1", type: "agent_message", text: "Initial" },
    };
    expect(extractTextFromCodexEvent(event)).toBe("Initial");
  });

  it("item.started で空テキストは null を返す", () => {
    const event: StreamJsonEvent = {
      type: "item.started",
      item: { id: "item_1", type: "agent_message", text: "" },
    };
    expect(extractTextFromCodexEvent(event)).toBeNull();
  });

  it("agent_message 以外の item type は null を返す", () => {
    const event: StreamJsonEvent = {
      type: "item.completed",
      item: { id: "item_1", type: "tool_call", text: "ignored" },
    };
    expect(extractTextFromCodexEvent(event)).toBeNull();
  });

  it("テキストフィールドがないイベントは null を返す", () => {
    const event: StreamJsonEvent = { type: "turn.started" };
    expect(extractTextFromCodexEvent(event)).toBeNull();
  });

  it("thread.started イベントは null を返す", () => {
    const event: StreamJsonEvent = { type: "thread.started", thread_id: "tid-123" };
    expect(extractTextFromCodexEvent(event)).toBeNull();
  });

  it("turn.completed イベントは null を返す", () => {
    const event: StreamJsonEvent = {
      type: "turn.completed",
      usage: { input_tokens: 100, output_tokens: 50 },
    };
    expect(extractTextFromCodexEvent(event)).toBeNull();
  });
});

describe("extractFromCodexStreamEvents", () => {
  it("item.completed の agent_message からテキストを抽出する", () => {
    const events: StreamJsonEvent[] = [
      { type: "thread.started", thread_id: "tid-1" },
      { type: "item.started", item: { id: "item_1", type: "agent_message", text: "" } },
      { type: "item.updated", item: { id: "item_1", type: "agent_message", text: "Hello" } },
      { type: "item.completed", item: { id: "item_1", type: "agent_message", text: "Hello World" } },
    ];
    const result = extractFromCodexStreamEvents(events);
    expect(result.response).toBe("Hello World");
  });

  it("複数の item.completed を改行で join する", () => {
    const events: StreamJsonEvent[] = [
      { type: "item.completed", item: { id: "item_1", type: "agent_message", text: "Line 1" } },
      { type: "item.completed", item: { id: "item_2", type: "agent_message", text: "Line 2" } },
    ];
    const result = extractFromCodexStreamEvents(events);
    expect(result.response).toBe("Line 1\nLine 2");
  });

  it("thread.started の thread_id を sessionId として抽出する", () => {
    const events: StreamJsonEvent[] = [
      { type: "thread.started", thread_id: "sess-123" },
      { type: "item.completed", item: { id: "item_1", type: "agent_message", text: "Hello" } },
    ];
    const result = extractFromCodexStreamEvents(events);
    expect(result.sessionId).toBe("sess-123");
  });

  it("thread_id がない場合は sessionId が null", () => {
    const events: StreamJsonEvent[] = [
      { type: "item.completed", item: { id: "item_1", type: "agent_message", text: "Hello" } },
    ];
    const result = extractFromCodexStreamEvents(events);
    expect(result.sessionId).toBeNull();
  });

  it("thread.started のみ（agent_message なし）でセッション ID だけ取れる", () => {
    const events: StreamJsonEvent[] = [
      { type: "thread.started", thread_id: "only-session" },
      { type: "turn.started" },
      { type: "turn.completed", usage: { input_tokens: 100 } },
    ];
    const result = extractFromCodexStreamEvents(events);
    expect(result.sessionId).toBe("only-session");
    expect(result.response).toBe("");
  });

  it("テキストのないイベントはスキップされる", () => {
    const events: StreamJsonEvent[] = [
      { type: "turn.started" },
      { type: "item.completed", item: { id: "item_1", type: "agent_message", text: "Only text" } },
      { type: "turn.completed", usage: {} },
    ];
    const result = extractFromCodexStreamEvents(events);
    expect(result.response).toBe("Only text");
  });

  it("空イベント列では空 response と null sessionId", () => {
    const result = extractFromCodexStreamEvents([]);
    expect(result.response).toBe("");
    expect(result.sessionId).toBeNull();
  });

  it("item.completed がなく item.updated のみの場合にフォールバック抽出される", () => {
    const events: StreamJsonEvent[] = [
      { type: "item.started", item: { id: "item_1", type: "agent_message", text: "" } },
      { type: "item.updated", item: { id: "item_1", type: "agent_message", text: "Partial" } },
      { type: "item.updated", item: { id: "item_1", type: "agent_message", text: "Partial result" } },
    ];
    const result = extractFromCodexStreamEvents(events);
    expect(result.response).toBe("Partial result");
  });

  it("同一 item の started→updated→completed ライフサイクルで重複なし", () => {
    const events: StreamJsonEvent[] = [
      { type: "item.started", item: { id: "item_1", type: "agent_message", text: "" } },
      { type: "item.updated", item: { id: "item_1", type: "agent_message", text: "A" } },
      { type: "item.updated", item: { id: "item_1", type: "agent_message", text: "AB" } },
      { type: "item.completed", item: { id: "item_1", type: "agent_message", text: "AB" } },
    ];
    const result = extractFromCodexStreamEvents(events);
    // completed が1件なので1つのテキストのみ
    expect(result.response).toBe("AB");
  });

  it("error / turn.failed イベント混在時にテキスト抽出が壊れない", () => {
    const events: StreamJsonEvent[] = [
      { type: "thread.started", thread_id: "tid-err" },
      { type: "item.completed", item: { id: "item_1", type: "agent_message", text: "Before error" } },
      { type: "turn.failed", error: "something went wrong" },
    ];
    const result = extractFromCodexStreamEvents(events);
    expect(result.response).toBe("Before error");
    expect(result.sessionId).toBe("tid-err");
  });
});
