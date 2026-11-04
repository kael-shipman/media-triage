// Which folder and file names a library limited by date includes (DESIGN.md, section 8).

export interface Day {
  year: number;
  month: number;
  day: number;
}

/** Parses "YYYY-MM-DD". */
export function parseDay(text: string): Day {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!match) throw new Error(`"${text}" isn't a date written YYYY-MM-DD`);
  return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
}

/** The last year a name's leading four digits count as a year. Anything above is a number, not a date. */
export const LAST_YEAR = 2099;

/**
 * Whether a name, directly inside one of a library's dated levels, belongs in a library limited to names dated on or
 * after `since`. A name is allowed when it starts with:
 * - a year after since's (up to 2099), whatever follows; or
 * - since's year, then a later month (up to 12), separated ("2020.07", "2020-07") or not ("202007"); or
 * - since's year and month, then a day from since's to 31 ("2020.06.15", "2020-06-15", "20200615").
 * What follows the date doesn't matter. Everything else is excluded: earlier dates, undated names, and names only as
 * precise as a year or month that holds `since` ("2020 Christmas", "2020.06").
 *
 * src/core/exclusions.ts generates the exclusion patterns from this rule, and its tests check that they agree.
 */
export function allowedSince(name: string, since: Day): boolean {
  const year = /^(\d{4})/.exec(name);
  if (!year) return false;
  const value = Number(year[1]);
  if (value !== since.year) return value > since.year && value <= LAST_YEAR;

  const rest = name.slice(4);
  const separated = /^[.-](\d{2})(?:[.-](\d{2}))?/.exec(rest);
  const compact = /^(\d{2})(\d{2})?/.exec(rest);
  const parts = separated ?? compact;
  if (!parts) return false;
  const month = Number(parts[1]);
  if (month !== since.month) return month > since.month && month <= 12;
  if (parts[2] === undefined) return false;
  const day = Number(parts[2]);
  return day >= since.day && day <= 31;
}
