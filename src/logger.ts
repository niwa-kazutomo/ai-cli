import { LOG_TRUNCATE_HEAD, LOG_TRUNCATE_TAIL } from "./constants.js";
import type { LogLevel } from "./types.js";

let currentVerbose = false;
let currentDebug = false;

export function configureLogger(options: {
  verbose: boolean;
  debug: boolean;
}): void {
  currentVerbose = options.verbose;
  currentDebug = options.debug;
}

function truncate(text: string): string {
  if (text.length <= LOG_TRUNCATE_HEAD + LOG_TRUNCATE_TAIL + 20) {
    return text;
  }
  const head = text.slice(0, LOG_TRUNCATE_HEAD);
  const tail = text.slice(-LOG_TRUNCATE_TAIL);
  const omitted = text.length - LOG_TRUNCATE_HEAD - LOG_TRUNCATE_TAIL;
  return `${head}\n... (${omitted} 文字省略) ...\n${tail}`;
}

function write(level: LogLevel, message: string): void {
  const prefix = level === "error" ? "❌ " : level === "warn" ? "⚠ " : "";
  process.stderr.write(`${prefix}${message}\n`);
}

export function info(message: string): void {
  write("info", message);
}

export function warn(message: string): void {
  write("warn", message);
}

export function error(message: string): void {
  write("error", message);
}

export function verbose(message: string, content?: string): void {
  if (!currentVerbose && !currentDebug) return;
  if (content) {
    const displayContent = currentDebug ? content : truncate(content);
    write("verbose", `${message}\n${displayContent}`);
  } else {
    write("verbose", message);
  }
}

export function debug(message: string, content?: string): void {
  if (!currentDebug) return;
  if (content) {
    write("debug", `${message}\n${content}`);
  } else {
    write("debug", message);
  }
}
