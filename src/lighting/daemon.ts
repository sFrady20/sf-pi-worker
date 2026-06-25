// Cooperative ambient-lighting loop.
//
// Two sources of truth, in priority order:
//   1. heldTheme  — an explicit look set by the agent ("a calming coding theme"),
//                   or a named scene applied on demand. It HOLDS (no revert) until
//                   cleared (resumeAuto), a manual physical override, or the next
//                   authoritative time-scene boundary.
//   2. the time-of-day scene — the autonomous default when nothing is held.
//
// It only drives bulbs it "owns": change one by hand and it backs off until an
// authoritative scene reclaims it. Color-first; white only when a look asks for it.
import { type Color, loadConfig, type Look, type Scene, saveConfig, type TasteConfig } from "./config.js";
import { Lifx, type LightState } from "./lifx.js";

const RED: [number, number][] = [
  [345, 360],
  [0, 15],
];

let lifx: Lifx | null = null;
let config: TasteConfig = await loadConfig();
let heldTheme: Look | null = null;
let currentScene: string | null = null;
const ownership = new Map<string, { commanded: LightState | null; owned: boolean }>();

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));
const wrapHue = (h: number) => ((h % 360) + 360) % 360;
const circDelta = (a: number, b: number) => ((b - a + 540) % 360) - 180;

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

function lookOf(scene: Scene): Look {
  return { color: scene.color, palette: scene.palette, kelvin: scene.kelvin, brightness: scene.brightness, drift: scene.drift };
}

// The target color for one bulb, given the active look. Bulbs are spread across
// the palette and (if drift) cycle through it over driftPeriodMinutes.
function targetFor(look: Look, index: number): LightState {
  if (!look.color || look.palette.length === 0) {
    return { power: true, hue: 0, saturation: 0, brightness: look.brightness, kelvin: look.kelvin };
  }
  const n = look.palette.length;
  const period = Math.max(1, config.driftPeriodMinutes) * 60_000;
  const t = look.drift ? (Date.now() % period) / period : 0;
  const pos = ((t + index / n) % 1) * n;
  const i = Math.floor(pos) % n;
  const a = look.palette[i];
  const b = look.palette[(i + 1) % n];
  const f = pos - Math.floor(pos);
  const hue = nudgeToAllowed(wrapHue(a.hue + circDelta(a.hue, b.hue) * f), config.avoidHueRanges);
  const saturation = a.saturation + (b.saturation - a.saturation) * f;
  return { power: true, hue, saturation, brightness: look.brightness, kelvin: look.kelvin };
}

function matches(a: LightState, b: LightState): boolean {
  if (a.power !== b.power) return false;
  if (Math.abs(a.brightness - b.brightness) > 6) return false;
  if (a.saturation > 5 && Math.abs(circDelta(a.hue, b.hue)) > 12) return false;
  return true;
}

async function tick(): Promise<void> {
  if (!lifx || !config.enabled) return;
  const scene = sceneNow(config);
  const sceneChanged = scene.name !== currentScene;
  if (sceneChanged && scene.authoritative) heldTheme = null; // a real time-window takes over
  const look = heldTheme ?? lookOf(scene);

  let index = 0;
  for (const { id, label } of lifx.list()) {
    const per = config.perLight[label] ?? {};
    if (per.exclude) {
      index++;
      continue;
    }
    const own = ownership.get(id) ?? { commanded: null, owned: true };
    let state: LightState;
    try {
      state = await lifx.getState(id);
    } catch {
      index++;
      continue;
    }

    if (own.commanded && !matches(state, own.commanded)) own.owned = false; // manual override

    if (sceneChanged && scene.authoritative) {
      own.owned = true;
      if (scene.power === "off" && state.power) {
        await lifx.setPower(id, false, config.transitionMs).catch(() => {});
        ownership.set(id, { commanded: { ...state, power: false }, owned: true });
        index++;
        continue;
      }
      if (scene.power === "on" && !state.power) {
        await lifx.setPower(id, true, config.transitionMs).catch(() => {});
        state.power = true;
      }
    }

    if (!own.owned || !state.power) {
      ownership.set(id, own);
      index++;
      continue;
    }

    const scale = (per.brightnessScale ?? 1) * config.defaultBrightnessScale;
    const base = targetFor(look, index);
    const target: LightState = { ...base, brightness: Math.round(clamp(base.brightness * scale, 1, 100)) };
    if (!own.commanded || !matches(target, own.commanded) || look.drift) {
      try {
        await lifx.setColor(id, target, config.transitionMs);
        own.commanded = target;
      } catch (e) {
        console.warn("[lighting] setColor failed:", (e as Error).message);
      }
    }
    ownership.set(id, own);
    index++;
  }
  currentScene = scene.name;
}

