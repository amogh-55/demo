/**
 * Business timezone: Asia/Kolkata (UTC+05:30, no DST — ever).
 *
 * Convention used everywhere in this app:
 *   - a "business date" is a plain "YYYY-MM-DD" string in IST, never a Date.
 *   - a "minute of day" is an integer 0..1440 measured in IST.
 *   - every timestamp persisted to Mongo is a real UTC Date.
 *
 * Because India has no daylight saving, a fixed offset is correct and is far
 * less fragile than round-tripping through Intl formatting.
 */
export const IST_OFFSET_MINUTES = 330;
export const MINUTES_IN_DAY = 1440;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Wall-clock parts of `instant` as seen in IST. */
function istParts(instant: Date) {
  const shifted = new Date(instant.getTime() + IST_OFFSET_MINUTES * 60_000);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    minutes: shifted.getUTCHours() * 60 + shifted.getUTCMinutes(),
  };
}

/** "YYYY-MM-DD" for the IST calendar day containing `instant`. */
export function istDateString(instant: Date = new Date()): string {
  const { year, month, day } = istParts(instant);
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** Minutes since IST midnight for `instant` (0..1439). */
export function istMinutesOfDay(instant: Date = new Date()): number {
  return istParts(instant).minutes;
}

export function isValidBusinessDate(date: string): boolean {
  if (!DATE_RE.test(date)) return false;
  const [y, m, d] = date.split("-").map(Number);
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  // Reject impossible days such as 2026-02-30.
  const probe = new Date(Date.UTC(y, m - 1, d));
  return probe.getUTCFullYear() === y && probe.getUTCMonth() === m - 1 && probe.getUTCDate() === d;
}

/** The UTC instant of `date` + `minuteOfDay`, interpreted in IST. */
export function istInstant(date: string, minuteOfDay: number): Date {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d, 0, 0, 0) - IST_OFFSET_MINUTES * 60_000 + minuteOfDay * 60_000);
}

/** Whole days from IST-today to `date` (negative = past). */
export function daysFromToday(date: string, now: Date = new Date()): number {
  const startOfDate = istInstant(date, 0).getTime();
  const startOfToday = istInstant(istDateString(now), 0).getTime();
  return Math.round((startOfDate - startOfToday) / 86_400_000);
}

/** 1020 -> "5:00 PM" */
export function formatMinutes(minuteOfDay: number): string {
  const total = ((minuteOfDay % MINUTES_IN_DAY) + MINUTES_IN_DAY) % MINUTES_IN_DAY;
  const h24 = Math.floor(total / 60);
  const mm = total % 60;
  const suffix = h24 >= 12 ? "PM" : "AM";
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${h12}:${String(mm).padStart(2, "0")} ${suffix}`;
}

/** "5:00 PM – 7:00 PM" */
export function formatRange(startMin: number, endMin: number): string {
  return `${formatMinutes(startMin)} – ${formatMinutes(endMin)}`;
}

/** "2026-10-10" -> "Sat, 10 Oct 2026" */
export function formatBusinessDate(date: string): string {
  // A cleared date input sends "", which would otherwise render as "undefined NaN".
  if (!isValidBusinessDate(date)) return "—";
  const [y, m, d] = date.split("-").map(Number);
  const probe = new Date(Date.UTC(y, m - 1, d));
  const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][probe.getUTCDay()];
  const month = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][m - 1];
  return `${weekday}, ${d} ${month} ${y}`;
}

/** Timestamp rendered in IST, for admin screens. */
export function formatIstTimestamp(instant: Date | string): string {
  const d = typeof instant === "string" ? new Date(instant) : instant;
  if (Number.isNaN(d.getTime())) return "—";
  return `${formatBusinessDate(istDateString(d))}, ${formatMinutes(istMinutesOfDay(d))}`;
}

export function minutesToDuration(totalMinutes: number): string {
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  if (h && m) return `${h}h ${m}m`;
  if (h) return `${h} hour${h > 1 ? "s" : ""}`;
  return `${m}m`;
}
