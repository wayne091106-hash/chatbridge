/**
 * Schedule expressions (local time):
 *   cron:      "*\/15 9-18 * * 1-5"  (minute hour day-of-month month day-of-week, 0/7 = Sunday)
 *   macros:    @hourly @daily @weekly @monthly @yearly
 *   friendly:  "every 30m" | "every 2h" | "every 1d" | "daily 09:30" | "weekdays 08:00" | "weekly mon 10:00"
 *   one-shot:  "in 20m" | "at 2026-09-20 09:00" (normalised to "at <ISO>")
 */

const UNIT_MS: Record<string, number> = { m: 60_000, min: 60_000, h: 3_600_000, hr: 3_600_000, d: 86_400_000, day: 86_400_000 };
const DOW: Record<string, number> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };

export interface CronFields {
  minute: Set<number>;
  hour: Set<number>;
  dom: Set<number>;
  month: Set<number>;
  dow: Set<number>;
  domAny: boolean;
  dowAny: boolean;
}

function parseField(expr: string, min: number, max: number, names?: Record<string, number>): Set<number> {
  const out = new Set<number>();
  for (const part of expr.split(",")) {
    const [rangePart, stepPart] = part.split("/");
    const step = stepPart ? Number(stepPart) : 1;
    if (!Number.isInteger(step) || step < 1) throw new Error(`invalid step in "${part}"`);
    let lo = min;
    let hi = max;
    const val = (s: string) => {
      const n = names?.[s.toLowerCase().slice(0, 3)] ?? Number(s);
      if (!Number.isInteger(n)) throw new Error(`invalid value "${s}"`);
      return n;
    };
    if (rangePart !== "*") {
      const [a, b] = rangePart!.split("-");
      lo = val(a!);
      hi = b !== undefined ? val(b) : stepPart ? max : lo;
    }
    if (lo < min || hi > max || lo > hi) throw new Error(`value out of range in "${part}" (${min}-${max})`);
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out;
}

export function parseCron(expr: string): CronFields {
  const macros: Record<string, string> = { "@hourly": "0 * * * *", "@daily": "0 0 * * *", "@midnight": "0 0 * * *", "@weekly": "0 0 * * 0", "@monthly": "0 0 1 * *", "@yearly": "0 0 1 1 *", "@annually": "0 0 1 1 *" };
  const e = macros[expr.trim().toLowerCase()] ?? expr.trim();
  const parts = e.split(/\s+/);
  if (parts.length !== 5) throw new Error(`cron needs 5 fields, got ${parts.length}: "${expr}"`);
  const dow = parseField(parts[4]!, 0, 7, DOW);
  if (dow.has(7)) {
    dow.delete(7);
    dow.add(0);
  }
  return {
    minute: parseField(parts[0]!, 0, 59),
    hour: parseField(parts[1]!, 0, 23),
    dom: parseField(parts[2]!, 1, 31),
    month: parseField(parts[3]!, 1, 12, { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 }),
    dow,
    domAny: parts[2] === "*",
    dowAny: parts[4] === "*",
  };
}

export function cronNext(fields: CronFields, from: Date): Date | null {
  const d = new Date(from.getTime());
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + 1);
  const limit = from.getTime() + 366 * 86_400_000 * 5;
  while (d.getTime() <= limit) {
    if (!fields.month.has(d.getMonth() + 1)) {
      d.setMonth(d.getMonth() + 1, 1);
      d.setHours(0, 0, 0, 0);
      continue;
    }
    const domOk = fields.dom.has(d.getDate());
    const dowOk = fields.dow.has(d.getDay());
    // Vixie cron: if both restricted, either may match.
    const dayOk = fields.domAny && fields.dowAny ? true : fields.domAny ? dowOk : fields.dowAny ? domOk : domOk || dowOk;
    if (!dayOk) {
      d.setDate(d.getDate() + 1);
      d.setHours(0, 0, 0, 0);
      continue;
    }
    if (!fields.hour.has(d.getHours())) {
      d.setHours(d.getHours() + 1, 0, 0, 0);
      continue;
    }
    if (!fields.minute.has(d.getMinutes())) {
      d.setMinutes(d.getMinutes() + 1, 0, 0);
      continue;
    }
    return d;
  }
  return null;
}

function hm(s: string): [number, number] {
  const m = s.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) throw new Error(`expected HH:MM, got "${s}"`);
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (h > 23 || mi > 59) throw new Error(`invalid time "${s}"`);
  return [h, mi];
}

/** Normalise user input into a canonical schedule string, validating it. */
export function normalizeSchedule(input: string, now = new Date()): string {
  const s = input.trim().replace(/\s+/g, " ");
  const lower = s.toLowerCase();
  let m: RegExpMatchArray | null;
  if ((m = lower.match(/^in (\d+(?:\.\d+)?) ?(m|min|minutes?|h|hr|hours?|d|days?)$/))) {
    const unit = m[2]!.startsWith("m") ? "m" : m[2]!.startsWith("h") ? "h" : "d";
    return `at ${new Date(now.getTime() + Number(m[1]) * UNIT_MS[unit]!).toISOString()}`;
  }
  if ((m = s.match(/^at (.+)$/i))) {
    const t = Date.parse(m[1]!.includes("T") || m[1]!.endsWith("Z") ? m[1]! : m[1]!.replace(" ", "T"));
    if (Number.isNaN(t)) throw new Error(`cannot parse date "${m[1]}"`);
    return `at ${new Date(t).toISOString()}`;
  }
  if ((m = lower.match(/^every (\d+) ?(m|min|minutes?|h|hr|hours?|d|days?)$/))) {
    const unit = m[2]!.startsWith("m") ? "m" : m[2]!.startsWith("h") ? "h" : "d";
    if (Number(m[1]) < 1) throw new Error("interval must be >= 1");
    return `every ${Number(m[1])}${unit}`;
  }
  if ((m = lower.match(/^daily (\d{1,2}:\d{2})$/))) {
    const [h, mi] = hm(m[1]!);
    return `${mi} ${h} * * *`;
  }
  if ((m = lower.match(/^weekdays (\d{1,2}:\d{2})$/))) {
    const [h, mi] = hm(m[1]!);
    return `${mi} ${h} * * 1-5`;
  }
  if ((m = lower.match(/^weekly (sun|mon|tue|wed|thu|fri|sat)\w* (\d{1,2}:\d{2})$/))) {
    const [h, mi] = hm(m[2]!);
    return `${mi} ${h} * * ${DOW[m[1]!]}`;
  }
  parseCron(s); // throws if invalid
  return s;
}

export function nextRun(schedule: string, from: Date, lastRun?: Date | null): Date | null {
  if (schedule.startsWith("at ")) {
    const t = new Date(schedule.slice(3));
    return lastRun ? null : t;
  }
  const m = schedule.match(/^every (\d+)(m|h|d)$/);
  if (m) {
    const interval = Number(m[1]) * UNIT_MS[m[2]!]!;
    const base = lastRun ? lastRun.getTime() + interval : from.getTime() + interval;
    return new Date(Math.max(base, from.getTime() + 1000));
  }
  return cronNext(parseCron(schedule), from);
}

export function describeSchedule(schedule: string): string {
  if (schedule.startsWith("at ")) return `once at ${new Date(schedule.slice(3)).toLocaleString()}`;
  const m = schedule.match(/^every (\d+)(m|h|d)$/);
  if (m) return `every ${m[1]} ${{ m: "minute(s)", h: "hour(s)", d: "day(s)" }[m[2] as "m" | "h" | "d"]}`;
  return `cron "${schedule}"`;
}
