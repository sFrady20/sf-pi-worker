// Taste config — the tunable layer. Persists to data/lighting.json; editable by
// hand or via the worker's /lighting/tune endpoint (which the agent can call).
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface Scene {
  name: "morning" | "day" | "evening" | "night";
  startHour: number; // local hour this scene begins
  authoritative: boolean; // may turn lights on/off + reclaim manual overrides at its start
  power: "on" | "off" | "leave";
  brightness: number; // 0-100 base target (before per-light scaling)
  kelvin: number; // white temperature when not in color mode
  color: boolean; // true = gentle hue drift; false = white at `kelvin`
}

export interface TasteConfig {
  enabled: boolean;
  timezone: string; // IANA, for hour-of-day
  pollSeconds: number;
  transitionMs: number; // how smoothly changes ease in
  driftEnabled: boolean;
  driftPeriodMinutes: number; // time to wander a full lap of hue
  saturation: number; // 0-100 for color mode
  defaultBrightnessScale: number; // global multiplier, 1 = as-scene
  avoidHueRanges: [number, number][]; // hues never used (default: red)
  perLight: Record<string, { brightnessScale?: number; exclude?: boolean }>;
  scenes: Scene[];
}

const FILE = process.env.LIGHTING_FILE ?? "./data/lighting.json";

export const defaultConfig: TasteConfig = {
  enabled: true,
  timezone: process.env.OWNER_TIMEZONE ?? "America/New_York",
  pollSeconds: 45,
  transitionMs: 2500,
  driftEnabled: true,
  driftPeriodMinutes: 30,
  saturation: 60,
  defaultBrightnessScale: 1,
  avoidHueRanges: [
    [345, 360],
    [0, 15],
  ], // no red
  perLight: {},
  scenes: [
    { name: "morning", startHour: 7, authoritative: true, power: "on", brightness: 80, kelvin: 3200, color: false },
    { name: "day", startHour: 10, authoritative: false, power: "leave", brightness: 90, kelvin: 4500, color: true },
    { name: "evening", startHour: 18, authoritative: true, power: "on", brightness: 55, kelvin: 2700, color: true },
    { name: "night", startHour: 22, authoritative: true, power: "off", brightness: 15, kelvin: 2500, color: false },
  ],
};

export async function loadConfig(): Promise<TasteConfig> {
  try {
    const raw = JSON.parse(await readFile(FILE, "utf8")) as Partial<TasteConfig>;
    return {
      ...defaultConfig,
      ...raw,
      perLight: raw.perLight ?? {},
      scenes: raw.scenes ?? defaultConfig.scenes,
      avoidHueRanges: raw.avoidHueRanges ?? defaultConfig.avoidHueRanges,
    };
  } catch {
    return structuredClone(defaultConfig);
  }
}

export async function saveConfig(cfg: TasteConfig): Promise<void> {
  await mkdir(dirname(FILE), { recursive: true });
  await writeFile(FILE, JSON.stringify(cfg, null, 2));
}
