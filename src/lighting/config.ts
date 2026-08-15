// Durable lighting configuration and the pure schedule resolver.
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface Color {
  hue: number;
  saturation: number;
}

export interface Look {
  color: boolean;
  palette: Color[];
  kelvin: number;
  brightness: number;
  drift: boolean;
}

export const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
export type Weekday = (typeof WEEKDAYS)[number];

export interface Scene extends Look {
  name: string;
  start: string;
  days: Weekday[];
  enabled: boolean;
  power: "on" | "off" | "leave";
  reclaim: boolean;
  interruptTheme: boolean;
}

export interface TasteConfig {
  enabled: boolean;
  timezone: string;
  pollSeconds: number;
  transitionMs: number;
  driftPeriodMinutes: number;
  defaultBrightnessScale: number;
  avoidHueRanges: [number, number][];
  perLight: Record<string, { brightnessScale?: number; exclude?: boolean }>;
  scenes: Scene[];
}

export interface ScheduleLookInput {
  colors?: Color[];
  white?: boolean;
  kelvin?: number;
  brightness?: number;
  drift?: boolean;
}

export interface ScheduleEntryInput {
  name: string;
  start?: string;
  days?: Weekday[];
  enabled?: boolean;
  power?: Scene["power"];
  reclaim?: boolean;
  interruptTheme?: boolean;
  look?: ScheduleLookInput;
}

export interface ScheduleUpdate {
  replace?: ScheduleEntryInput[];
  remove?: string[];
  upsert?: ScheduleEntryInput[];
}

export interface PerLightPatch {
  light: string;
  brightnessScale?: number | null;
  exclude?: boolean | null;
  remove?: boolean;
}

export interface ConfigPatch {
  enabled?: boolean;
  timezone?: string;
  pollSeconds?: number;
  transitionMs?: number;
  driftPeriodMinutes?: number;
  defaultBrightnessScale?: number;
  avoidHueRanges?: [number, number][];
  perLight?: PerLightPatch[];
}

export interface ActiveScene {
  scene: Scene;
  key: string;
  localDate: string;
}

export class LightingInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LightingInputError";
  }
}

const FILE = process.env.LIGHTING_FILE ?? "./data/lighting.json";
export interface ConfigLoadIssue {
  error: string;
  raw: unknown;
}
let loadIssue: ConfigLoadIssue | null = null;

export function configLoadIssue(): ConfigLoadIssue | null {
  return loadIssue ? clone(loadIssue) : null;
}

export function clearConfigLoadIssue(): void {
  loadIssue = null;
}

const ALL_DAYS = [...WEEKDAYS];
const NEW_SCENE_LOOK: Look = {
  color: true,
  palette: [{ hue: 210, saturation: 60 }],
  kelvin: 3000,
  brightness: 45,
  drift: true,
};

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
  ],
  perLight: {},
  scenes: [
    {
      name: "morning",
      start: "07:00",
      days: [...ALL_DAYS],
      enabled: true,
      reclaim: true,
      interruptTheme: true,
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
      start: "10:00",
      days: [...ALL_DAYS],
      enabled: true,
      reclaim: false,
      interruptTheme: false,
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
      start: "18:00",
      days: [...ALL_DAYS],
      enabled: true,
      reclaim: true,
      interruptTheme: true,
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
      start: "22:00",
      days: [...ALL_DAYS],
      enabled: true,
      reclaim: true,
      interruptTheme: true,
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

const clone = <T>(value: T): T => structuredClone(value);

function fail(message: string): never {
  throw new LightingInputError(message);
}

function boundedNumber(value: unknown, field: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
    fail(`${field} must be a number from ${min} to ${max}`);
  }
  return value;
}

function bool(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") fail(`${field} must be a boolean`);
  return value;
}

function validTimezone(timezone: unknown): string {
  if (typeof timezone !== "string" || !timezone.trim()) fail("timezone must be a non-empty IANA timezone");
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(new Date());
  } catch {
    fail(`invalid IANA timezone: ${timezone}`);
  }
  return timezone;
}

