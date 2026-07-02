// Job store + scheduler. Jobs persist to a JSON file so a pending reminder
// survives a restart/reboot of the Pi. New job types go in the `type` union and
// the `fire` switch.

import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { notify } from "./notify.js";

export interface Job {
  id: string;
  type: "reminder";
  message: string;
  fireAt: number; // epoch ms
}

const FILE = process.env.JOBS_FILE ?? "./data/jobs.json";
const MAX_TIMEOUT = 2_147_483_647; // setTimeout caps at ~24.8 days
const RETRY_MS = 60_000;

const timers = new Map<string, ReturnType<typeof setTimeout>>();
let jobs: Job[] = [];

async function persist(): Promise<void> {
  await mkdir(dirname(FILE), { recursive: true });
  await writeFile(FILE, JSON.stringify(jobs, null, 2));
}

async function fire(job: Job): Promise<void> {
  timers.delete(job.id);
  try {
    switch (job.type) {
      case "reminder":
        await notify(`⏰ Reminder: ${job.message}`);
        break;
    }
  } catch (err) {
    // Delivery failed (Telegram unreachable?) — keep the job and retry, so a
    // reminder is never silently lost. A crash mid-send can duplicate a ping;
    // for reminders a duplicate beats a loss.
    console.error(`[worker] job delivery failed — retrying in ${RETRY_MS / 1000}s`, job.id, err);
    job.fireAt = Date.now() + RETRY_MS;
    await persist();
    arm(job);
    return;
  }
  jobs = jobs.filter((j) => j.id !== job.id);
  await persist();
}

function arm(job: Job): void {
  const delay = Math.max(0, job.fireAt - Date.now());
  if (delay > MAX_TIMEOUT) {
    // Longer than setTimeout allows: sleep the max, then re-arm for the rest.
    timers.set(job.id, setTimeout(() => arm(job), MAX_TIMEOUT));
    return;
  }
  timers.set(
    job.id,
    setTimeout(() => void fire(job), delay),
  );
}

export async function loadAndArm(): Promise<void> {
  try {
    jobs = JSON.parse(await readFile(FILE, "utf8")) as Job[];
  } catch {
    jobs = [];
  }
  for (const job of jobs) arm(job);
  console.log(`[worker] loaded ${jobs.length} pending job(s)`);
}

export async function scheduleReminder(message: string, delaySeconds: number): Promise<Job> {
  const job: Job = {
    id: randomUUID(),
    type: "reminder",
    message,
    fireAt: Date.now() + Math.max(0, delaySeconds) * 1000,
  };
  jobs.push(job);
  await persist();
  arm(job);
  return job;
}

export function listJobs(): Job[] {
  return [...jobs];
}

export async function cancelJob(id: string): Promise<boolean> {
  const timer = timers.get(id);
  if (timer) clearTimeout(timer);
  timers.delete(id);
  const before = jobs.length;
  jobs = jobs.filter((j) => j.id !== id);
  if (jobs.length === before) return false;
  await persist();
  return true;
}
