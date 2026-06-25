// The cooperative ambient-lighting loop. It only ever drives bulbs it "owns";
// a manual change releases that bulb until the next authoritative scene change.
import { loadConfig, saveConfig, type Scene, type TasteConfig } from "./config.js";
import { Lifx, type LightState } from "./lifx.js";

const RED = [
  [345, 360],
  [0, 15],
] as [number, number][];

let lifx: Lifx | null = null;
let config: TasteConfig = await loadConfig();
let currentScene: string | null = null;
let loop: ReturnType<typeof setInterval> | null = null;
const ownership = new Map<string, { commanded: LightState | null; owned: boolean }>();

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));
const wrapHue = (h: number) => ((h % 360) + 360) % 360;

function hourInTz(tz: string): number {
  const v = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", hour12: false })
    .formatToParts(new Date())
    .find((p) => p.type === "hour")?.value;
  return Number.parseInt(v ?? "0", 10) % 24;
}

function hueAllowed(h: number, ranges: [number, number][]): boolean {
  return !ranges.some(([a, b]) => h >= a && h <= b);
}
function nudgeToAllowed(h: number, ranges: [number, number][]): number {
  let hue = wrapHue(h);
  for (let i = 0; i < 72 && !hueAllowed(hue, ranges); i++) hue = wrapHue(hue + 5);
  return hue;
}

function sceneNow(cfg: TasteConfig): Scene {
  const hour = hourInTz(cfg.timezone);
  const sorted = [...cfg.scenes].sort((a, b) => a.startHour - b.startHour);
  let pick = sorted[sorted.length - 1]; // before the first start → previous day's last scene
  for (const s of sorted) if (s.startHour <= hour) pick = s;
  return pick;
}

// "Close enough" that we still consider the bulb under our control.
function matches(a: LightState, b: LightState): boolean {
  if (a.power !== b.power) return false;
  if (Math.abs(a.brightness - b.brightness) > 6) return false;
  if (a.saturation > 5 && Math.abs(wrapHue(a.hue - b.hue)) > 12 && Math.abs(wrapHue(b.hue - a.hue)) > 12) {
    return false;
  }
  return true;
}

async function tick(): Promise<void> {
  if (!lifx || !config.enabled) return;
  const scene = sceneNow(config);
  const sceneChanged = scene.name !== currentScene;
  const step = (360 * config.pollSeconds) / (config.driftPeriodMinutes * 60); // degrees per tick

  for (const { id, label } of lifx.list()) {
    const per = config.perLight[label] ?? {};
    if (per.exclude) continue;
    const own = ownership.get(id) ?? { commanded: null, owned: true };

    let state: LightState;
    try {
      state = await lifx.getState(id);
    } catch {
      continue;
    }

    // Manual override? If reality drifted from what we last set, hands off.
    if (own.commanded && !matches(state, own.commanded)) own.owned = false;

    // Authoritative scene boundary: reclaim and set power.
    if (sceneChanged && scene.authoritative) {
      own.owned = true;
      if (scene.power === "off" && state.power) {
        await lifx.setPower(id, false, config.transitionMs);
        ownership.set(id, { commanded: { ...state, power: false }, owned: true });
        continue;
      }
      if (scene.power === "on" && !state.power) {
        await lifx.setPower(id, true, config.transitionMs);
        state.power = true;
      }
    }

    // Cooperative: never touch released bulbs or ones that are off.
    if (!own.owned || !state.power) {
      ownership.set(id, own);
      continue;
    }

    const scale = (per.brightnessScale ?? 1) * config.defaultBrightnessScale;
    const brightness = Math.round(clamp(scene.brightness * scale, 1, 100));
    const target: LightState = scene.color
      ? {
          power: true,
          hue: nudgeToAllowed((own.commanded?.hue ?? scene.startHour * 20) + step, config.avoidHueRanges),
          saturation: config.saturation,
          brightness,
          kelvin: scene.kelvin,
        }
      : { power: true, hue: 0, saturation: 0, brightness, kelvin: scene.kelvin };

    if (!own.commanded || !matches(target, own.commanded) || scene.color) {
      await lifx.setColor(id, target, config.transitionMs);
      own.commanded = target;
    }
    ownership.set(id, own);
  }
  currentScene = scene.name;
}

export async function startLighting(): Promise<void> {
  config = await loadConfig();
  lifx = new Lifx();
  lifx.start();
  await sleep(4000); // let LAN discovery settle
  await tick();
  loop = setInterval(() => void tick(), config.pollSeconds * 1000);
  console.log("[lighting] started");
}

export function status(): unknown {
  return {
    enabled: config.enabled,
    scene: currentScene,
    lights: lifx?.list().map((l) => ({ ...l, owned: ownership.get(l.id)?.owned ?? true })) ?? [],
    taste: config,
  };
}

export async function setEnabled(enabled: boolean): Promise<void> {
  config.enabled = enabled;
  await saveConfig(config);
}

export async function applyScene(name: Scene["name"]): Promise<void> {
  currentScene = null; // force an authoritative boundary on the next tick
  const scene = config.scenes.find((s) => s.name === name);
  if (scene) scene.authoritative = true;
  await tick();
}

export async function setAllPower(on: boolean): Promise<void> {
  if (!lifx) return;
  for (const { id } of lifx.list()) {
    try {
      await lifx.setPower(id, on, config.transitionMs);
      const o = ownership.get(id) ?? { commanded: null, owned: true };
      o.owned = true;
      if (o.commanded) o.commanded.power = on;
      ownership.set(id, o);
    } catch {
      /* skip */
    }
  }
}

export async function flash(times = 2): Promise<void> {
  if (!lifx) return;
  // Notification pulse. Uses a non-red hue to respect taste.
  const pulse = { hue: 210, saturation: 80, brightness: 100, kelvin: 3500 };
  for (const { id } of lifx.list()) {
    const before = await lifx.getState(id).catch(() => null);
    for (let i = 0; i < times; i++) {
      await lifx.setColor(id, pulse, 200).catch(() => {});
      await sleep(350);
      if (before) await lifx.setColor(id, before, 200).catch(() => {});
      await sleep(250);
    }
  }
}

export interface TastePatch {
  light?: string;
  brightnessScale?: number;
  exclude?: boolean;
  avoidRed?: boolean;
  driftEnabled?: boolean;
}

export async function tune(patch: TastePatch): Promise<TasteConfig> {
  if (patch.light) {
    const cur = config.perLight[patch.light] ?? {};
    if (patch.brightnessScale !== undefined) cur.brightnessScale = patch.brightnessScale;
    if (patch.exclude !== undefined) cur.exclude = patch.exclude;
    config.perLight[patch.light] = cur;
  } else if (patch.brightnessScale !== undefined) {
    config.defaultBrightnessScale = patch.brightnessScale;
  }
  if (patch.driftEnabled !== undefined) config.driftEnabled = patch.driftEnabled;
  if (patch.avoidRed !== undefined) {
    const hasRed = config.avoidHueRanges.some(([a]) => a === RED[0][0]);
    if (patch.avoidRed && !hasRed) config.avoidHueRanges.push(...RED);
    if (!patch.avoidRed) config.avoidHueRanges = config.avoidHueRanges.filter(([a]) => a !== RED[0][0] && a !== RED[1][0]);
  }
  await saveConfig(config);
  return config;
}
