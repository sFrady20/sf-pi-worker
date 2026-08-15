// Party mode — a fast color loop across ALL lights, with occasional white
// flashes. Unlike the cooperative daemon it ignores ownership and taste hue
// limits: every non-excluded bulb joins. It snapshots each light first and
// restores that exact state on stop; the snapshot persists to disk so a worker
// restart mid-party resumes the party instead of stranding the lights.
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Color } from "./config.js";
import type { Lifx, LightState } from "./lifx.js";

export interface PartyInput {
  intensity?: number; // 1 chill … 10 rave (default 5)
  palette?: Color[] | null; // omit = preserve when retuning; null/empty = full spectrum
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
  restoring?: boolean;
}

const STATE_FILE = process.env.PARTY_STATE_FILE ?? "./data/party-state.json";
const RESTORE_MS = 1500;
const RESTORE_RETRY_MS = 30_000;
const FLASH_MS = 120;

let lifx: Lifx | null = null;
let isExcluded: (label: string) => boolean = () => false;
let state: PartyState | null = null;
let beatTimer: ReturnType<typeof setTimeout> | null = null;
let restoreTimer: ReturnType<typeof setTimeout> | null = null;
const inFlight = new Set<Promise<void>>();
let restoredListener: () => void = () => {};

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

function boundedNumber(value: unknown, low: number, high: number): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= low && value <= high;
}

function parseState(value: unknown): PartyState {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("party state must be an object");
  const raw = value as Record<string, unknown>;
  if (!raw.options || typeof raw.options !== "object" || Array.isArray(raw.options)) {
    throw new Error("party options are invalid");
  }
  const options = raw.options as Record<string, unknown>;
  if (!boundedNumber(options.intensity, 1, 10) || !Number.isInteger(options.intensity)) {
    throw new Error("party intensity is invalid");
  }
  if (!boundedNumber(options.brightness, 1, 100)) throw new Error("party brightness is invalid");
  let palette: Color[] | null = null;
  if (options.palette !== null) {
    if (!Array.isArray(options.palette) || options.palette.length === 0) throw new Error("party palette is invalid");
    palette = options.palette.map((entry, index) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        throw new Error(`party palette[${index}] is invalid`);
      }
      const color = entry as Record<string, unknown>;
      if (!boundedNumber(color.hue, 0, 360) || !boundedNumber(color.saturation, 0, 100)) {
        throw new Error(`party palette[${index}] is invalid`);
      }
      return { hue: color.hue, saturation: color.saturation };
    });
  }
  if (!raw.snapshot || typeof raw.snapshot !== "object" || Array.isArray(raw.snapshot)) {
    throw new Error("party snapshot is invalid");
  }
  const snapshot: Record<string, LightState> = {};
  for (const [id, entry] of Object.entries(raw.snapshot)) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error(`party snapshot ${id} is invalid`);
    const light = entry as Record<string, unknown>;
    if (
      typeof light.power !== "boolean" ||
      !boundedNumber(light.hue, 0, 360) ||
      !boundedNumber(light.saturation, 0, 100) ||
      !boundedNumber(light.brightness, 0, 100) ||
      !boundedNumber(light.kelvin, 1500, 9000)
    ) {
      throw new Error(`party snapshot ${id} is invalid`);
    }
    snapshot[id] = {
      power: light.power,
      hue: light.hue,
      saturation: light.saturation,
      brightness: light.brightness,
      kelvin: light.kelvin,
    };
  }
  if (raw.restoring !== undefined && typeof raw.restoring !== "boolean") {
    throw new Error("party restoring flag is invalid");
  }
  return {
    options: { intensity: options.intensity, palette, brightness: options.brightness },
    snapshot,
    restoring: raw.restoring === true,
  };
}

// Intensity maps: tempo 3000ms → 660ms, flash odds ~4% → 20% per light per beat.
const beatMs = (intensity: number) => Math.round(3000 - (intensity - 1) * 260);
const flashChance = (intensity: number) => 0.02 + (intensity / 10) * 0.18;