function timeMinutes(start: unknown, field = "start"): number {
  if (typeof start !== "string" || !/^\d{2}:\d{2}$/.test(start)) fail(`${field} must use HH:mm`);
  const [hour, minute] = start.split(":").map(Number);
  if (hour > 23 || minute > 59) fail(`${field} must be a valid local time`);
  return hour * 60 + minute;
}

function normalizeColor(value: unknown, field: string): Color {
  if (!value || typeof value !== "object") fail(`${field} must be a color`);
  const raw = value as Record<string, unknown>;
  return {
    hue: boundedNumber(raw.hue, `${field}.hue`, 0, 360),
    saturation: boundedNumber(raw.saturation, `${field}.saturation`, 0, 100),
  };
}

function normalizeDays(value: unknown, field: string): Weekday[] {
  if (!Array.isArray(value) || value.length === 0) fail(`${field} must contain at least one weekday`);
  const days = value.map((day) => {
    if (typeof day !== "string" || !(WEEKDAYS as readonly string[]).includes(day)) {
      fail(`${field} contains invalid weekday ${String(day)}`);
    }
    return day as Weekday;
  });
  return [...new Set(days)];
}

function applyLook(base: Look, input: ScheduleLookInput | undefined, field: string): Look {
  if (input === undefined) return clone(base);
  if (!input || typeof input !== "object") fail(`${field} must be an object`);
  const next = clone(base);
  if (input.colors !== undefined) {
    if (!Array.isArray(input.colors) || input.colors.length === 0) fail(`${field}.colors cannot be empty`);
    next.palette = input.colors.map((color, i) => normalizeColor(color, `${field}.colors[${i}]`));
    next.color = true;
  }
  if (input.white !== undefined) next.color = !bool(input.white, `${field}.white`);
  if (input.kelvin !== undefined) next.kelvin = boundedNumber(input.kelvin, `${field}.kelvin`, 1500, 9000);
  if (input.brightness !== undefined) {
    next.brightness = boundedNumber(input.brightness, `${field}.brightness`, 0, 100);
  }
  if (input.drift !== undefined) next.drift = bool(input.drift, `${field}.drift`);
  return next;
}

function createOrPatchScene(input: ScheduleEntryInput, existing?: Scene, field = "scene"): Scene {
  if (!input || typeof input !== "object") fail(`${field} must be an object`);
  if (typeof input.name !== "string" || !input.name.trim()) fail(`${field}.name is required`);
  const name = input.name.trim();
  if (!existing && input.start === undefined) fail(`${field}.start is required for a new entry`);

  const base: Scene = existing
    ? clone(existing)
    : {
        name,
        start: "00:00",
        days: [...ALL_DAYS],
        enabled: true,
        power: "leave",
        reclaim: false,
        interruptTheme: false,
        ...clone(NEW_SCENE_LOOK),
      };
  base.name = name;
  if (input.start !== undefined) {
    timeMinutes(input.start, `${field}.start`);
    base.start = input.start;
  }
  if (input.days !== undefined) base.days = normalizeDays(input.days, `${field}.days`);
  if (input.enabled !== undefined) base.enabled = bool(input.enabled, `${field}.enabled`);
  if (input.power !== undefined) {
    if (!(["on", "off", "leave"] as const).includes(input.power)) fail(`${field}.power is invalid`);
    base.power = input.power;
  }
  if (input.reclaim !== undefined) base.reclaim = bool(input.reclaim, `${field}.reclaim`);
  if (input.interruptTheme !== undefined) {
    base.interruptTheme = bool(input.interruptTheme, `${field}.interruptTheme`);
  }
  Object.assign(base, applyLook(base, input.look, `${field}.look`));
  return base;
}