export async function startLighting(): Promise<void> {
  config = await loadConfig();
  lifx = new Lifx();
  lifx.start();
  await sleep(4000); // let LAN discovery settle
  await tick();
  setInterval(() => void tick(), config.pollSeconds * 1000);
  console.log("[lighting] started");
}

export function status(): unknown {
  return {
    enabled: config.enabled,
    held: heldTheme ? "custom theme" : null,
    scene: currentScene,
    lights: lifx?.list().map((l) => ({ ...l, owned: ownership.get(l.id)?.owned ?? true })) ?? [],
    taste: config,
  };
}

export async function setEnabled(enabled: boolean): Promise<void> {
  config.enabled = enabled;
  await saveConfig(config);
  if (enabled) await tick();
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

export interface ThemeInput {
  palette?: Color[];
  brightness?: number;
  drift?: boolean;
  white?: boolean;
  kelvin?: number;
}

// Hold an explicit look (designed by the agent or from a named scene). Turns the
// lights on so it's visible, and keeps it until cleared / overridden by hand.
export async function setTheme(input: ThemeInput): Promise<void> {
  heldTheme = {
    color: !input.white,
    palette: input.palette ?? [],
    kelvin: input.kelvin ?? 2700,
    brightness: input.brightness ?? 45,
    drift: input.drift ?? true,
  };
  // Align with the clock so this tick isn't seen as a scene boundary — otherwise
  // an authoritative scene would immediately clear the theme we just set.
  currentScene = sceneNow(config).name;
  await setAllPower(true);
  await tick();
}

export async function applyScene(name: Scene["name"]): Promise<void> {
  const scene = config.scenes.find((s) => s.name === name);
  if (scene) await setTheme(lookOf(scene));
}

export interface SceneLookInput extends ThemeInput {
  scene: Scene["name"];
}

// Redefine what a scheduled scene looks like (the "auto" theme for that window),
// persisted to the taste config so it sticks going forward.
export async function setSceneLook(input: SceneLookInput): Promise<void> {
  const scene = config.scenes.find((s) => s.name === input.scene);
  if (!scene) return;
  if (input.palette) scene.palette = input.palette;
  if (input.brightness !== undefined) scene.brightness = input.brightness;
  if (input.white !== undefined) scene.color = !input.white;
  if (input.kelvin !== undefined) scene.kelvin = input.kelvin;
  if (input.drift !== undefined) scene.drift = input.drift;
  await saveConfig(config);
  if (!heldTheme && currentScene === input.scene) {
    currentScene = null; // re-apply the updated look now
    await tick();
  }
}

export async function resumeAuto(): Promise<void> {
  heldTheme = null;
  currentScene = null; // re-evaluate the time scene next tick
  await tick();
}

export async function flash(times = 2): Promise<void> {
  if (!lifx) return;
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
  if (patch.avoidRed !== undefined) {
    const hasRed = config.avoidHueRanges.some(([a]) => a === RED[0][0]);
    if (patch.avoidRed && !hasRed) config.avoidHueRanges.push(...RED);
    if (!patch.avoidRed) config.avoidHueRanges = config.avoidHueRanges.filter(([a]) => a !== RED[0][0] && a !== RED[1][0]);
  }
  await saveConfig(config);
  return config;
}
