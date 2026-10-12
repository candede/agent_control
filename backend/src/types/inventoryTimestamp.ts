export function isInventoryTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|[+-](\d{2}):([0-5]\d))$/);
  if (!match) return false;
  const [, year, month, day, hour, minute, second] = match.map(Number);
  const offsetHours = Number(match[7] ?? 0);
  if (year === 0 || offsetHours > 14 || offsetHours === 14 && match[8] !== "00") return false;
  const days = [31, year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return month >= 1 && month <= 12 && day >= 1 && day <= days[month - 1] && hour <= 23 && minute <= 59 && second <= 59;
}

export function compareInventoryInstants(left: string | Date, right: string | Date) {
  const text = (value: string | Date) => value instanceof Date
    ? Number.isFinite(value.getTime()) ? value.toISOString() : "" : value;
  const a = text(left), b = text(right);
  // Browser ISO parsing guarantees millisecond precision, not arbitrary fractions.
  const milliseconds = (value: string) => Date.parse(value.replace(/\.(\d+)(?=Z|[+-]\d{2}:\d{2}$)/,
    (_, fraction: string) => `.${fraction.slice(0, 3).padEnd(3, "0")}`));
  const difference = milliseconds(a) - milliseconds(b);
  if (!Number.isFinite(difference) || difference !== 0) return difference;
  // Date.parse drops the remaining fractional evidence after millisecond precision.
  const fraction = (value: string) => value.match(/\.(\d+)(?:Z|[+-]\d{2}:\d{2})$/)?.[1].slice(3).padEnd(6, "0") ?? "000000";
  return fraction(a) < fraction(b) ? -1 : fraction(a) > fraction(b) ? 1 : 0;
}
