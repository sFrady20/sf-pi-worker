// One-shot job store + scheduler. Jobs persist to a JSON file so a pending job
// survives a restart/reboot of the Pi. Two kinds:
//
//   reminder — fires a fixed string to Telegram.
//   wake     — fires a prompt at the agent, which runs a real turn and decides
//              in the moment what to do (or to stay quiet).
//
// A job may carry a `key`. Re-scheduling with the same key replaces the pending
// job instead of stacking a duplicate, so a planner can re-assert "there should
// be a wake 30 min before this meeting" on every pass and stay idempotent —
// including when the meeting moves.

import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { notify } from "./notify.js";
import { wakeAgent } from "./wake.js";

export type JobType = "reminder" | "wake";

export interface Job {
  id: string;
  type: JobType;
  message: string; // reminder text, or the wake prompt
  fireAt: number; // epoch ms
  key?: string; // caller-defined dedup key
  source?: string; // what asked for it, for the agent's context on wake
}

const FILE = process.env.JOBS_FILE ?? "./data/jobs.json";
const MAX_TIMEOUT = 2_147_483_647; // setTimeout caps at ~24.8 days
const RETRY_MS = 60_000;
const MAX_RETRY_WINDOW_MS = 6 * 3_600_000; // stop retrying a job this far past due

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
      case "wake":
        await wakeAgent(job.message, job.source ?? "scheduled");
        break;
    }
  } catch (err) {
    // Delivery failed (Telegram or the agent unreachable) — keep the job and
    // retry, so a scheduled moment is never silently lost. A duplicate beats a
    // loss. Give up once it's long stale; by then it isn't the moment anymore.
    const stale = Date.now() - job.fireAt > MAX_RETRY_WINDOW_MS;
    console.error(
      stale
        ? `[worker] job delivery failed and is stale — dropping ${job.id}`
        : `[worker] job delivery failed — retrying in ${RETRY_MS / 1000}s ${job.id}`,
      err,
    );
    if (!stale) {
      job.fireAt = Date.now() + RETRY_MS;
      await persist();
      arm(job);
      return;
    }
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

function disarm(id: string): void {
  const timer = timers.get(id);
  if (timer) clearTimeout(timer);
  timers.delete(id);
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

export interface ScheduleInput {
  type?: JobType;
  message: string;
  fireAt: number; // epoch ms
  key?: string;
  source?: string;
}

export async function scheduleJob(input: ScheduleInput): Promise<Job> {
  // Same key => re-time the existing job rather than stacking a duplicate.
  if (input.key) {
    const existing = jobs.find((j) => j.key === input.key);
    if (existing) {
      disarm(existing.id);
      jobs = jobs.filter((j) => j.id !== existing.id);
    }
  }
  const job: Job = {
    id: randomUUID(),
    type: input.type ?? "reminder",
    message: input.message,
    fireAt: Math.max(Date.now(), input.fireAt),
    key: input.key,
    source: input.source,
  };
  jobs.push(job);
  await persist();
  arm(job);
  return job;
}

export function scheduleReminder(message: string, delaySeconds: number): Promise<Job> {
  return scheduleJob({ type: "reminder", message, fireAt: Date.now() + Math.max(0, delaySeconds) * 1000 });
}

export function listJobs(): Job[] {
  return [...jobs];
}

export async function cancelJob(id: string): Promise<boolean> {
  disarm(id);
  const before = jobs.length;
  jobs = jobs.filter((j) => j.id !== id);
  if (jobs.length === before) return false;
  await persist();
  return true;
}

// Cancel by dedup key — lets a planner withdraw a wake whose reason disappeared
// (a meeting was cancelled) without tracking the job id.
export async function cancelJobByKey(key: string): Promise<boolean> {
  const job = jobs.find((j) => j.key === key);
  return job ? cancelJob(job.id) : false;
}
