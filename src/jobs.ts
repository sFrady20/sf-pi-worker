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
const timers = new Map<string, ReturnType<typeof setTimeout>>();
let jobs: Job[] = [];

async function persist(): Promise<void> {
  await mkdir(dirname(FILE), { recursive: true });
  await writeFile(FILE, JSON.stringify(jobs, null, 2));
}

async function fire(job: Job): Promise<void> {
  timers.delete(job.id);
  jobs = jobs.filter((j) => j.id !== job.id);
  await persist();
  try {
    switch (job.type) {
      case "reminder":
        await notify(`⏰ Reminder: ${job.message}`);
        break;
    }
  } catch (err) {
    console.error("[worker] job failed", job.id, err);
  }
}

function arm(job: Job): void {
  // setTimeout caps at ~24.8 days; reminders are far shorter.
  const delay = Math.min(Math.max(0, job.fireAt - Date.now()), 2_147_483_647);
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