function normalize(input: PartyInput, previous?: PartyOptions): PartyOptions {
  return {
    intensity: clamp(Math.round(input.intensity ?? previous?.intensity ?? 5), 1, 10),
    palette:
      input.palette === undefined
        ? (previous?.palette ?? null)
        : input.palette && input.palette.length > 0
          ? input.palette
          : null,
    brightness: clamp(input.brightness ?? previous?.brightness ?? 80, 1, 100),
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
  beatTimer = null;
  if (!state || state.restoring || !lifx) return;
  const l = lifx;
  const o = state.options;
  const transition = Math.round(beatMs(o.intensity) * 0.55);
  // Only bulbs with a pre-party snapshot may participate, so every command has
  // a known state to restore even if discovery changes mid-party.
  for (const id of Object.keys(state.snapshot)) {
    try {
      const operation = (
        Math.random() < flashChance(o.intensity)
          ? flashLight(l, id, o)
          : l.setColor(
              id,
              { ...pickColor(o), brightness: Math.round(clamp(o.brightness + rand(-15, 10), 5, 100)), kelvin: 3500 },
              transition,
            )
      ).catch(() => {});
      inFlight.add(operation);
      void operation.finally(() => inFlight.delete(operation));
    } catch {
      // A client restart can invalidate a light handle between beats.
    }
  }
  beatTimer = setTimeout(beat, beatMs(o.intensity));
}

async function persist(): Promise<void> {
  if (!state) return;
  await mkdir(dirname(STATE_FILE), { recursive: true });
  const temporary = `${STATE_FILE}.tmp`;
  await writeFile(temporary, JSON.stringify(state));
  await rename(temporary, STATE_FILE);
}

export function isActive(): boolean {
  return state !== null;
}

export function setRestoredListener(listener: () => void): void {
  restoredListener = listener;
}

export function partyStatus(): { active: boolean; restoring: boolean } & Partial<PartyOptions> {
  return state
    ? { active: !state.restoring, restoring: state.restoring === true, ...state.options }
    : { active: false, restoring: false };
}

async function restorePending(l: Lifx): Promise<boolean> {
  if (!state?.restoring) return state === null;
  const remaining: Record<string, LightState> = {};
  await Promise.all(
    Object.entries(state.snapshot).map(async ([id, saved]) => {
      try {
        if (saved.power) {
          await l.setPower(id, true, RESTORE_MS);
          await l.setColor(id, saved, RESTORE_MS);
        } else {
          let failed = false;
          try {
            await l.setPower(id, false, RESTORE_MS);
          } catch (error) {
            failed = true;
            console.warn(`[party] power restore failed for ${id}:`, (error as Error).message);
          }
          try {
            await l.setColor(id, saved, 0);
          } catch (error) {
            failed = true;
            console.warn(`[party] color restore failed for ${id}:`, (error as Error).message);
          }
          if (failed) remaining[id] = saved;
        }
      } catch (error) {
        remaining[id] = saved;
        console.warn(`[party] restore failed for ${id}:`, (error as Error).message);
      }
    }),
  );
  if (Object.keys(remaining).length === 0) {
    // Keep the in-memory restoring state until the durable marker is gone. If
    // removal fails, a retry (or restart) can safely replay the exact restore.
    await rm(STATE_FILE, { force: true });
    if (restoreTimer) clearTimeout(restoreTimer);
    restoreTimer = null;
    state = null;
    try {
      restoredListener();
    } catch (error) {
      console.warn("[party] restored listener failed:", (error as Error).message);
    }
    return true;
  }
  state.snapshot = remaining;
  await persist();
  return false;
}

function scheduleRestore(l: Lifx): void {
  if (restoreTimer || !state?.restoring) return;
  restoreTimer = setTimeout(() => {
    restoreTimer = null;
    void serialize(async () => {
      if (!state?.restoring) return;
      if (!(await restorePending(l))) scheduleRestore(l);
    }).catch((error) => {
      console.warn("[party] restore retry failed:", (error as Error).message);
      scheduleRestore(l);
    });
  }, RESTORE_RETRY_MS);
}

// Start the party, or retune it (intensity/colors/brightness) if already going —
// the original snapshot is kept so stop still restores the true pre-party state.
export async function start(l: Lifx, input: PartyInput, excluded: (label: string) => boolean): Promise<void> {
  return serialize(async () => {
    lifx = l;
    isExcluded = excluded;
    if (state?.restoring) {
      try {
        if (!(await restorePending(l))) {
          scheduleRestore(l);
          throw new Error("party restoration is still pending for unreachable lights");
        }
      } catch (error) {
        if (state?.restoring) scheduleRestore(l);
        throw error;
      }
    }
    if (state) {
      const previous = state.options;
      state.options = normalize(input, previous);
      try {
        await persist();
      } catch (error) {
        state.options = previous;
        throw error;
      }
      return;
    }
    const snapshotEntries = await Promise.all(
      l.list().map(async ({ id, label }): Promise<[string, LightState] | null> => {
        if (excluded(label)) return null;
        try {
          return [id, await l.getState(id)];
        } catch {
          return null; // unreachable bulb — leave it out of the party
        }
      }),
    );
    const snapshot = Object.fromEntries(snapshotEntries.filter((entry) => entry !== null));
    state = { options: normalize(input), snapshot, restoring: false };
    try {
      await persist();
    } catch (error) {
      state = null;
      throw error;
    }
    await Promise.all(
      Object.keys(snapshot).map((id) =>
        l.setPower(id, true, 300).catch(() => {
          // The beat and eventual restore retain the snapshotted id for retry.
        }),
      ),
    );
    beat();
  });
}

// Stop and put every light back exactly as it was. Returns false if no party.
export async function stop(l: Lifx): Promise<boolean> {
  return serialize(async () => {
    if (!state) return false;
    if (!state.restoring) {
      state.restoring = true;
      try {
        await persist();
      } catch (error) {
        state.restoring = false;
        if (!beatTimer) beat();
        throw error;
      }
      if (beatTimer) clearTimeout(beatTimer);
      beatTimer = null;
      await Promise.allSettled([...inFlight]);
    }
    try {
      const complete = await restorePending(l);
      if (!complete) scheduleRestore(l);
      return complete;
    } catch (error) {
      if (state?.restoring) scheduleRestore(l);
      throw error;
    }
  });
}

// Called on worker startup: if a party was in progress, keep it going.
export async function resume(l: Lifx, excluded: (label: string) => boolean): Promise<void> {
  try {
    const saved = parseState(JSON.parse(await readFile(STATE_FILE, "utf8")) as unknown);
    lifx = l;
    isExcluded = excluded;
    state = saved;
    if (state.restoring) {
      const complete = await restorePending(l);
      if (!complete) scheduleRestore(l);
      console.log(complete ? "[party] restoration completed after restart" : "[party] restoration still pending");
    } else {
      beat();
      console.log("[party] resumed after restart");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    console.warn("[party] resume failed:", (error as Error).message);
    // A failed write while shrinking a restoration snapshot must not strand the
    // daemon forever. Keep retrying the remaining exact states in the background.
    if (state?.restoring) scheduleRestore(l);
  }
}
