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
    write("verbose", `${message}\n${content}`);
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