function validateScenes(scenes: Scene[]): void {
  if (!Array.isArray(scenes)) fail("scenes must be an array");
  const names = new Set<string>();
  const starts = new Set<string>();
  for (const scene of scenes) {
    if (!scene || typeof scene !== "object") fail("every schedule entry must be an object");
    if (typeof scene.name !== "string" || !scene.name.trim()) fail("every schedule entry needs a name");
    const lower = scene.name.toLocaleLowerCase();
    if (names.has(lower)) fail(`schedule entry names must be unique: ${scene.name}`);
    names.add(lower);
    timeMinutes(scene.start, `${scene.name}.start`);
    normalizeDays(scene.days, `${scene.name}.days`);
    bool(scene.enabled, `${scene.name}.enabled`);
    if (!(scene.power === "on" || scene.power === "off" || scene.power === "leave")) {
      fail(`${scene.name}.power is invalid`);
    }
    bool(scene.reclaim, `${scene.name}.reclaim`);
    bool(scene.interruptTheme, `${scene.name}.interruptTheme`);
    bool(scene.color, `${scene.name}.color`);
    if (!Array.isArray(scene.palette)) fail(`${scene.name}.palette must be an array`);
    if (scene.color && scene.palette.length === 0) fail(`${scene.name}.palette cannot be empty for a color look`);
    scene.palette.forEach((color, index) => normalizeColor(color, `${scene.name}.palette[${index}]`));
    boundedNumber(scene.kelvin, `${scene.name}.kelvin`, 1500, 9000);
    boundedNumber(scene.brightness, `${scene.name}.brightness`, 0, 100);
    bool(scene.drift, `${scene.name}.drift`);
    if (!scene.enabled) continue;
    for (const day of scene.days) {
      const key = `${day}:${scene.start}`;
      if (starts.has(key)) fail(`enabled schedule entries overlap at ${day} ${scene.start}`);
      starts.add(key);
    }
  }
}

function validateConfig(config: TasteConfig): void {
  bool(config.enabled, "enabled");
  validTimezone(config.timezone);
  boundedNumber(config.pollSeconds, "pollSeconds", 1, 3600);
  boundedNumber(config.transitionMs, "transitionMs", 0, 300_000);
  boundedNumber(config.driftPeriodMinutes, "driftPeriodMinutes", 1, 1440);
  boundedNumber(config.defaultBrightnessScale, "defaultBrightnessScale", 0, 2);
  if (!Array.isArray(config.avoidHueRanges)) fail("avoidHueRanges must be an array");
  for (const [index, range] of config.avoidHueRanges.entries()) {
    if (!Array.isArray(range) || range.length !== 2) fail(`avoidHueRanges[${index}] must be [start,end]`);
    const start = boundedNumber(range[0], `avoidHueRanges[${index}][0]`, 0, 360);
    const end = boundedNumber(range[1], `avoidHueRanges[${index}][1]`, 0, 360);
    if (start > end) fail(`avoidHueRanges[${index}] start must not exceed end`);
  }
  for (const [light, value] of Object.entries(config.perLight)) {
    if (!value || typeof value !== "object") fail(`perLight.${light} must be an object`);
    if (value.brightnessScale !== undefined) {
      boundedNumber(value.brightnessScale, `perLight.${light}.brightnessScale`, 0, 2);
    }
    if (value.exclude !== undefined) bool(value.exclude, `perLight.${light}.exclude`);
  }
  validateScenes(config.scenes);
}

