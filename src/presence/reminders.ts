// "Remind me when I get home / when I leave" reminders. Persisted separately from
// timed jobs; fired by the presence monitor on an arrival/departure transition.
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { notify } from "../notify.js";

export type Presence = "home" | "away";

export interface PresenceReminder {
  id: string;
  message: string;
  trigger: Presence;
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
    reminders = JSON.parse(await readFile(FILE, "utf8")) as PresenceReminder[];
  } catch {
    reminders = [];
  }
  console.log(`[presence] loaded ${reminders.length} pending reminder(s)`);
}

export async function addPresenceReminder(message: string, trigger: Presence): Promise<PresenceReminder> {
  const r: PresenceReminder = { id: randomUUID(), message, trigger, createdAt: new Date().toISOString() };
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
      await notify(`${prefix}: ${r.message}`);
    } catch (e) {
      console.error("[presence] notify failed — keeping reminder", r.id, e);
      failed.push(r);
    }
  }
  reminders = reminders.filter((r) => r.trigger !== trigger).concat(failed);
  await persist();
  return due.length - failed.length;
}
