// Wake the agent. A scheduled moment runs a real agent turn (all tools, all
// memory) instead of emitting a fixed string, so the agent decides in the moment
// what — if anything — to say. Falls back to a plain Telegram notify when the
// wake route is unset or unreachable, so a scheduled thought is never lost.

import { notify } from "./notify.js";

const TIMEOUT_MS = 20_000;

export function wakeConfigured(): boolean {
  return Boolean(process.env.AGENT_WAKE_URL && process.env.AGENT_WAKE_SECRET);
}

export async function wakeAgent(prompt: string, source = "wake"): Promise<void> {
  const url = process.env.AGENT_WAKE_URL;
  const secret = process.env.AGENT_WAKE_SECRET;
  if (!url || !secret) {
    await notify(prompt); // no wake route — deliver as text rather than drop it
    return;
  }
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" },
    body: JSON.stringify({ prompt, source }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`agent wake ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
  }
}