function normalizeLoadedScene(value: unknown, index: number): Scene {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(`scenes[${index}] must be an object`);
  }
  const raw = value as Record<string, unknown>;
  if (typeof raw.name !== "string" || !raw.name.trim()) {
    fail(`scenes[${index}].name must be a non-empty string`);
  }
  const namedDefault = defaultConfig.scenes.find((scene) => scene.name === raw.name);
  if (raw.start === undefined && raw.startHour === undefined && !namedDefault) {
    fail(`scenes[${index}].start is required for a custom entry`);
  }
  const fallback = namedDefault ?? {
    name: `scene-${index + 1}`,
    start: "00:00",
    days: [...ALL_DAYS],
    enabled: true,
    power: "leave" as const,
    reclaim: false,
    interruptTheme: false,
    ...NEW_SCENE_LOOK,
  };
  const field = `scenes[${index}]`;
  let legacyHour: number | null = null;
  if (raw.startHour !== undefined) {
    legacyHour = boundedNumber(raw.startHour, `${field}.startHour`, 0, 23);
    if (!Number.isInteger(legacyHour)) fail(`${field}.startHour must be an integer`);
  }
  let legacyMinute = 0;
  if (raw.startMinute !== undefined) {
    legacyMinute = boundedNumber(raw.startMinute, `${field}.startMinute`, 0, 59);
    if (!Number.isInteger(legacyMinute)) fail(`${field}.startMinute must be an integer`);
  }
  const start =
    raw.start === undefined
      ? legacyHour === null
        ? fallback.start
        : `${String(legacyHour).padStart(2, "0")}:${String(legacyMinute).padStart(2, "0")}`
      : raw.start;
  timeMinutes(start, `${field}.start`);
  const authoritative =
    raw.authoritative === undefined ? undefined : bool(raw.authoritative, `${field}.authoritative`);
  const name = raw.name;
  let power = fallback.power;
  if (raw.power !== undefined) {
    if (!(raw.power === "on" || raw.power === "off" || raw.power === "leave")) {
      fail(`${field}.power is invalid`);
    }
    power = raw.power;
  }
  let color = raw.color === undefined ? fallback.color : bool(raw.color, `${field}.color`);
  let palette = clone(fallback.palette);
  if (raw.palette !== undefined) {
    if (!Array.isArray(raw.palette)) fail(`${field}.palette must be an array`);
    palette = raw.palette.map((entry, colorIndex) => normalizeColor(entry, `${field}.palette[${colorIndex}]`));
    // The previous daemon interpreted color:true + an empty palette as white.
    // Preserve that durable state while normalizing it to the explicit model.
    if (color && palette.length === 0) color = false;
  }
  const scene: Scene = {
    name: name.trim(),
    start: start as string,
    days: raw.days === undefined ? [...ALL_DAYS] : normalizeDays(raw.days, `${field}.days`),
    enabled: raw.enabled === undefined ? fallback.enabled : bool(raw.enabled, `${field}.enabled`),
    power,
    reclaim: raw.reclaim === undefined ? (authoritative ?? fallback.reclaim) : bool(raw.reclaim, `${field}.reclaim`),
    interruptTheme:
      raw.interruptTheme === undefined
        ? (authoritative ?? fallback.interruptTheme)
        : bool(raw.interruptTheme, `${field}.interruptTheme`),
    color,
    palette,
    kelvin:
      raw.kelvin === undefined ? fallback.kelvin : boundedNumber(raw.kelvin, `${field}.kelvin`, 1500, 9000),
    brightness:
      raw.brightness === undefined
        ? fallback.brightness
        : boundedNumber(raw.brightness, `${field}.brightness`, 0, 100),
    drift: raw.drift === undefined ? fallback.drift : bool(raw.drift, `${field}.drift`),
  };
  return scene;
}

export function applyConfigPatch(config: TasteConfig, patch: ConfigPatch): TasteConfig {
  if (!patch || typeof patch !== "object") fail("config patch must be an object");
  const next = clone(config);
  if (patch.enabled !== undefined) next.enabled = bool(patch.enabled, "enabled");
  if (patch.timezone !== undefined) next.timezone = validTimezone(patch.timezone);
  if (patch.pollSeconds !== undefined) next.pollSeconds = boundedNumber(patch.pollSeconds, "pollSeconds", 1, 3600);
  if (patch.transitionMs !== undefined) next.transitionMs = boundedNumber(patch.transitionMs, "transitionMs", 0, 300_000);
  if (patch.driftPeriodMinutes !== undefined) {
    next.driftPeriodMinutes = boundedNumber(patch.driftPeriodMinutes, "driftPeriodMinutes", 1, 1440);
  }
  if (patch.defaultBrightnessScale !== undefined) {
    next.defaultBrightnessScale = boundedNumber(patch.defaultBrightnessScale, "defaultBrightnessScale", 0, 2);
  }
  if (patch.avoidHueRanges !== undefined) {
    if (!Array.isArray(patch.avoidHueRanges)) fail("avoidHueRanges must be an array");
    next.avoidHueRanges = patch.avoidHueRanges.map((range, i) => {
      if (!Array.isArray(range) || range.length !== 2) fail(`avoidHueRanges[${i}] must be [start,end]`);
      const start = boundedNumber(range[0], `avoidHueRanges[${i}][0]`, 0, 360);
      const end = boundedNumber(range[1], `avoidHueRanges[${i}][1]`, 0, 360);
      if (start > end) fail(`avoidHueRanges[${i}] start must not exceed end`);
      return [start, end];
    });
  }
  if (patch.perLight !== undefined) {
    if (!Array.isArray(patch.perLight)) fail("perLight must be an array");
    for (const [index, update] of patch.perLight.entries()) {
      if (!update || typeof update !== "object" || typeof update.light !== "string" || !update.light.trim()) {
        fail(`perLight[${index}].light is required`);
      }
      const light = update.light.trim();
      if (update.remove) {
        delete next.perLight[light];
        continue;
      }
      const current = { ...(next.perLight[light] ?? {}) };
      if (update.brightnessScale === null) delete current.brightnessScale;
      else if (update.brightnessScale !== undefined) {
        current.brightnessScale = boundedNumber(update.brightnessScale, `perLight[${index}].brightnessScale`, 0, 2);
      }
      if (update.exclude === null) delete current.exclude;
      else if (update.exclude !== undefined) current.exclude = bool(update.exclude, `perLight[${index}].exclude`);
      if (Object.keys(current).length === 0) delete next.perLight[light];
      else next.perLight[light] = current;
    }
  }
  validateConfig(next);
  return next;
}

