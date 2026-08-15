// Presence-triggered work: "remind me when I get home / when I leave", and the
// same trigger used to wake the agent for a real turn ("when I get home, decide
// whether the lights should change"). Persisted separately from timed jobs;
// fired by the presence monitor on an arrival/departure transition.
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { notify } from "../notify.js";
import { wakeAgent } from "../wake.js";

export type Presence = "home" | "away";

export interface PresenceReminder {
  id: string;
  message: string; // reminder text, or the wake prompt
  trigger: Presence;
  kind: "notify" | "wake";
  createdAt: string;
}

const FILE = process.env.PRESENCE_FILE ?? "./data/presence.json";
let reminders: PresenceReminder[] = [];

async function persist(): Promise<void> {
  await mkdir(dirname(FILE), { recursive: true });
  await writeFile(FILE, JSON.stringify(reminders, null, 2));
}

export async function loadPresenceReminders(): Promise<void> {
  try {
    const loaded = JSON.parse(await readFile(FILE, "utf8")) as PresenceReminder[];
    // Entries written before wake existed carry no kind — they were all notifies.
    reminders = loaded.map((r) => ({ ...r, kind: r.kind ?? "notify" }));
  } catch {
    reminders = [];
  }
  console.log(`[presence] loaded ${reminders.length} pending reminder(s)`);
}

export async function addPresenceReminder(
  message: string,
  trigger: Presence,
  kind: PresenceReminder["kind"] = "notify",
): Promise<PresenceReminder> {
  const r: PresenceReminder = { id: randomUUID(), message, trigger, kind, createdAt: new Date().toISOString() };
  reminders.push(r);
  await persist();
  return r;
}

export function listPresenceReminders(): PresenceReminder[] {
  return [...reminders];
}

export async function cancelPresenceReminder(id: string): Promise<boolean> {
  const before = reminders.length;
  reminders = reminders.filter((r) => r.id !== id);
  if (reminders.length === before) return false;
  await persist();
  return true;
}

export async function firePresence(trigger: Presence): Promise<number> {
  const due = reminders.filter((r) => r.trigger === trigger);
  if (due.length === 0) return 0;
  const prefix = trigger === "home" ? "🏠 Welcome home — reminder" : "👋 On your way out — reminder";
  // Keep any reminder whose delivery failed — it fires again on the next transition.
  const failed: PresenceReminder[] = [];
  for (const r of due) {
    try {
      if (r.kind === "wake") await wakeAgent(r.message, `presence:${trigger}`);
      else await notify(`${prefix}: ${r.message}`);
    } catch (e) {
      console.error("[presence] notify failed — keeping reminder", r.id, e);
      failed.push(r);
    }
  }
  reminders = reminders.filter((r) => r.trigger !== trigger).concat(failed);
  await persist();
  return due.length - failed.length;
}
