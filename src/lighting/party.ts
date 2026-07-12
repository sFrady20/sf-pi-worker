// Party mode — a fast color loop across ALL lights, with occasional white
// flashes. Unlike the cooperative daemon it ignores ownership and taste hue
// limits: every non-excluded bulb joins. It snapshots each light first and
// restores that exact state on stop; the snapshot persists to disk so a worker
// restart mid-party resumes the party instead of stranding the lights.
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Color } from "./config.js";
import type { Lifx, LightState } from "./lifx.js";

export interface PartyInput {
  intensity?: number; // 1 chill … 10 rave (default 5)
  palette?: Color[]; // omit = full spectrum
  brightness?: number; // base brightness (default 80)
}

interface PartyOptions {
  intensity: number;
  palette: Color[] | null;
  brightness: number;
}

interface PartyState {
  options: PartyOptions;
  snapshot: Record<string, LightState>; // by light id — restored on stop
}

const STATE_FILE = process.env.PARTY_STATE_FILE ?? "./data/party-state.json";
const RESTORE_MS = 1500;
const FLASH_MS = 120;

let lifx: Lifx | null = null;
let isExcluded: (label: string) => boolean = () => false;
let state: PartyState | null = null;
let beatTimer: ReturnType<typeof setTimeout> | null = null;

// Start/stop arrive fire-and-forget from the HTTP layer — serialize them so a
// quick start→stop can't interleave mid-snapshot.
let ops: Promise<unknown> = Promise.resolve();
function serialize<T>(fn: () => Promise<T>): Promise<T> {
  const next = ops.then(fn, fn);
  ops = next.catch(() => {});
  return next;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const rand = (lo: number, hi: number) => lo + Math.random() * (hi - lo);
const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

// Intensity maps: tempo 3000ms → 660ms, flash odds ~4% → 20% per light per beat.
const beatMs = (intensity: number) => Math.round(3000 - (intensity - 1) * 260);
const flashChance = (intensity: number) => 0.02 + (intensity / 10) * 0.18;

function normalize(input: PartyInput): PartyOptions {
  return {
    intensity: clamp(Math.round(input.intensity ?? 5), 1, 10),
    palette: input.palette && input.palette.length > 0 ? input.palette : null,
    brightness: clamp(input.brightness ?? 80, 1, 100),
  };
}

function pickColor(o: PartyOptions): Color {
  if (o.palette) {
    const c = o.palette[Math.floor(Math.random() * o.palette.length)];
    return {
      hue: (c.hue + rand(-12, 12) + 360) % 360,
      saturation: clamp(c.saturation + rand(-8, 8), 40, 100),
    };
  }
  return { hue: rand(0, 360), saturation: rand(80, 100) };
}

// A quick white blast, then straight into a fresh color.
async function flashLight(l: Lifx, id: string, o: PartyOptions): Promise<void> {
  await l.setColor(id, { hue: 0, saturation: 0, brightness: 100, kelvin: 6500 }, FLASH_MS);
  await sleep(FLASH_MS + 80);
  await l.setColor(id, { ...pickColor(o), brightness: o.brightness, kelvin: 3500 }, 250);
}

function beat(): void {
  if (!state || !lifx) return;
  const l = lifx;
  const o = state.options;
  const transition = Math.round(beatMs(o.intensity) * 0.55);
  for (const { id, label } of l.list()) {
    if (isExcluded(label)) continue;
    const p =
      Math.random() < flashChance(o.intensity)
        ? flashLight(l, id, o)
        : l.setColor(
            id,
            { ...pickColor(o), brightness: Math.round(clamp(o.brightness + rand(-15, 10), 5, 100)), kelvin: 3500 },
            transition,
          );
    p.catch(() => {}); // a slow/offline bulb never stalls the beat
  }
  beatTimer = setTimeout(beat, beatMs(o.intensity));
}

async function persist(): Promise<void> {
  if (!state) return;
  try {
    await mkdir(dirname(STATE_FILE), { recursive: true });
    await writeFile(STATE_FILE, JSON.stringify(state));
  } catch (e) {
    console.warn("[party] state save failed:", (e as Error).message);
  }
}

export function isActive(): boolean {
  return state !== null;
}

export function partyStatus(): { active: boolean } & Partial<PartyOptions> {
  return state ? { active: true, ...state.options } : { active: false };
}

// Start the party, or retune it (intensity/colors/brightness) if already going —
// the original snapshot is kept so stop still restores the true pre-party state.
export async function start(l: Lifx, input: PartyInput, excluded: (label: string) => boolean): Promise<void> {
  return serialize(async () => {
    lifx = l;
    isExcluded = excluded;
    if (state) {
      state.options = normalize(input);
      await persist();
      return;
    }
    const snapshot: Record<string, LightState> = {};
    for (const { id, label } of l.list()) {
      if (excluded(label)) continue;
      try {
        snapshot[id] = await l.getState(id);
      } catch {
        // unreachable bulb — leave it out of the party
      }
    }
    state = { options: normalize(input), snapshot };
    await persist();
    for (const id of Object.keys(snapshot)) await l.setPower(id, true, 300).catch(() => {});
    beat();
  });
}

// Stop and put every light back exactly as it was. Returns false if no party.
export async function stop(l: Lifx): Promise<boolean> {
  return serialize(async () => {
    if (!state) return false;
    if (beatTimer) clearTimeout(beatTimer);
    beatTimer = null;
    const snapshot = state.snapshot;
    state = null;
    await rm(STATE_FILE, { force: true }).catch(() => {});
    for (const [id, s] of Object.entries(snapshot)) {
      if (!s.power) {
        await l.setPower(id, false, RESTORE_MS).catch(() => {});
        await l.setColor(id, s, 0).catch(() => {}); // preset for the next manual on
      } else {
        await l.setColor(id, s, RESTORE_MS).catch(() => {});
      }
    }
    return true;
  });
}

// Called on worker startup: if a party was in progress, keep it going.
export async function resume(l: Lifx, excluded: (label: string) => boolean): Promise<void> {
  try {
    const saved = JSON.parse(await readFile(STATE_FILE, "utf8")) as PartyState;
    if (!saved?.options || !saved.snapshot) return;
    lifx = l;
    isExcluded = excluded;
    state = saved;
    beat();
    console.log("[party] resumed after restart");
  } catch {
    // no party in progress
  }
}