export function updateSchedule(config: TasteConfig, input: ScheduleUpdate): TasteConfig {
  if (!input || typeof input !== "object") fail("schedule update must be an object");
  let scenes = clone(config.scenes);
  if (input.replace !== undefined) {
    if (!Array.isArray(input.replace)) fail("replace must be an array");
    scenes = input.replace.map((entry, index) => createOrPatchScene(entry, undefined, `replace[${index}]`));
  }
  if (input.remove !== undefined) {
    if (!Array.isArray(input.remove) || input.remove.some((name) => typeof name !== "string")) {
      fail("remove must be an array of names");
    }
    const removed = new Set(input.remove.map((name) => name.toLocaleLowerCase()));
    scenes = scenes.filter((scene) => !removed.has(scene.name.toLocaleLowerCase()));
  }
  if (input.upsert !== undefined) {
    if (!Array.isArray(input.upsert)) fail("upsert must be an array");
    input.upsert.forEach((entry, index) => {
      if (!entry || typeof entry.name !== "string") fail(`upsert[${index}].name is required`);
      const at = scenes.findIndex((scene) => scene.name.toLocaleLowerCase() === entry.name.trim().toLocaleLowerCase());
      const next = createOrPatchScene(entry, at >= 0 ? scenes[at] : undefined, `upsert[${index}]`);
      if (at >= 0) scenes[at] = next;
      else scenes.push(next);
    });
  }
  validateScenes(scenes);
  return { ...clone(config), scenes };
}

function localParts(timezone: string, now: Date): { weekday: Weekday; minutes: number; date: string } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      weekday: "short",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(now)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
  const weekday = parts.weekday.toLocaleLowerCase().slice(0, 3) as Weekday;
  return {
    weekday,
    minutes: Number(parts.hour) * 60 + Number(parts.minute),
    date: `${parts.year}-${parts.month}-${parts.day}`,
  };
}

function subtractLocalDays(date: string, days: number): string {
  const [year, month, day] = date.split("-").map(Number);
  const shifted = new Date(Date.UTC(year, month - 1, day - days));
  return shifted.toISOString().slice(0, 10);
}

export function resolveActiveScene(config: TasteConfig, now = new Date()): ActiveScene | null {
  validTimezone(config.timezone);
  const local = localParts(config.timezone, now);
  const today = WEEKDAYS.indexOf(local.weekday);
  // Include seven days back so a once-weekly entry remains active before its
  // next occurrence on the same weekday.
  for (let ago = 0; ago <= 7; ago++) {
    const weekday = WEEKDAYS[(today - ago + 7) % 7];
    const candidates = config.scenes
      .filter((scene) => scene.enabled && scene.days.includes(weekday))
      .filter((scene) => ago > 0 || timeMinutes(scene.start) <= local.minutes)
      .sort((a, b) => timeMinutes(b.start) - timeMinutes(a.start));
    const scene = candidates[0];
    if (scene) {
      const localDate = subtractLocalDays(local.date, ago);
      return { scene, localDate, key: `${scene.name}@${localDate}T${scene.start}` };
    }
  }
  return null;
}

