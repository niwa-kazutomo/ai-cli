/**
 * Claude CLI の stream-json (JSONL) 出力をリアルタイムにパースするモジュール。
 */

/** stream-json の各イベント型（Codex は type なしの行も出力しうる） */
export interface StreamJsonEvent {
  type?: string;
  /* eslint-disable @typescript-eslint/no-explicit-any */
  [key: string]: any;
}

/** extractFromStreamEvents の戻り値 */
export interface StreamJsonResult {
  response: string;
  sessionId: string | null;
}

/**
 * JSONL ストリームのラインバッファ。
 * チャンクを受け取り、改行で分割して完全な行ごとに JSON パースする。
 * 不完全な行はバッファに保持する。
 */
export class StreamJsonLineBuffer {
  private buffer = "";

  /** チャンクを投入し、完全な行をパースして返す */
  feed(chunk: string): StreamJsonEvent[] {
    this.buffer += chunk;
    const lines = this.buffer.split("\n");
    // 最後の要素は不完全な行（または空文字）なのでバッファに保持
    this.buffer = lines.pop()!;

    const events: StreamJsonEvent[] = [];
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed === "") continue;
      try {
        const parsed = JSON.parse(trimmed);
        if (typeof parsed === "object" && parsed !== null) {
          events.push(parsed as StreamJsonEvent);
        }
      } catch {
        // 不正な JSON 行はスキップ
      }
    }
    return events;
  }

  /** 残バッファを処理する（プロセス終了時に呼ぶ） */
  flush(): StreamJsonEvent[] {
    const remaining = this.buffer.trim();
    this.buffer = "";
    if (remaining === "") return [];
    try {
      const parsed = JSON.parse(remaining);
      if (typeof parsed === "object" && parsed !== null) {
        return [parsed as StreamJsonEvent];
      }
    } catch {
      // 不正な JSON はスキップ
    }
    return [];
  }
}

/**
 * 単一イベントからテキストを抽出する。
 * type: "assistant" のとき message.content[] を走査し、
 * type: "text" ブロックの .text を結合して返す。
 * それ以外のイベントは null を返す。
 */
export function extractTextFromEvent(event: StreamJsonEvent): string | null {
  if (event.type !== "assistant") return null;

  const content = event.message?.content;
  if (!Array.isArray(content)) return null;

  const texts: string[] = [];
  for (const block of content) {
    if (block.type === "text" && typeof block.text === "string") {
      texts.push(block.text);
    }
  }

  // eslint-disable-next-line prefer-template
  return texts.length > 0 ? texts.join("\n") : null;
}

/**
 * Codex の単一イベントからテキストを抽出する。
 * item.started / item.updated / item.completed で item.type === "agent_message" のとき
 * item.text を返す。テキストなし → null
 */
export function extractTextFromCodexEvent(event: StreamJsonEvent): string | null {
  if (
    (event.type === "item.completed" ||
     event.type === "item.updated" ||
     event.type === "item.started") &&
    event.item?.type === "agent_message" &&
    typeof event.item.text === "string"
  ) {
    return event.item.text || null;
  }
  return null;
}

/**
 * Codex イベント列から response と sessionId を抽出する。
 * - sessionId は thread.started の thread_id から取得
 * - テキストは item.completed の agent_message を優先。
 *   item.completed がない場合は item.updated/item.started の最新値をフォールバック
 */
export function extractFromCodexStreamEvents(events: StreamJsonEvent[]): StreamJsonResult {
  let sessionId: string | null = null;

  for (const event of events) {
    if (event.type === "thread.started" && typeof event.thread_id === "string") {
      sessionId = event.thread_id;
    }
  }

  // item.completed の agent_message を優先抽出
  const completedTexts: string[] = [];
  const latestUpdated = new Map<string, string>(); // フォールバック用

  for (const event of events) {
    const itemId = event.item?.id;
    const itemType = event.item?.type;
    const text = event.item?.text;
    if (itemType !== "agent_message" || typeof text !== "string" || !text) continue;

    if (event.type === "item.completed") {
      completedTexts.push(text);
    } else if (
      (event.type === "item.updated" || event.type === "item.started") &&
      typeof itemId === "string"
    ) {
      latestUpdated.set(itemId, text);
    }
  }

  // completed があればそれを、なければ updated/started の最新値をフォールバック
  const texts = completedTexts.length > 0
    ? completedTexts
    : [...latestUpdated.values()];

  return { response: texts.join("\n"), sessionId };
}

/**
 * イベント列から response と sessionId を抽出する。
 * - result イベントの result フィールドを優先
 * - result イベントがない場合: 最後の assistant イベントからテキストを取得
 * - session_id は system イベントまたは result イベントから取得
 */
export function extractFromStreamEvents(events: StreamJsonEvent[]): StreamJsonResult {
  let response = "";
  let sessionId: string | null = null;

  // session_id を system または result イベントから探す
  for (const event of events) {
    if (event.type === "system" && typeof event.session_id === "string") {
      sessionId = event.session_id;
    }
  }

  // result イベントを探す
  const resultEvent = events.find((e) => e.type === "result");
  if (resultEvent) {
    if (typeof resultEvent.result === "string") {
      response = resultEvent.result;
    }
    if (typeof resultEvent.session_id === "string") {
      sessionId = resultEvent.session_id;
    }
    return { response, sessionId };
  }

  // result イベントがない場合: 最後の assistant イベントからテキストを取得
  for (let i = events.length - 1; i >= 0; i--) {
    const text = extractTextFromEvent(events[i]);
    if (text !== null) {
      response = text;
      break;
    }
  }

  return { response, sessionId };
}
