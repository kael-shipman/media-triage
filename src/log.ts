export type Level = "debug" | "info" | "warn" | "error";
export const LEVELS: readonly Level[] = ["debug", "info", "warn", "error"];

const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
// Under systemd, a "<N>" prefix sets the journal's priority, and the journal adds its own timestamps.
const SYSLOG_PRIORITY: Record<Level, number> = { debug: 7, info: 6, warn: 4, error: 3 };
const UNDER_SYSTEMD = Boolean(process.env.JOURNAL_STREAM);

let threshold = ORDER.info;

export function setLogLevel(level: Level): void {
  threshold = ORDER[level];
}

export type Fields = Record<string, unknown>;

function formatValue(value: unknown): string {
  if (value instanceof Error) return JSON.stringify(value.message);
  if (typeof value === "string") return /^[^\s"=]+$/.test(value) ? value : JSON.stringify(value);
  return JSON.stringify(value) ?? "undefined";
}

function write(level: Level, message: string, fields?: Fields): void {
  if (ORDER[level] < threshold) return;
  const details = fields
    ? Object.entries(fields)
        .filter(([, value]) => value !== undefined)
        .map(([key, value]) => ` ${key}=${formatValue(value)}`)
        .join("")
    : "";
  const prefix = UNDER_SYSTEMD ? `<${SYSLOG_PRIORITY[level]}>` : `${new Date().toISOString()} ${level.padEnd(5)} `;
  const line = `${prefix}${message}${details}\n`;
  if (ORDER[level] >= ORDER.warn) process.stderr.write(line);
  else process.stdout.write(line);
}

export const log = {
  debug: (message: string, fields?: Fields) => write("debug", message, fields),
  info: (message: string, fields?: Fields) => write("info", message, fields),
  warn: (message: string, fields?: Fields) => write("warn", message, fields),
  error: (message: string, fields?: Fields) => write("error", message, fields),
};