export function normalizeConfig(value: unknown): TasteConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("lighting config must be an object");
  const raw = value as Record<string, unknown>;
  let scenes = clone(defaultConfig.scenes);
  if (raw.scenes !== undefined) {
    if (!Array.isArray(raw.scenes)) fail("scenes must be an array");
    scenes = raw.scenes.map((scene, index) => normalizeLoadedScene(scene, index));
  }
  if (raw.avoidHueRanges !== undefined && !Array.isArray(raw.avoidHueRanges)) {
    fail("avoidHueRanges must be an array");
  }
  if (
    raw.perLight !== undefined &&
    (!raw.perLight || typeof raw.perLight !== "object" || Array.isArray(raw.perLight))
  ) {
    fail("perLight must be an object");
  }
  const loaded: TasteConfig = {
    enabled: raw.enabled === undefined ? defaultConfig.enabled : bool(raw.enabled, "enabled"),
    timezone: raw.timezone === undefined ? defaultConfig.timezone : validTimezone(raw.timezone),
    pollSeconds:
      raw.pollSeconds === undefined
        ? defaultConfig.pollSeconds
        : boundedNumber(raw.pollSeconds, "pollSeconds", 1, 3600),
    transitionMs:
      raw.transitionMs === undefined
        ? defaultConfig.transitionMs
        : boundedNumber(raw.transitionMs, "transitionMs", 0, 300_000),
    driftPeriodMinutes:
      raw.driftPeriodMinutes === undefined
        ? defaultConfig.driftPeriodMinutes
        : boundedNumber(raw.driftPeriodMinutes, "driftPeriodMinutes", 1, 1440),
    defaultBrightnessScale:
      raw.defaultBrightnessScale === undefined
        ? defaultConfig.defaultBrightnessScale
        : boundedNumber(raw.defaultBrightnessScale, "defaultBrightnessScale", 0, 2),
    avoidHueRanges:
      raw.avoidHueRanges === undefined
        ? clone(defaultConfig.avoidHueRanges)
        : clone(raw.avoidHueRanges as [number, number][]),
    perLight:
      raw.perLight === undefined ? {} : clone(raw.perLight as TasteConfig["perLight"]),
    scenes,
  };
  validateConfig(loaded);
  return loaded;
}

function disabledDefaultConfig(): TasteConfig {
  const fallback = { ...clone(defaultConfig), enabled: false };
  try {
    validTimezone(fallback.timezone);
  } catch {
    fallback.timezone = "UTC";
  }
  return fallback;
}

export async function loadConfig(): Promise<TasteConfig> {
  let recoveryRaw: unknown = null;
  try {
    const source = await readFile(FILE, "utf8");
    try {
      recoveryRaw = JSON.parse(source) as unknown;
    } catch (error) {
      recoveryRaw = source.slice(0, 4000);
      throw error;
    }
    const loaded = normalizeConfig(recoveryRaw);
    loadIssue = null;
    return loaded;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      const defaults = clone(defaultConfig);
      try {
        validateConfig(defaults);
        loadIssue = null;
        return defaults;
      } catch (defaultError) {
        const message = `invalid lighting defaults/environment: ${(defaultError as Error).message}`;
        console.warn("[lighting]", message);
        loadIssue = { error: message, raw: { OWNER_TIMEZONE: process.env.OWNER_TIMEZONE } };
        return disabledDefaultConfig();
      }
    }
    console.warn("[lighting] invalid config; automatic lighting is disabled:", (error as Error).message);
    loadIssue = { error: (error as Error).message, raw: recoveryRaw };
    return disabledDefaultConfig();
  }
}

export async function saveConfig(config: TasteConfig): Promise<void> {
  await mkdir(dirname(FILE), { recursive: true });
  const temporary = `${FILE}.tmp`;
  await writeFile(temporary, JSON.stringify(config, null, 2));
  await rename(temporary, FILE);
}
