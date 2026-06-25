// Taste config — the tunable layer. Persists to data/lighting.json; editable by
// hand or via the worker's /lighting/tune endpoint (which the agent can call).
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface Color {
  hue: number; // 0-360
  saturation: number; // 0-100
}

// A "look" the daemon can hold: a color palette (the default), or warm white.
export interface Look {
  color: boolean; // true = use palette + drift; false = white at kelvin
  palette: Color[];
  kelvin: number;
  brightness: number; // 0-100 base (before per-light scaling)
  drift: boolean; // slowly cycle through the palette over time
}

export interface Scene extends Look {
  name: "morning" | "day" | "evening" | "night";
  startHour: number; // local hour this scene begins
  authoritative: boolean; // may turn lights on/off + reclaim manual overrides at its start
  power: "on" | "off" | "leave";
}

export interface TasteConfig {
  enabled: boolean;
  timezone: string; // IANA, for hour-of-day
  pollSeconds: number;
  transitionMs: number;
  driftPeriodMinutes: number; // time to cycle the palette once
  defaultBrightnessScale: number; // global multiplier, 1 = as-look
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
  driftPeriodMinutes: 30,
  defaultBrightnessScale: 1,
  avoidHueRanges: [
    [345, 360],
    [0, 15],
  ], // no red
  perLight: {},
  scenes: [
    // Color-first. Night is a dim calming indigo, NOT off.
    {
      name: "morning",
      startHour: 7,
      authoritative: true,
      power: "on",
      color: true,
      brightness: 75,
      kelvin: 3200,
      drift: true,
      palette: [
        { hue: 35, saturation: 55 },
        { hue: 45, saturation: 50 },
        { hue: 20, saturation: 60 },
      ],
    },
    {
      name: "day",
      startHour: 10,
      authoritative: false,
      power: "leave",
      color: true,
      brightness: 90,
      kelvin: 4500,
      drift: true,
      palette: [
        { hue: 200, saturation: 55 },
        { hue: 235, saturation: 50 },
        { hue: 170, saturation: 55 },
        { hue: 280, saturation: 45 },
      ],
    },
    {
      name: "evening",
      startHour: 18,
      authoritative: true,
      power: "on",
      color: true,
      brightness: 45,
      kelvin: 2700,
      drift: true,
      palette: [
        { hue: 30, saturation: 70 },
        { hue: 285, saturation: 55 },
        { hue: 20, saturation: 65 },
      ],
    },
    {
      name: "night",
      startHour: 22,
      authoritative: true,
      power: "on",
      color: true,
      brightness: 18,
      kelvin: 2500,
      drift: true,
      palette: [
        { hue: 250, saturation: 60 },
        { hue: 270, saturation: 55 },
        { hue: 225, saturation: 60 },
      ],
    },
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
