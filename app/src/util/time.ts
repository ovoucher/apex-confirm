export const DAY = 86_400;

/** "2026-08-31" -> 1788134400 (00:00:00 UTC of that date; the register's balance-date convention). */
export function dateToAsOf(date: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date.trim());
  if (!m) throw new Error(`bad date "${date}" (want YYYY-MM-DD)`);
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / 1000;
}

export function isoDate(ts: number): string {
  return new Date(ts * 1000).toISOString().slice(0, 10);
}

export function isoTime(ts: number): string {
  return new Date(ts * 1000).toISOString().replace(".000Z", "Z");
}

export function parseIso(s: string): number {
  const t = Date.parse(s);
  if (Number.isNaN(t)) throw new Error(`bad timestamp "${s}"`);
  return Math.floor(t / 1000);
}
