// Durable recurring wakeups — the agent's own clock. Named entries with
// minute-precise local times and weekday selection, persisted to JSON so they
// survive a reboot. Same editing shape as the lighting schedule (replace /
// remove / upsert by name), because the agent already knows that idiom.
//
// An entry either wakes the agent (a real turn: it decides in the moment what to
// do, or to stay quiet) or pushes a fixed string to Telegram. This is what lets
// the agent add, retime, reword, disable, or delete its own recurring thinking
// without a redeploy.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { notify } from "./notify.js";
import { wakeAgent } from "./wake.js";

export const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
export type Weekday = (typeof WEEKDAYS)[number];

export interface CronEntry {
  name: string;
  start: string; // "HH:mm", local to the entry's timezone
  days: Weekday[];
  enabled: boolean;
  kind: "wake" | "notify";
  prompt: string; // the wake prompt, or the notify text
  timezone?: string; // per-entry override of the store default
  lastFired?: string; // local occurrence key, e.g. "2026-08-15T08:00"
  lastFiredAt?: string; // ISO, for the agent's benefit
}

export interface CronUpdate {
  replace?: Partial<CronEntry>[];
  remove?: string[];
  upsert?: Partial<CronEntry>[];
}

interface CronStore {
  seeded: boolean;
  timezone: string;
  entries: CronEntry[];
}

const FILE = process.env.CRONS_FILE ?? "./data/crons.json";
const TICK_MS = 20_000;
// A tick can be late (busy box, clock skew, a restart) — still fire an entry we
// missed by a few minutes rather than skipping the day entirely.
const CATCHUP_MINUTES = 10;

export class CronInputError extends Error {}

function fail(message: string): never {
  throw new CronInputError(message);
}

let store: CronStore = { seeded: false, timezone: defaultTimezone(), entries: [] };
let ticker: ReturnType<typeof setInterval> | null = null;

// Same zone the lighting schedule uses — one local clock for the whole box.
function defaultTimezone(): string {
  return process.env.OWNER_TIMEZONE ?? process.env.TZ ?? "America/New_York";
}

function validTimezone(tz: string): string {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
  } catch {
    fail(`unknown timezone ${tz}`);
  }
  return tz;
}

function timeMinutes(start: string): number {
  const [h, m] = start.split(":").map(Number);
  return h * 60 + m;
}

function localParts(timezone: string, now: Date): { weekday: Weekday; minutes: number; date: string } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      weekday: "short",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(now)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
  return {
    weekday: parts.weekday.toLocaleLowerCase().slice(0, 3) as Weekday,
    minutes: Number(parts.hour) * 60 + Number(parts.minute),
    date: `${parts.year}-${parts.month}-${parts.day}`,
  };
}

// --- normalization ---------------------------------------------------------

function normalizeName(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) fail(`${field}.name must be a non-empty string`);
  return (value as string).trim();
}

function normalizeStart(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)) {
    fail(`${field}.start must be a 24-hour local time as HH:mm`);
  }
  return value as string;
}

function normalizeDays(value: unknown, field: string): Weekday[] {
  if (!Array.isArray(value) || value.length === 0) fail(`${field}.days must contain at least one weekday`);
  const days = value.map((day) => {
    if (typeof day !== "string" || !WEEKDAYS.includes(day as Weekday)) {
      fail(`${field}.days contains invalid weekday ${String(day)}`);
    }
    return day as Weekday;
  });
  return [...new Set(days)];
}

