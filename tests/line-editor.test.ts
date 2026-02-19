import { describe, it, expect, vi, beforeEach } from "vitest";
import { PassThrough } from "node:stream";
import { readLine, getDisplayWidth } from "../src/line-editor.js";
import type { LineEditorOptions, LineEditorResult } from "../src/line-editor.js";

function createMockInput(): PassThrough & { setRawMode: ReturnType<typeof vi.fn> } {
  const stream = new PassThrough() as PassThrough & { setRawMode: ReturnType<typeof vi.fn> };
  stream.setRawMode = vi.fn();
  return stream;
}

function createMockOutput(): PassThrough & { columns?: number } {
  const stream = new PassThrough();
  return stream as PassThrough & { columns?: number };
}

function captureWrites(output: PassThrough & { columns?: number }): { getOutput: () => string } {
  const parts: string[] = [];
  const origWrite = output.write.bind(output);
  output.write = ((chunk: any, ...args: any[]) => {
    if (typeof chunk === "string") parts.push(chunk);
    else if (Buffer.isBuffer(chunk)) parts.push(chunk.toString());
    return origWrite(chunk, ...args);
  }) as any;
  return { getOutput: () => parts.join("") };
}

function makeOptions(
  input: ReturnType<typeof createMockInput>,
  output: ReturnType<typeof createMockOutput>,
  history: string[] = [],
): LineEditorOptions {
  return {
    prompt: "ai> ",
    continuationPrompt: "... ",
    history,
    output,
    input,
  };
}

async function sendAndAwait(
  input: ReturnType<typeof createMockInput>,
  data: string | Buffer,
  promise: Promise<LineEditorResult>,
): Promise<LineEditorResult> {
  input.write(data);
  // Give time for processing
  await new Promise((resolve) => setTimeout(resolve, 10));
  return promise;
}

describe("getDisplayWidth", () => {
  it("ASCII characters have width 1", () => {
    expect(getDisplayWidth("hello")).toBe(5);
  });

  it("CJK characters have width 2", () => {
    expect(getDisplayWidth("日本語")).toBe(6);
  });

  it("mixed ASCII and CJK", () => {
    expect(getDisplayWidth("hello日本")).toBe(9);
  });

  it("empty string has width 0", () => {
    expect(getDisplayWidth("")).toBe(0);
  });

  it("fullwidth forms have width 2", () => {
    // Ａ is U+FF21 (fullwidth A)
    expect(getDisplayWidth("\uff21")).toBe(2);
  });

  it("hiragana has width 2", () => {
    expect(getDisplayWidth("あいう")).toBe(6);
  });

  it("katakana has width 2", () => {
    expect(getDisplayWidth("アイウ")).toBe(6);
  });
});

