const UNITS: Record<string, number> = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 };

/** Parses a duration like "90s", "5m", "6h", "1d" or "1h30m" into milliseconds. */
export function parseDuration(text: string): number {
  const trimmed = text.trim();
  if (!/^(\d+(\.\d+)?(ms|s|m|h|d))+$/.test(trimmed)) {
    throw new Error(`"${text}" isn't a duration (write it like "90s", "5m", "6h", "1d" or "1h30m")`);
  }
  let total = 0;
  for (const [, amount, unit] of trimmed.matchAll(/(\d+(?:\.\d+)?)(ms|s|m|h|d)/g)) {
    total += Number(amount) * UNITS[unit!]!;
  }
  return total;
}

/** Formats milliseconds as the largest whole units, like "1h30m". */
export function formatDuration(ms: number): string {
  if (ms < 1_000) return `${ms}ms`;
  let rest = Math.round(ms / 1_000);
  const parts: string[] = [];
  for (const [unit, seconds] of [["d", 86_400], ["h", 3_600], ["m", 60], ["s", 1]] as const) {
    if (rest >= seconds) {
      parts.push(`${Math.floor(rest / seconds)}${unit}`);
      rest %= seconds;
    }
  }
  return parts.join("");
}