function createOrPatch(input: Partial<CronEntry>, existing: CronEntry | undefined, field: string): CronEntry {
  const base: CronEntry = existing
    ? { ...existing }
    : { name: "", start: "", days: [...WEEKDAYS], enabled: true, kind: "wake", prompt: "" };

  base.name = normalizeName(input.name ?? base.name, field);
  if (input.start !== undefined || !existing) base.start = normalizeStart(input.start ?? base.start, field);
  if (input.days !== undefined) base.days = normalizeDays(input.days, field);
  if (input.enabled !== undefined) {
    if (typeof input.enabled !== "boolean") fail(`${field}.enabled must be a boolean`);
    base.enabled = input.enabled;
  }
  if (input.kind !== undefined) {
    if (input.kind !== "wake" && input.kind !== "notify") fail(`${field}.kind must be 'wake' or 'notify'`);
    base.kind = input.kind;
  }
  if (input.prompt !== undefined) {
    if (typeof input.prompt !== "string" || !input.prompt.trim()) fail(`${field}.prompt must be a non-empty string`);
    base.prompt = input.prompt.trim();
  }
  if (input.timezone !== undefined) {
    base.timezone = input.timezone === null ? undefined : validTimezone(String(input.timezone));
  }

  if (!base.prompt) fail(`${field}.prompt is required`);
  // A retimed or rewritten entry should be able to fire again today.
  if (existing && (existing.start !== base.start || existing.prompt !== base.prompt)) {
    delete base.lastFired;
  }
  return base;
}

// --- persistence -----------------------------------------------------------

async function persist(): Promise<void> {
  await mkdir(dirname(FILE), { recursive: true });
  await writeFile(FILE, JSON.stringify(store, null, 2));
}

// Seeded once, on a box that has never had a cron file. After that the list is
// the agent's to own — a deliberately emptied schedule stays empty.
const SEED: CronEntry[] = [
  {
    name: "morning_brief",
    start: "08:00",
    days: [...WEEKDAYS],
    enabled: true,
    kind: "wake",
    prompt:
      "Morning brief for Steven. Call current_time first. Then look at today's calendar " +
      "(list_calendar_events), tasks and chores due (list_tasks), and anything in the inbox " +
      "worth surfacing (list_inbox / recall). Use work_schedule as background only — never " +
      "announce whether it's a workday, he knows. Send a few bullets covering what's genuinely " +
      "useful: collisions, prep, deadlines. If there is nothing worth his attention, say nothing " +
      "and end the turn quietly rather than sending an empty brief.",
  },
  {
    name: "evening_review",
    start: "20:30",
    days: [...WEEKDAYS],
    enabled: true,
    kind: "wake",
    prompt:
      "Evening review for Steven. Call current_time first. Cover what's still open or overdue " +
      "(list_tasks), anything left in the inbox (list_inbox), and a heads-up on tomorrow — " +
      "tomorrow's calendar (list_calendar_events over tomorrow's range) and anything due then. " +
      "Use work_schedule as background only; flag something actionable about tomorrow (an early " +
      "meeting, an in-office day worth prepping tonight) rather than restating his status. Two to " +
      "four bullets. If nothing is worth his attention, say nothing and end the turn quietly.",
  },
];

export async function loadCrons(): Promise<void> {
  try {
    const raw = JSON.parse(await readFile(FILE, "utf8")) as CronStore;
    store = {
      seeded: raw.seeded !== false,
      timezone: raw.timezone ?? defaultTimezone(),
      entries: Array.isArray(raw.entries) ? raw.entries : [],
    };
  } catch {
    store = { seeded: true, timezone: defaultTimezone(), entries: SEED.map((e) => ({ ...e })) };
    await persist();
    console.log("[crons] seeded default morning_brief + evening_review");
  }
  console.log(`[crons] loaded ${store.entries.length} recurring entr(ies), tz ${store.timezone}`);
}

// --- firing ----------------------------------------------------------------

async function fireEntry(entry: CronEntry, occurrence: string): Promise<void> {
  // Mark before firing: a crash mid-delivery loses one occurrence, which beats a
  // restart loop re-firing the same wake forever.
  entry.lastFired = occurrence;
  entry.lastFiredAt = new Date().toISOString();
  await persist();
  try {
    if (entry.kind === "wake") await wakeAgent(entry.prompt, `cron:${entry.name}`);
    else await notify(entry.prompt);
    console.log(`[crons] fired ${entry.name} (${occurrence})`);
  } catch (err) {
    console.error(`[crons] ${entry.name} failed`, err);
  }
}