describe("readLine", () => {
  let input: ReturnType<typeof createMockInput>;
  let output: ReturnType<typeof createMockOutput>;

  beforeEach(() => {
    input = createMockInput();
    output = createMockOutput();
  });

  it("basic input and Enter submits", async () => {
    const promise = readLine(makeOptions(input, output));
    input.write("hello\r");
    const result = await promise;
    expect(result).toEqual({ type: "input", value: "hello" });
  });

  it("Ctrl+C returns cancel", async () => {
    const promise = readLine(makeOptions(input, output));
    input.write("\x03");
    const result = await promise;
    expect(result).toEqual({ type: "cancel" });
  });

  it("Ctrl+D on empty buffer returns eof", async () => {
    const promise = readLine(makeOptions(input, output));
    input.write("\x04");
    const result = await promise;
    expect(result).toEqual({ type: "eof" });
  });

  it("Ctrl+D on non-empty buffer submits input", async () => {
    const promise = readLine(makeOptions(input, output));
    input.write("some text\x04");
    const result = await promise;
    expect(result).toEqual({ type: "input", value: "some text" });
  });

  it("Backspace deletes character", async () => {
    const promise = readLine(makeOptions(input, output));
    input.write("ab\x7fc\r");
    const result = await promise;
    expect(result).toEqual({ type: "input", value: "ac" });
  });

  it("Backspace at beginning of line merges with previous line", async () => {
    const promise = readLine(makeOptions(input, output));
    // Type "ab", Ctrl+J (newline), "cd", then 3x Backspace (removes 'd', 'c', merges lines), Enter
    input.write("ab\x0acd\x7f\x7f\x7f\r");
    const result = await promise;
    // After "ab\ncd", backspace 3 times: removes 'd', 'c', merges lines → "ab"
    expect(result).toEqual({ type: "input", value: "ab" });
  });

  it("Ctrl+J inserts newline", async () => {
    const promise = readLine(makeOptions(input, output));
    input.write("line1\x0aline2\r");
    const result = await promise;
    expect(result).toEqual({ type: "input", value: "line1\nline2" });
  });

  it("multiple Ctrl+J for multiline", async () => {
    const promise = readLine(makeOptions(input, output));
    input.write("a\x0ab\x0ac\r");
    const result = await promise;
    expect(result).toEqual({ type: "input", value: "a\nb\nc" });
  });

  it("bracket paste mode inserts multiline text", async () => {
    const promise = readLine(makeOptions(input, output));
    // Bracket paste start + content + bracket paste end + Enter
    input.write("\x1b[200~line1\nline2\nline3\x1b[201~\r");
    const result = await promise;
    expect(result).toEqual({ type: "input", value: "line1\nline2\nline3" });
  });

  it("bracket paste with CRLF", async () => {
    const promise = readLine(makeOptions(input, output));
    input.write("\x1b[200~first\r\nsecond\x1b[201~\r");
    const result = await promise;
    expect(result).toEqual({ type: "input", value: "first\nsecond" });
  });

  it("Up arrow navigates history", async () => {
    const promise = readLine(makeOptions(input, output, ["prev1", "prev2"]));
    // Up arrow (ESC [ A) → gets "prev1", then Enter
    input.write("\x1b[A\r");
    const result = await promise;
    expect(result).toEqual({ type: "input", value: "prev1" });
  });

  it("Up/Down arrow navigates history and returns to current input", async () => {
    const promise = readLine(makeOptions(input, output, ["prev1", "prev2"]));
    // Type "current", Up (gets prev1), Down (back to current), Enter
    input.write("current\x1b[A\x1b[B\r");
    const result = await promise;
    expect(result).toEqual({ type: "input", value: "current" });
  });

  it("Ctrl+A moves cursor to beginning of line", async () => {
    const promise = readLine(makeOptions(input, output));
    // Type "hello", Ctrl+A, type "X", Enter
    input.write("hello\x01X\r");
    const result = await promise;
    expect(result).toEqual({ type: "input", value: "Xhello" });
  });

  it("Ctrl+E moves cursor to end of line", async () => {
    const promise = readLine(makeOptions(input, output));
    // Type "hello", Ctrl+A, Ctrl+E, type "X", Enter
    input.write("hello\x01\x05X\r");
    const result = await promise;
    expect(result).toEqual({ type: "input", value: "helloX" });
  });

  it("Ctrl+U clears from cursor to beginning", async () => {
    const promise = readLine(makeOptions(input, output));
    // Type "hello", left 2, Ctrl+U, Enter
    input.write("hello\x1b[D\x1b[D\x15\r");
    const result = await promise;
    expect(result).toEqual({ type: "input", value: "lo" });
  });

  it("Ctrl+K clears from cursor to end", async () => {
    const promise = readLine(makeOptions(input, output));
    // Type "hello", left 2, Ctrl+K, Enter
    input.write("hello\x1b[D\x1b[D\x0b\r");
    const result = await promise;
    expect(result).toEqual({ type: "input", value: "hel" });
  });

  it("Delete key removes character at cursor", async () => {
    const promise = readLine(makeOptions(input, output));
    // Type "hello", Home, Delete, Enter
    input.write("hello\x1b[H\x1b[3~\r");
    const result = await promise;
    expect(result).toEqual({ type: "input", value: "ello" });
  });

  it("Japanese input is handled correctly", async () => {
    const promise = readLine(makeOptions(input, output));
    input.write("日本語\r");
    const result = await promise;
    expect(result).toEqual({ type: "input", value: "日本語" });
  });

  it("Japanese backspace removes one character", async () => {
    const promise = readLine(makeOptions(input, output));
    input.write("日本語\x7f\r");
    const result = await promise;
    expect(result).toEqual({ type: "input", value: "日本" });
  });

  it("Alt+Enter inserts newline (ESC + CR)", async () => {
    const promise = readLine(makeOptions(input, output));
    input.write("line1\x1b\rline2\r");
    const result = await promise;
    expect(result).toEqual({ type: "input", value: "line1\nline2" });
  });

  // Cleanup verification tests
  it("cleanup: setRawMode(false) called after input", async () => {
    const promise = readLine(makeOptions(input, output));
    input.write("test\r");
    await promise;
    expect(input.setRawMode).toHaveBeenLastCalledWith(false);
  });

  it("cleanup: setRawMode(false) called after cancel", async () => {
    const promise = readLine(makeOptions(input, output));
    input.write("\x03");
    await promise;
    expect(input.setRawMode).toHaveBeenLastCalledWith(false);
  });

  it("cleanup: setRawMode(false) called after eof", async () => {
    const promise = readLine(makeOptions(input, output));
    input.write("\x04");
    await promise;
    expect(input.setRawMode).toHaveBeenLastCalledWith(false);
  });

  it("cleanup: bracket paste disabled and data listener removed after completion", async () => {
    const promise = readLine(makeOptions(input, output));
    const listenersBefore = input.listenerCount("data");
    input.write("test\r");
    await promise;

    // Check bracket paste disable was written
    const outputData = output.read()?.toString() ?? "";
    expect(outputData).toContain("\x1b[?2004l");

    // Data listener should be removed
    expect(input.listenerCount("data")).toBeLessThan(listenersBefore);
  });

  it("cleanup: works even if output.write throws", async () => {
    const brokenOutput = createMockOutput();
    let writeCount = 0;
    const origWrite = brokenOutput.write.bind(brokenOutput);
    brokenOutput.write = ((...args: unknown[]) => {
      writeCount++;
      // Let initial writes through (setup + initial render), then throw
      if (writeCount > 10) {
        throw new Error("write error");
      }
      return origWrite(...(args as [unknown]));
    }) as typeof brokenOutput.write;

    const promise = readLine(makeOptions(input, brokenOutput));
    // Type enough to trigger the error in render, which should result in cancel
    input.write("a".repeat(20));
    await new Promise((r) => setTimeout(r, 20));
    // If not resolved yet, send Ctrl+C to force resolve
    input.write("\x03");
    const result = await promise;

    // Should have cleaned up despite error
    expect(input.setRawMode).toHaveBeenLastCalledWith(false);
    expect(result.type === "cancel" || result.type === "input").toBe(true);
  });

  // Chunk splitting resilience tests
  it("chunk split: multibyte character split across chunks", async () => {
    const promise = readLine(makeOptions(input, output));
    // "日" = U+65E5 = UTF-8: E6 97 A5
    // Split the byte sequence across two chunks
    input.write(Buffer.from([0xe6, 0x97]));
    await new Promise((r) => setTimeout(r, 5));
    input.write(Buffer.from([0xa5]));
    await new Promise((r) => setTimeout(r, 5));
    input.write("\r");
    const result = await promise;
    expect(result).toEqual({ type: "input", value: "日" });
  });

  it("chunk split: escape sequence split across chunks", async () => {
    const promise = readLine(makeOptions(input, output));
    // Type "hello", then send arrow left as split chunks
    input.write("hello");
    await new Promise((r) => setTimeout(r, 5));
    input.write("\x1b");
    await new Promise((r) => setTimeout(r, 5));
    input.write("[D");
    await new Promise((r) => setTimeout(r, 5));
    // Type X at cursor position (before 'o'), Enter
    input.write("X\r");
    const result = await promise;
    expect(result).toEqual({ type: "input", value: "hellXo" });
  });

  it("chunk split: bracket paste marker split across chunks", async () => {
    const promise = readLine(makeOptions(input, output));
    // Split bracket paste start marker
    input.write("\x1b[20");
    await new Promise((r) => setTimeout(r, 5));
    input.write("0~pasted text\x1b[201~\r");
    const result = await promise;
    expect(result).toEqual({ type: "input", value: "pasted text" });
  });

  it("history with multiline entries", async () => {
    const promise = readLine(makeOptions(input, output, ["line1\nline2", "single"]));
    // Up to get first history entry (multiline)
    input.write("\x1b[A\r");
    const result = await promise;
    expect(result).toEqual({ type: "input", value: "line1\nline2" });
  });

  it("empty Enter submits empty string", async () => {
    const promise = readLine(makeOptions(input, output));
    input.write("\r");
    const result = await promise;
    expect(result).toEqual({ type: "input", value: "" });
  });

  it("accepts input even when stream was explicitly paused (simulates readline.close())", async () => {
    // readline.createInterface().close() が内部で input.pause() を呼ぶ状況を再現
    input.pause();
    const promise = readLine(makeOptions(input, output));
    input.write("after-pause\r");
    const result = await promise;
    expect(result).toEqual({ type: "input", value: "after-pause" });
  });

  it("arrow left and right navigation", async () => {
    const promise = readLine(makeOptions(input, output));
    // Type "ab", left, left, type "X", right, type "Y", Enter
    input.write("ab\x1b[D\x1b[DX\x1b[CY\r");
    const result = await promise;
    expect(result).toEqual({ type: "input", value: "XaYb" });
  });
});

