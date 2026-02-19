import { StringDecoder } from "node:string_decoder";

export interface LineEditorOptions {
  prompt: string;
  continuationPrompt: string;
  history: string[];
  output: NodeJS.WritableStream;
  input: NodeJS.ReadableStream & { setRawMode?: (mode: boolean) => void };
}

export type LineEditorResult =
  | { type: "input"; value: string }
  | { type: "cancel" }
  | { type: "eof" };

interface EditorState {
  lines: string[];
  cursorRow: number;
  cursorCol: number;
  historyIndex: number;
  savedInput: string[];
}

const enum ParseState {
  NORMAL,
  ESC_SEEN,
  CSI_PARSING,
  PASTE,
}

/**
 * Calculate the display width of a string, accounting for CJK full-width characters.
 */
export function getDisplayWidth(str: string): number {
  let width = 0;
  for (const ch of str) {
    width += getCharWidth(ch);
  }
  return width;
}

function getCharWidth(ch: string): number {
  const code = ch.codePointAt(0)!;
  if (isFullWidth(code)) return 2;
  return 1;
}

function isFullWidth(code: number): boolean {
  return (
    // CJK Unified Ideographs
    (code >= 0x4e00 && code <= 0x9fff) ||
    // CJK Unified Ideographs Extension A
    (code >= 0x3400 && code <= 0x4dbf) ||
    // CJK Unified Ideographs Extension B+
    (code >= 0x20000 && code <= 0x2ffff) ||
    // Hiragana
    (code >= 0x3040 && code <= 0x309f) ||
    // Katakana
    (code >= 0x30a0 && code <= 0x30ff) ||
    // CJK Symbols and Punctuation, Ideographic Space
    (code >= 0x3000 && code <= 0x303f) ||
    // Fullwidth Forms
    (code >= 0xff01 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    // CJK Compatibility Ideographs
    (code >= 0xf900 && code <= 0xfaff) ||
    // Hangul Syllables
    (code >= 0xac00 && code <= 0xd7af) ||
    // Hangul Jamo
    (code >= 0x1100 && code <= 0x115f)
  );
}

export function readLine(options: LineEditorOptions): Promise<LineEditorResult> {
  const { prompt, continuationPrompt, history, output, input } = options;

  return new Promise((resolve) => {
    const state: EditorState = {
      lines: [""],
      cursorRow: 0,
      cursorCol: 0,
      historyIndex: -1,
      savedInput: [""],
    };

    let parseState = ParseState.NORMAL;
    let csiBuffer = "";
    let pasteBuffer = "";
    const decoder = new StringDecoder("utf8");
    let resolved = false;

    function onResize(): void {
      if (!resolved) {
        try { render(); } catch { /* ignore */ }
      }
    }

    function cleanup(): void {
      input.removeListener("data", onData);
      if (typeof (output as any).removeListener === "function") {
        (output as any).removeListener("resize", onResize);
      }
      try {
        input.setRawMode?.(false);
      } catch {
        // ignore
      }
      try {
        output.write("\x1b[?2004l");
      } catch {
        // ignore
      }
    }

    function finish(result: LineEditorResult): void {
      if (resolved) return;
      resolved = true;
      cleanup();
      resolve(result);
    }

    function getPromptForRow(row: number): string {
      return row === 0 ? prompt : continuationPrompt;
    }

    function getTerminalColumns(): number {
      const cols = (output as any).columns;
      return typeof cols === "number" && cols > 0 ? cols : 80;
    }

    function getVisualRowCount(lineIndex: number): number {
      const p = getPromptForRow(lineIndex);
      const lineWidth = getDisplayWidth(p) + getDisplayWidth(state.lines[lineIndex]);
      const cols = getTerminalColumns();
      if (lineWidth <= 0) return 1;
      return Math.ceil(lineWidth / cols);
    }

    function getTotalVisualRows(): number {
      let total = 0;
      for (let i = 0; i < state.lines.length; i++) {
        total += getVisualRowCount(i);
      }
      return total;
    }

    function getVisualRowOffset(logicalRow: number): number {
      let offset = 0;
      for (let i = 0; i < logicalRow; i++) {
        offset += getVisualRowCount(i);
      }
      return offset;
    }

    function render(): void {
      const cols = getTerminalColumns();
      const totalVisualRows = getTotalVisualRows();
      const maxVisualRows = Math.max(totalVisualRows, prevVisualRowCount);

      // Step 1: Move to the top of the edit area
      if (renderVisualRow > 0) {
        output.write(`\x1b[${renderVisualRow}A`);
      }
      output.write("\r");

      // Step 2: Clear all visual rows
      for (let v = 0; v < maxVisualRows; v++) {
        output.write("\x1b[2K");
        if (v < maxVisualRows - 1) {
          output.write("\n");
        }
      }
      if (maxVisualRows > 1) {
        output.write(`\x1b[${maxVisualRows - 1}A`);
      }
      output.write("\r");

      // Step 3: Write content (terminal handles auto-wrapping)
      for (let i = 0; i < state.lines.length; i++) {
        const p = getPromptForRow(i);
        output.write(p + state.lines[i]);
        if (i < state.lines.length - 1) {
          output.write("\n");
        }
      }

      // Step 4: Position cursor (accounting for visual rows + column boundary)
      const cursorPrompt = getPromptForRow(state.cursorRow);
      const cursorDisplayCol =
        getDisplayWidth(cursorPrompt) +
        getDisplayWidth(state.lines[state.cursorRow].slice(0, state.cursorCol));

      let cursorVisualRowInLine: number;
      let cursorColInVisualRow: number;

      if (cursorDisplayCol > 0 && cursorDisplayCol % cols === 0) {
        // Exact column boundary (deferred wrap position)
        // Treat as end of previous visual row
        cursorVisualRowInLine = (cursorDisplayCol / cols) - 1;
        cursorColInVisualRow = cols;
      } else {
        cursorVisualRowInLine = Math.floor(cursorDisplayCol / cols);
        cursorColInVisualRow = cursorDisplayCol % cols;
      }

      const cursorAbsoluteVisualRow =
        getVisualRowOffset(state.cursorRow) + cursorVisualRowInLine;

      // After writing, cursor is at the end of the last logical line.
      // With deferred wrap, cursor stays on totalVisualRows - 1.
      const currentVisualRow = totalVisualRows - 1;
      const rowDelta = currentVisualRow - cursorAbsoluteVisualRow;
      if (rowDelta > 0) {
        output.write(`\x1b[${rowDelta}A`);
      } else if (rowDelta < 0) {
        output.write(`\x1b[${-rowDelta}B`);
      }
      output.write("\r");
      if (cursorColInVisualRow > 0) {
        output.write(`\x1b[${cursorColInVisualRow}C`);
      }

      // Step 5: Update tracking state
      renderVisualRow = cursorAbsoluteVisualRow;
      prevVisualRowCount = totalVisualRows;
    }

    // Track rendering state
    let renderVisualRow = 0;
    let prevVisualRowCount = 1;

    function insertText(text: string): void {
      // Split text by newlines for paste support
      const parts = text.split(/\r\n|\r|\n/);
      const currentLine = state.lines[state.cursorRow];
      const before = currentLine.slice(0, state.cursorCol);
      const after = currentLine.slice(state.cursorCol);

      if (parts.length === 1) {
        // Single line insert
        state.lines[state.cursorRow] = before + parts[0] + after;
        state.cursorCol += [...parts[0]].length;
      } else {
        // Multiline insert
        state.lines[state.cursorRow] = before + parts[0];
        const newLines: string[] = [];
        for (let i = 1; i < parts.length - 1; i++) {
          newLines.push(parts[i]);
        }
        newLines.push(parts[parts.length - 1] + after);
        state.lines.splice(state.cursorRow + 1, 0, ...newLines);
        state.cursorRow += parts.length - 1;
        state.cursorCol = [...parts[parts.length - 1]].length;
      }
    }

    function insertNewline(): void {
      const currentLine = state.lines[state.cursorRow];
      const before = currentLine.slice(0, state.cursorCol);
      const after = currentLine.slice(state.cursorCol);
      state.lines[state.cursorRow] = before;
      state.lines.splice(state.cursorRow + 1, 0, after);
      state.cursorRow++;
      state.cursorCol = 0;
    }

    function handleBackspace(): void {
      if (state.cursorCol > 0) {
        const line = state.lines[state.cursorRow];
        const chars = [...line];
        const charsBefore = [...line.slice(0, state.cursorCol)];
        charsBefore.pop();
        state.lines[state.cursorRow] = charsBefore.join("") + chars.slice([...line.slice(0, state.cursorCol)].length).join("");
        state.cursorCol = charsBefore.join("").length;
      } else if (state.cursorRow > 0) {
        // Merge with previous line
        const prevLine = state.lines[state.cursorRow - 1];
        const currentLine = state.lines[state.cursorRow];
        state.lines[state.cursorRow - 1] = prevLine + currentLine;
        state.lines.splice(state.cursorRow, 1);
        state.cursorRow--;
        state.cursorCol = prevLine.length;
      }
    }

    function handleDelete(): void {
      const line = state.lines[state.cursorRow];
      if (state.cursorCol < line.length) {
        const before = line.slice(0, state.cursorCol);
        const afterChars = [...line.slice(state.cursorCol)];
        afterChars.shift();
        state.lines[state.cursorRow] = before + afterChars.join("");
      } else if (state.cursorRow < state.lines.length - 1) {
        // Merge with next line
        state.lines[state.cursorRow] = line + state.lines[state.cursorRow + 1];
        state.lines.splice(state.cursorRow + 1, 1);
      }
    }

    function handleArrowLeft(): void {
      if (state.cursorCol > 0) {
        // Move one character left
        const chars = [...state.lines[state.cursorRow].slice(0, state.cursorCol)];
        chars.pop();
        state.cursorCol = chars.join("").length;
      } else if (state.cursorRow > 0) {
        state.cursorRow--;
        state.cursorCol = state.lines[state.cursorRow].length;
      }
    }

    function handleArrowRight(): void {
      const line = state.lines[state.cursorRow];
      if (state.cursorCol < line.length) {
        // Move one character right
        const chars = [...line.slice(state.cursorCol)];
        const firstChar = chars[0];
        state.cursorCol += firstChar.length;
      } else if (state.cursorRow < state.lines.length - 1) {
        state.cursorRow++;
        state.cursorCol = 0;
      }
    }

    function handleArrowUp(): void {
      if (state.cursorRow > 0) {
        // Move to previous line within multiline buffer
        state.cursorRow--;
        state.cursorCol = Math.min(state.cursorCol, state.lines[state.cursorRow].length);
      } else {
        // Navigate history
        if (state.historyIndex < history.length - 1) {
          if (state.historyIndex === -1) {
            state.savedInput = [...state.lines];
          }
          state.historyIndex++;
          const entry = history[state.historyIndex];
          state.lines = entry.split("\n");
          state.cursorRow = state.lines.length - 1;
          state.cursorCol = state.lines[state.cursorRow].length;
        }
      }
    }

    function handleArrowDown(): void {
      if (state.cursorRow < state.lines.length - 1) {
        // Move to next line within multiline buffer
        state.cursorRow++;
        state.cursorCol = Math.min(state.cursorCol, state.lines[state.cursorRow].length);
      } else {
        // Navigate history
        if (state.historyIndex >= 0) {
          state.historyIndex--;
          if (state.historyIndex === -1) {
            state.lines = [...state.savedInput];
          } else {
            const entry = history[state.historyIndex];
            state.lines = entry.split("\n");
          }
          state.cursorRow = state.lines.length - 1;
          state.cursorCol = state.lines[state.cursorRow].length;
        }
      }
    }

    function handleCtrlA(): void {
      state.cursorCol = 0;
    }

    function handleCtrlE(): void {
      state.cursorCol = state.lines[state.cursorRow].length;
    }

    function handleCtrlU(): void {
      const after = state.lines[state.cursorRow].slice(state.cursorCol);
      state.lines[state.cursorRow] = after;
      state.cursorCol = 0;
    }

    function handleCtrlK(): void {
      state.lines[state.cursorRow] = state.lines[state.cursorRow].slice(0, state.cursorCol);
    }

    function processChar(ch: string): void {
      switch (parseState) {
        case ParseState.NORMAL:
          processNormal(ch);
          break;
        case ParseState.ESC_SEEN:
          processEscSeen(ch);
          break;
        case ParseState.CSI_PARSING:
          processCsi(ch);
          break;
        case ParseState.PASTE:
          processPaste(ch);
          break;
      }
    }

    function processNormal(ch: string): void {
      const code = ch.charCodeAt(0);

      if (ch === "\x1b") {
        parseState = ParseState.ESC_SEEN;
        return;
      }

      switch (code) {
        case 0x03: // Ctrl+C
          output.write("\n");
          finish({ type: "cancel" });
          return;
        case 0x04: { // Ctrl+D
          const buffer = state.lines.join("\n");
          if (buffer.length === 0) {
            output.write("\n");
            finish({ type: "eof" });
          } else {
            output.write("\n");
            finish({ type: "input", value: buffer });
          }
          return;
        }
        case 0x0a: // Ctrl+J (LF) → insert newline
          insertNewline();
          render();
          return;
        case 0x0d: { // Enter (CR) → submit
          output.write("\n");
          const value = state.lines.join("\n");
          finish({ type: "input", value });
          return;
        }
        case 0x7f: // Backspace
          handleBackspace();
          render();
          return;
        case 0x01: // Ctrl+A
          handleCtrlA();
          render();
          return;
        case 0x05: // Ctrl+E
          handleCtrlE();
          render();
          return;
        case 0x15: // Ctrl+U
          handleCtrlU();
          render();
          return;
        case 0x0b: // Ctrl+K
          handleCtrlK();
          render();
          return;
        default:
          // Printable character
          if (code >= 0x20) {
            insertText(ch);
            render();
          }
          return;
      }
    }

    function processEscSeen(ch: string): void {
      if (ch === "[") {
        parseState = ParseState.CSI_PARSING;
        csiBuffer = "";
        return;
      }
      if (ch === "\r" || ch === "\n") {
        // Alt+Enter → insert newline
        insertNewline();
        render();
        parseState = ParseState.NORMAL;
        return;
      }
      // Unknown escape sequence, ignore
      parseState = ParseState.NORMAL;
      // Re-process char as normal in case it's a printable char
      processNormal(ch);
    }

    function processCsi(ch: string): void {
      const code = ch.charCodeAt(0);
      // CSI parameters are 0x30-0x3F, intermediates are 0x20-0x2F
      if (code >= 0x30 && code <= 0x3f) {
        csiBuffer += ch;
        return;
      }
      if (code >= 0x20 && code <= 0x2f) {
        csiBuffer += ch;
        return;
      }
      // Final byte 0x40-0x7E
      if (code >= 0x40 && code <= 0x7e) {
        const seq = csiBuffer + ch;
        handleCsiSequence(seq);
        // Only reset to NORMAL if handleCsiSequence didn't change state
        // (e.g. bracket paste sets PASTE state)
        if (parseState === ParseState.CSI_PARSING) {
          parseState = ParseState.NORMAL;
        }
        return;
      }
      // Invalid, reset
      parseState = ParseState.NORMAL;
    }

    function handleCsiSequence(seq: string): void {
      switch (seq) {
        case "A": // Up
          handleArrowUp();
          render();
          return;
        case "B": // Down
          handleArrowDown();
          render();
          return;
        case "C": // Right
          handleArrowRight();
          render();
          return;
        case "D": // Left
          handleArrowLeft();
          render();
          return;
        case "H": // Home
          handleCtrlA();
          render();
          return;
        case "F": // End
          handleCtrlE();
          render();
          return;
        case "3~": // Delete
          handleDelete();
          render();
          return;
        case "200~": // Bracket paste start
          parseState = ParseState.PASTE;
          pasteBuffer = "";
          return;
        default:
          // Unknown CSI, ignore
          return;
      }
    }

    function processPaste(ch: string): void {
      pasteBuffer += ch;
      // Check for bracket paste end: \x1b[201~
      // We look for the sequence at the end of pasteBuffer
      if (pasteBuffer.endsWith("\x1b[201~")) {
        const text = pasteBuffer.slice(0, -"\x1b[201~".length);
        insertText(text);
        render();
        pasteBuffer = "";
        parseState = ParseState.NORMAL;
      }
    }

    function onData(chunk: Buffer | string): void {
      if (resolved) return;
      try {
        const str = typeof chunk === "string" ? chunk : decoder.write(chunk as Buffer);
        for (const ch of str) {
          if (resolved) return;
          processChar(ch);
        }
      } catch (err) {
        // On error, ensure cleanup and resolve cancel
        finish({ type: "cancel" });
      }
    }

    // Setup
    try {
      input.setRawMode?.(true);
    } catch {
      // ignore
    }
    try {
      output.write("\x1b[?2004h");
    } catch {
      // ignore
    }

    input.on("data", onData);
    if (typeof (output as any).on === "function") {
      (output as any).on("resize", onResize);
    }
    // readline.close() may leave stdin explicitly paused; resume() is safe/idempotent.
    input.resume();

    // Initial render (show prompt)
    try {
      render();
    } catch {
      finish({ type: "cancel" });
    }
  });
}