async function tick(now = new Date()): Promise<void> {
  for (const entry of store.entries) {
    if (!entry.enabled) continue;
    let local;
    try {
      local = localParts(entry.timezone ?? store.timezone, now);
    } catch {
      continue; // a bad timezone shouldn't wedge the whole ticker
    }
    if (!entry.days.includes(local.weekday)) continue;
    const due = timeMinutes(entry.start);
    const late = local.minutes - due;
    if (late < 0 || late > CATCHUP_MINUTES) continue;
    const occurrence = `${local.date}T${entry.start}`;
    if (entry.lastFired === occurrence) continue;
    await fireEntry(entry, occurrence);
  }
}

export function startCrons(): void {
  if (ticker) return;
  ticker = setInterval(() => void tick().catch((e) => console.error("[crons] tick failed", e)), TICK_MS);
  void tick().catch((e) => console.error("[crons] tick failed", e));
}

// --- public API ------------------------------------------------------------

function nextRun(entry: CronEntry, now = new Date()): string | null {
  const tz = entry.timezone ?? store.timezone;
  let local;
  try {
    local = localParts(tz, now);
  } catch {
    return null;
  }
  const due = timeMinutes(entry.start);
  const today = WEEKDAYS.indexOf(local.weekday);
  for (let ahead = 0; ahead <= 7; ahead++) {
    const weekday = WEEKDAYS[(today + ahead) % 7];
    if (!entry.days.includes(weekday)) continue;
    if (ahead === 0 && local.minutes >= due) continue;
    const [y, m, d] = local.date.split("-").map(Number);
    const date = new Date(Date.UTC(y, m - 1, d + ahead)).toISOString().slice(0, 10);
    return `${date}T${entry.start} (${tz})`;
  }
  return null;
}

export function cronsView(): {
  timezone: string;
  entries: Array<CronEntry & { nextRun: string | null }>;
} {
  return {
    timezone: store.timezone,
    entries: store.entries.map((entry) => ({ ...entry, nextRun: nextRun(entry) })),
  };
}

export async function configureCrons(input: CronUpdate): Promise<void> {
  if (!input || typeof input !== "object") fail("body must be an object");
  if (input.replace === undefined && !input.remove?.length && !input.upsert?.length) {
    fail("provide replace, or at least one remove or upsert entry");
  }

  let entries = store.entries;

  if (input.replace !== undefined) {
    if (!Array.isArray(input.replace)) fail("replace must be an array");
    entries = input.replace.map((entry, i) => createOrPatch(entry, undefined, `replace[${i}]`));
  }

  for (const name of input.remove ?? []) {
    const key = normalizeName(name, "remove").toLocaleLowerCase();
    entries = entries.filter((entry) => entry.name.toLocaleLowerCase() !== key);
  }

  if (input.upsert) {
    if (!Array.isArray(input.upsert)) fail("upsert must be an array");
    input.upsert.forEach((entry, i) => {
      const field = `upsert[${i}]`;
      const key = normalizeName(entry.name, field).toLocaleLowerCase();
      const at = entries.findIndex((e) => e.name.toLocaleLowerCase() === key);
      const next = createOrPatch(entry, at >= 0 ? entries[at] : undefined, field);
      if (at >= 0) entries[at] = next;
      else entries.push(next);
    });
  }

  const seen = new Set<string>();
  for (const entry of entries) {
    const key = entry.name.toLocaleLowerCase();
    if (seen.has(key)) fail(`duplicate entry name ${entry.name}`);
    seen.add(key);
  }

  store.entries = entries;
  await persist();
}

export async function setCronTimezone(tz: string): Promise<void> {
  store.timezone = validTimezone(tz);
  await persist();
}

export async function runCronNow(name: string): Promise<boolean> {
  const entry = store.entries.find((e) => e.name.toLocaleLowerCase() === name.trim().toLocaleLowerCase());
  if (!entry) return false;
  const local = localParts(entry.timezone ?? store.timezone, new Date());
  await fireEntry(entry, `${local.date}T${entry.start}:manual`);
  return true;
}