describe("wrapping: column boundary", () => {
  let input: ReturnType<typeof createMockInput>;
  let output: ReturnType<typeof createMockOutput>;

  beforeEach(() => {
    input = createMockInput();
    output = createMockOutput();
  });

  it("cols-1: cursor at one char before boundary", async () => {
    output.columns = 10;
    const capture = captureWrites(output);
    const promise = readLine(makeOptions(input, output));
    // "ai> " (4) + "abcde" (5) = 9 < 10 → 1 visual row, cursor at col 9
    input.write("abcde\r");
    const result = await promise;
    expect(result).toEqual({ type: "input", value: "abcde" });
    const allOutput = capture.getOutput();
    const beforeEnter = allOutput.slice(0, allOutput.lastIndexOf("\n"));
    expect(beforeEnter).toMatch(/\r\x1b\[9C$/);
  });

  it("cols: cursor at exact boundary (deferred wrap)", async () => {
    output.columns = 10;
    const capture = captureWrites(output);
    const promise = readLine(makeOptions(input, output));
    // "ai> " (4) + "abcdef" (6) = 10 = cols → deferred wrap
    input.write("abcdef\r");
    const result = await promise;
    expect(result).toEqual({ type: "input", value: "abcdef" });
    const allOutput = capture.getOutput();
    const beforeEnter = allOutput.slice(0, allOutput.lastIndexOf("\n"));
    // Cursor at col 10 (deferred wrap, clamped to right edge)
    expect(beforeEnter).toMatch(/\r\x1b\[10C$/);
    // No unnecessary vertical movement in the last render
    const lastContentIdx = allOutput.lastIndexOf("ai> abcdef");
    const afterContent = allOutput.slice(
      lastContentIdx + "ai> abcdef".length,
      allOutput.lastIndexOf("\n"),
    );
    expect(afterContent).not.toMatch(/\x1b\[\d+A/);
    expect(afterContent).not.toMatch(/\x1b\[\d+B/);
  });

  it("cols+1: cursor one char past boundary", async () => {
    output.columns = 10;
    const capture = captureWrites(output);
    const promise = readLine(makeOptions(input, output));
    // "ai> " (4) + "abcdefg" (7) = 11 > 10 → 2 visual rows, cursor at col 1 of row 1
    input.write("abcdefg\r");
    const result = await promise;
    expect(result).toEqual({ type: "input", value: "abcdefg" });
    const allOutput = capture.getOutput();
    const beforeEnter = allOutput.slice(0, allOutput.lastIndexOf("\n"));
    expect(beforeEnter).toMatch(/\r\x1b\[1C$/);
  });
});

describe("readLine cleanup: resize listener", () => {
  it("resize listener removed after completion", async () => {
    const input = createMockInput();
    const output = createMockOutput();
    const promise = readLine(makeOptions(input, output));
    expect(output.listenerCount("resize")).toBe(1);
    input.write("test\r");
    await promise;
    expect(output.listenerCount("resize")).toBe(0);
  });
});

describe("wrapping: continuation prompt", () => {
  it("wrapping on continuation line with different prompt width", async () => {
    const input = createMockInput();
    const output = createMockOutput();
    output.columns = 15;
    const capture = captureWrites(output);
    const promise = readLine(makeOptions(input, output));
    // Line 1: "ai> short" = 9 chars (no wrap)
    // Ctrl+J for new line
    // Line 2: "... " (4) + "abcdefghijk" (11) = 15 → exact boundary
    input.write("short\x0aabcdefghijk\r");
    const result = await promise;
    expect(result).toEqual({ type: "input", value: "short\nabcdefghijk" });
    const allOutput = capture.getOutput();
    const beforeEnter = allOutput.slice(0, allOutput.lastIndexOf("\n"));
    // Cursor at col 15 (deferred wrap on continuation line)
    expect(beforeEnter).toMatch(/\r\x1b\[15C$/);
  });
});

describe("getTerminalColumns fallback", () => {
  let input: ReturnType<typeof createMockInput>;
  let output: ReturnType<typeof createMockOutput>;

  beforeEach(() => {
    input = createMockInput();
    output = createMockOutput();
  });

  it("undefined columns falls back to 80", async () => {
    // output.columns is undefined by default
    const capture = captureWrites(output);
    const promise = readLine(makeOptions(input, output));
    // prompt(4) + 76 chars = 80 → exact boundary at 80 cols
    input.write("a".repeat(76) + "\r");
    const result = await promise;
    expect(result).toEqual({ type: "input", value: "a".repeat(76) });
    const allOutput = capture.getOutput();
    const beforeEnter = allOutput.slice(0, allOutput.lastIndexOf("\n"));
    expect(beforeEnter).toMatch(/\r\x1b\[80C$/);
  });

  it("columns = 0 falls back to 80", async () => {
    output.columns = 0;
    const capture = captureWrites(output);
    const promise = readLine(makeOptions(input, output));
    input.write("a".repeat(76) + "\r");
    const result = await promise;
    expect(result).toEqual({ type: "input", value: "a".repeat(76) });
    const allOutput = capture.getOutput();
    const beforeEnter = allOutput.slice(0, allOutput.lastIndexOf("\n"));
    expect(beforeEnter).toMatch(/\r\x1b\[80C$/);
  });

  it("columns = -1 falls back to 80", async () => {
    output.columns = -1;
    const capture = captureWrites(output);
    const promise = readLine(makeOptions(input, output));
    input.write("a".repeat(76) + "\r");
    const result = await promise;
    expect(result).toEqual({ type: "input", value: "a".repeat(76) });
    const allOutput = capture.getOutput();
    const beforeEnter = allOutput.slice(0, allOutput.lastIndexOf("\n"));
    expect(beforeEnter).toMatch(/\r\x1b\[80C$/);
  });
});

describe("wrapping: CJK characters", () => {
  let input: ReturnType<typeof createMockInput>;
  let output: ReturnType<typeof createMockOutput>;

  beforeEach(() => {
    input = createMockInput();
    output = createMockOutput();
  });

  it("CJK at exact terminal width boundary", async () => {
    output.columns = 10;
    const capture = captureWrites(output);
    const promise = readLine(makeOptions(input, output));
    // "ai> " (4) + "日本語" (6, each width 2) = 10 → exact boundary
    input.write("日本語\r");
    const result = await promise;
    expect(result).toEqual({ type: "input", value: "日本語" });
    const allOutput = capture.getOutput();
    const beforeEnter = allOutput.slice(0, allOutput.lastIndexOf("\n"));
    expect(beforeEnter).toMatch(/\r\x1b\[10C$/);
  });

  it("CJK wrapping past terminal width", async () => {
    output.columns = 10;
    const capture = captureWrites(output);
    const promise = readLine(makeOptions(input, output));
    // "ai> " (4) + "日本語テ" (8) = 12 → wraps to 2 visual rows
    input.write("日本語テ\r");
    const result = await promise;
    expect(result).toEqual({ type: "input", value: "日本語テ" });
    const allOutput = capture.getOutput();
    const beforeEnter = allOutput.slice(0, allOutput.lastIndexOf("\n"));
    // Cursor at col 2 of visual row 1 (12 % 10 = 2)
    expect(beforeEnter).toMatch(/\r\x1b\[2C$/);
  });
});

describe("resize handling", () => {
  it("resize event triggers re-render", async () => {
    const input = createMockInput();
    const output = createMockOutput();
    output.columns = 40;
    const promise = readLine(makeOptions(input, output));
    input.write("a".repeat(30));
    await new Promise((r) => setTimeout(r, 10));
    // Resize to smaller terminal
    output.columns = 20;
    output.emit("resize");
    await new Promise((r) => setTimeout(r, 10));
    input.write("\r");
    const result = await promise;
    expect(result).toEqual({ type: "input", value: "a".repeat(30) });
  });
});
