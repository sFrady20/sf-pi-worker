// Cooperative ambient lighting: party > held/direct control > automatic schedule.
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  applyConfigPatch,
  clearConfigLoadIssue,
  type Color,
  type ConfigPatch,
  configLoadIssue,
  LightingInputError,
  loadConfig,
  type Look,
  resolveActiveScene,
  saveConfig,
  type Scene,
  type ScheduleUpdate,
  type TasteConfig,
  updateSchedule,
} from "./config.js";
import { Lifx, type LightState } from "./lifx.js";
import * as party from "./party.js";

export { LightingInputError } from "./config.js";
export type { ConfigPatch, ScheduleUpdate } from "./config.js";
export type { PartyInput } from "./party.js";

const RED: [number, number][] = [
  [345, 360],
  [0, 15],
];

let lifx: Lifx | null = null;
let config: TasteConfig = await loadConfig();
let heldTheme: Look | null = null;
let currentSceneKey: string | null = null;
let stateIssue: string | null = null;
let pollTimer: ReturnType<typeof setTimeout> | null = null;
let pollGeneration = 0;
let quietAfterPartyRestore = false;
const ownership = new Map<string, { commanded: LightState | null; owned: boolean; settleUntil?: number }>();

const STATE_FILE = process.env.LIGHTING_STATE_FILE ?? "./data/lighting-state.json";
interface PersistedState {
  heldTheme: Look | null;
  currentSceneKey?: string | null;
  currentScene?: string | null; // legacy state used the scene name only
  unowned: string[];
  recoveryPaused?: boolean;
}
let lastSavedState = "";
let stateRetryTimer: ReturnType<typeof setTimeout> | null = null;

function boundedStoredNumber(value: unknown, min: number, max: number): boolean {
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
}

function validStoredLook(value: unknown): value is Look {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const look = value as Record<string, unknown>;
  if (typeof look.color !== "boolean" || !Array.isArray(look.palette)) return false;
  if (
    !look.palette.every(
      (entry) =>
        !!entry &&
        typeof entry === "object" &&
        !Array.isArray(entry) &&
        boundedStoredNumber((entry as Record<string, unknown>).hue, 0, 360) &&
        boundedStoredNumber((entry as Record<string, unknown>).saturation, 0, 100),
    )
  ) {
    return false;
  }
  return (
    boundedStoredNumber(look.kelvin, 1500, 9000) &&
    boundedStoredNumber(look.brightness, 0, 100) &&
    typeof look.drift === "boolean"
  );
}

async function saveState(required = false): Promise<void> {
  const state: PersistedState = {
    heldTheme,
    currentSceneKey,
    unowned: [...ownership.entries()].filter(([, value]) => !value.owned).map(([id]) => id),
    recoveryPaused: stateIssue !== null,
  };
  const json = JSON.stringify(state);
  if (json === lastSavedState) return;
  try {
    await mkdir(dirname(STATE_FILE), { recursive: true });
    const temporary = `${STATE_FILE}.tmp`;
    await writeFile(temporary, json);
    await rename(temporary, STATE_FILE);
    lastSavedState = json;
    if (stateRetryTimer) clearTimeout(stateRetryTimer);
    stateRetryTimer = null;
  } catch (error) {
    const message = `lighting state save failed: ${(error as Error).message}`;
    console.warn("[lighting]", message);
    if (!stateRetryTimer) {
      stateRetryTimer = setTimeout(() => {
        stateRetryTimer = null;
        void serialize(() => saveState());
      }, 30_000);
    }
    if (required) throw new Error(message);
  }
}

async function loadState(): Promise<void> {
  try {
    const parsed = JSON.parse(await readFile(STATE_FILE, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("state must be an object");
    }
    const state = parsed as PersistedState;
    if (!Array.isArray(state.unowned) || state.unowned.some((id) => typeof id !== "string")) {
      throw new Error("unowned must be an array of light ids");
    }
    if (state.heldTheme !== null && state.heldTheme !== undefined && !validStoredLook(state.heldTheme)) {
      throw new Error("heldTheme is invalid");
    }
    if (state.currentSceneKey !== undefined && state.currentSceneKey !== null && typeof state.currentSceneKey !== "string") {
      throw new Error("currentSceneKey must be a string or null");
    }
    if (state.currentScene !== undefined && state.currentScene !== null && typeof state.currentScene !== "string") {
      throw new Error("currentScene must be a string or null");
    }
    if (state.recoveryPaused !== undefined && typeof state.recoveryPaused !== "boolean") {
      throw new Error("recoveryPaused must be a boolean");
    }
    heldTheme = state.heldTheme ?? null;
    if (heldTheme?.color && heldTheme.palette.length === 0) {
      // Legacy empty color themes rendered as white in targetFor(). Store that
      // meaning explicitly so the stricter public API does not lose it.
      heldTheme = { ...heldTheme, color: false };
    }
    if (state.currentSceneKey !== undefined) {
      currentSceneKey = state.currentSceneKey;
    } else {
      const active = resolveActiveScene(config);
      currentSceneKey = active && active.scene.name === state.currentScene ? active.key : null;
    }
    for (const id of state.unowned ?? []) ownership.set(id, { commanded: null, owned: false });
    if (state.recoveryPaused) {
      stateIssue = "automatic lighting is paused after an earlier state-file recovery; resume auto or set a theme";
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    stateIssue = `lighting state could not be loaded: ${(error as Error).message}`;
    currentSceneKey = resolveActiveScene(config)?.key ?? null;
    console.warn("[lighting]", stateIssue);
    await saveState();
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));
const wrapHue = (hue: number) => ((hue % 360) + 360) % 360;
const circDelta = (a: number, b: number) => ((b - a + 540) % 360) - 180;

function hueAllowed(hue: number, ranges: [number, number][]): boolean {
  return !ranges.some(([start, end]) => hue >= start && hue <= end);
}

function nudgeToAllowed(hue: number, ranges: [number, number][]): number {
  let candidate = wrapHue(hue);
  for (let i = 0; i < 72 && !hueAllowed(candidate, ranges); i++) candidate = wrapHue(candidate + 5);
  return candidate;
}

function lookOf(scene: Scene): Look {
  return {
    color: scene.color,
    palette: scene.palette,
    kelvin: scene.kelvin,
    brightness: scene.brightness,
    drift: scene.drift,
  };
}

function targetFor(look: Look, index: number): LightState {
  if (!look.color || look.palette.length === 0) {
    return { power: true, hue: 0, saturation: 0, brightness: look.brightness, kelvin: look.kelvin };
  }
  const count = look.palette.length;
  const period = Math.max(1, config.driftPeriodMinutes) * 60_000;
  const progress = look.drift ? (Date.now() % period) / period : 0;
  const position = ((progress + index / count) % 1) * count;
  const leftIndex = Math.floor(position) % count;
  const left = look.palette[leftIndex];
  const right = look.palette[(leftIndex + 1) % count];
  const fraction = position - Math.floor(position);
  return {
    power: true,
    hue: nudgeToAllowed(wrapHue(left.hue + circDelta(left.hue, right.hue) * fraction), config.avoidHueRanges),
    saturation: left.saturation + (right.saturation - left.saturation) * fraction,
    brightness: look.brightness,
    kelvin: look.kelvin,
  };
}

function matches(actual: LightState, expected: LightState): boolean {
  if (actual.power !== expected.power) return false;
  if (!expected.power) return true;
  if (Math.abs(actual.brightness - expected.brightness) > 6) return false;
  if (Math.abs(actual.saturation - expected.saturation) > 10) return false;
  if (expected.saturation > 5 && Math.abs(circDelta(actual.hue, expected.hue)) > 12) return false;
  if (expected.saturation <= 5 && Math.abs(actual.kelvin - expected.kelvin) > 400) return false;
  return true;
}

const isExcludedLabel = (label: string) => config.perLight[label]?.exclude === true;

async function runTick(force = false): Promise<void> {
  if (!lifx || party.isActive()) return;
  const scheduled = resolveActiveScene(config);
  const active = config.enabled ? scheduled : null;
  if (quietAfterPartyRestore) {
    // Exact party restoration wins initially, just as it does for an immediate
    // stop. Rejoin the currently selected occurrence without replaying any
    // boundary that elapsed while party mode owned the bulbs.
    currentSceneKey = scheduled?.key ?? null;
    quietAfterPartyRestore = false;
    await saveState();
    return;
  }
  if ((stateIssue && !force) || (!config.enabled && !heldTheme && !force)) {
    return;
  }
  const scene = active?.scene ?? null;
  const sceneChanged = config.enabled && active?.key !== currentSceneKey;
  if (sceneChanged && scene?.interruptTheme) heldTheme = null;
  if (sceneChanged && scene?.reclaim) {
    for (const own of ownership.values()) {
      own.owned = true;
      own.commanded = null;
      own.settleUntil = 0;
    }
  }
  const look = heldTheme ?? (scene ? lookOf(scene) : null);

  // Bulbs are independent. Processing them concurrently bounds a stale poll to
  // one LIFX timeout instead of one timeout per bulb, so mutations do not sit
  // behind a long background-reconciliation queue.
  await Promise.all(
    lifx.list().map(async ({ id, label }, index) => {
      const perLight = config.perLight[label] ?? {};
      if (perLight.exclude) return;
      const own = ownership.get(id) ?? { commanded: null, owned: true };
      if (sceneChanged && scene?.reclaim) {
        own.owned = true;
        own.commanded = null;
        own.settleUntil = 0;
      }
      // A held theme is an explicit on-state until a schedule entry interrupts it.
      const desiredPower = heldTheme ? "on" : (scene?.power ?? "leave");
      let state: LightState;
      try {
        state = await lifx!.getState(id);
      } catch {
        // LIFX state queries and power commands fail independently. A scheduled
        // off window should still make its best effort when only getState is wedged.
        const blindOffSettling = Date.now() < (own.settleUntil ?? 0) && own.commanded?.power === false;
        if (desiredPower === "off" && own.owned && !blindOffSettling) {
          try {
            await lifx!.setPower(id, false, config.transitionMs);
            ownership.set(id, {
              commanded: { power: false, hue: 0, saturation: 0, brightness: 0, kelvin: 3500 },
              owned: true,
              settleUntil: Date.now() + config.transitionMs + 1000,
            });
            return;
          } catch (error) {
            console.warn("[lighting] blind setPower failed:", (error as Error).message);
          }
        }
        ownership.set(id, own);
        return;
      }

      const wasSettling = Date.now() < (own.settleUntil ?? 0);
      if (own.commanded && !wasSettling && !matches(state, own.commanded)) own.owned = false;
      if (!own.owned) {
        ownership.set(id, own);
        return;
      }

      if (desiredPower === "off") {
        if (!state.power) {
          own.commanded = { ...state, power: false };
          ownership.set(id, own);
          return;
        }
        if (wasSettling && own.commanded?.power === false) {
          ownership.set(id, own);
          return;
        }
        try {
          await lifx!.setPower(id, false, config.transitionMs);
        } catch (error) {
          console.warn("[lighting] setPower failed:", (error as Error).message);
          ownership.set(id, own);
          return;
        }
        ownership.set(id, {
          commanded: { ...state, power: false },
          owned: true,
          settleUntil: Date.now() + config.transitionMs + 1000,
        });
        return;
      }
      if (desiredPower === "on" && !state.power) {
        try {
          await lifx!.setPower(id, true, config.transitionMs);
        } catch (error) {
          console.warn("[lighting] setPower failed:", (error as Error).message);
          ownership.set(id, own);
          return;
        }
        state.power = true;
        own.commanded = { ...state };
        own.settleUntil = Date.now() + config.transitionMs + 1000;
      }
      if (!state.power || !look) {
        ownership.set(id, own);
        return;
      }

      const scale = (perLight.brightnessScale ?? 1) * config.defaultBrightnessScale;
      const base = targetFor(look, index);
      const target: LightState = { ...base, brightness: Math.round(clamp(base.brightness * scale, 0, 100)) };
      if (wasSettling) {
        ownership.set(id, own);
        return;
      }
      if (!own.commanded || !matches(target, own.commanded) || look.drift) {
        try {
          await lifx!.setColor(id, target, config.transitionMs);
          own.commanded = target;
          own.settleUntil = Date.now() + config.transitionMs + 1000;
        } catch (error) {
          console.warn("[lighting] setColor failed:", (error as Error).message);
        }
      }
      ownership.set(id, own);
    }),
  );
  if (config.enabled) currentSceneKey = active?.key ?? null;
  await saveState();
}

let operationQueue: Promise<unknown> = Promise.resolve();
function serialize<T>(operation: () => Promise<T>): Promise<T> {
  const next = operationQueue.then(operation, operation);
  operationQueue = next.catch(() => {});
  return next;
}

function reconcile(): Promise<void> {
  return serialize(runTick);
}

function queueReconcile(): void {
  void reconcile().catch((error) => console.warn("[lighting] reconcile failed:", (error as Error).message));
}

function queueQuietPartyAlignment(): void {
  void serialize(async () => {
    if (!quietAfterPartyRestore || party.isActive()) return;
    currentSceneKey = resolveActiveScene(config)?.key ?? null;
    // Keep the handoff flag for the first ordinary tick. That tick must return
    // without issuing drift/color commands while the restore transition settles.
    await saveState();
  }).catch((error) => console.warn("[lighting] party alignment failed:", (error as Error).message));
}

function armPoll(): void {
  const generation = ++pollGeneration;
  if (pollTimer) clearTimeout(pollTimer);
  const scheduleNext = () => {
    if (generation !== pollGeneration) return;
    pollTimer = setTimeout(() => {
      if (generation !== pollGeneration) return;
      void reconcile()
        .catch((error) => console.warn("[lighting] tick failed:", (error as Error).message))
        .finally(() => {
          if (generation === pollGeneration) scheduleNext();
        });
    }, config.pollSeconds * 1000);
  };
  scheduleNext();
}

export async function startLighting(): Promise<void> {
  config = await loadConfig();
  await loadState();
  lifx = new Lifx();
  lifx.start();
  await sleep(4000);
  party.setRestoredListener(() => {
    quietAfterPartyRestore = true;
    // Persist clock alignment promptly, but do not touch bulb state: the exact
    // restored snapshot remains visible until ordinary automation next polls.
    queueQuietPartyAlignment();
  });
  await party.resume(lifx, isExcludedLabel);
  await reconcile();
  armPoll();
  console.log("[lighting] started");
}

export function scheduleView(): unknown[] {
  return config.scenes.map((scene) => ({
    name: scene.name,
    start: scene.start,
    days: scene.days,
    enabled: scene.enabled,
    power: scene.power,
    reclaim: scene.reclaim,
    interruptTheme: scene.interruptTheme,
    look: {
      ...(scene.palette.length > 0 ? { colors: scene.palette } : {}),
      white: !scene.color,
      kelvin: scene.kelvin,
      brightness: scene.brightness,
      drift: scene.drift,
    },
  }));
}

export function configView(): unknown {
  return {
    enabled: config.enabled,
    timezone: config.timezone,
    pollSeconds: config.pollSeconds,
    transitionMs: config.transitionMs,
    driftPeriodMinutes: config.driftPeriodMinutes,
    defaultBrightnessScale: config.defaultBrightnessScale,
    avoidHueRanges: config.avoidHueRanges,
    perLight: Object.entries(config.perLight).map(([light, value]) => ({ light, ...value })),
  };
}

export async function status(): Promise<unknown> {
  const active = resolveActiveScene(config);
  const rawParty = party.partyStatus();
  const partyState = {
    active: rawParty.active,
    restoring: rawParty.restoring,
    intensity: rawParty.intensity,
    colors: rawParty.palette,
    brightness: rawParty.brightness,
  };
  const heldThemeView = heldTheme
    ? {
        ...(heldTheme.palette.length > 0 ? { colors: heldTheme.palette } : {}),
        white: !heldTheme.color,
        kelvin: heldTheme.kelvin,
        brightness: heldTheme.brightness,
        drift: heldTheme.drift,
      }
    : null;
  const lights = await Promise.all(
    (lifx?.list() ?? []).map(async ({ id, label }) => {
      const base = {
        id,
        label,
        owned: ownership.get(id)?.owned ?? true,
        held: ownership.get(id)?.owned === false,
        excluded: isExcludedLabel(label),
      };
      try {
        return { ...base, state: await lifx!.getState(id) };
      } catch (error) {
        return { ...base, state: null, error: (error as Error).message };
      }
    }),
  );
  const mode = partyState.restoring
    ? "party_restore"
    : partyState.active
      ? "party"
      : stateIssue
        ? "recovery_paused"
        : !config.enabled
          ? heldTheme
            ? "theme"
            : "disabled"
          : heldTheme
            ? "theme"
            : "automatic";
  return {
    mode,
    enabled: config.enabled,
    party: partyState,
    held: heldTheme ? "custom theme" : null,
    heldTheme: heldThemeView,
    scene: active?.scene.name ?? null,
    sceneSince: active?.localDate && active.scene.start ? `${active.localDate}T${active.scene.start}` : null,
    lights,
    schedule: scheduleView(),
    config: configView(),
    configIssue: configLoadIssue(),
    stateIssue,
  };
}

export async function setEnabled(enabled: boolean): Promise<void> {
  await configure({ enabled });
}

function validateDirectNumber(value: unknown, field: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
    throw new LightingInputError(`${field} must be a number from ${min} to ${max}`);
  }
  return value;
}

export interface SetLightsInput {
  targets?: string[];
  power?: boolean;
  hue?: number;
  saturation?: number;
  brightness?: number;
  kelvin?: number;
  transitionMs?: number;
  hold?: boolean;
}

export interface SetLightsResult {
  matched: string[];
  unknownTargets: string[];
  updated: Array<{ id: string; label: string; state: Partial<LightState> }>;
  failed: Array<{ id: string; label: string; error: string }>;
  hold: boolean;
}

export function setLights(input: SetLightsInput): Promise<SetLightsResult> {
  return serialize(() => setLightsNow(input));
}

async function setLightsNow(input: SetLightsInput): Promise<SetLightsResult> {
  if (!lifx) throw new LightingInputError("lighting has not started");
  if (!input || typeof input !== "object") throw new LightingInputError("light control input must be an object");
  if (party.isActive()) throw new LightingInputError("party mode is active; stop it before direct control");
  if (input.targets !== undefined && !Array.isArray(input.targets)) {
    throw new LightingInputError("targets must be an array of light labels or ids");
  }
  if (input.targets?.some((target) => typeof target !== "string")) {
    throw new LightingInputError("every target must be a light label or id string");
  }
  if (input.targets?.some((target) => !target.trim())) {
    throw new LightingInputError("target light labels and ids cannot be blank");
  }
  if (input.power !== undefined && typeof input.power !== "boolean") {
    throw new LightingInputError("power must be a boolean");
  }
  if (input.hold !== undefined && typeof input.hold !== "boolean") throw new LightingInputError("hold must be a boolean");
  if (input.hue !== undefined) validateDirectNumber(input.hue, "hue", 0, 360);
  if (input.saturation !== undefined) validateDirectNumber(input.saturation, "saturation", 0, 100);
  if (input.brightness !== undefined) validateDirectNumber(input.brightness, "brightness", 0, 100);
  if (input.kelvin !== undefined) validateDirectNumber(input.kelvin, "kelvin", 1500, 9000);
  const transitionMs =
    input.transitionMs === undefined
      ? config.transitionMs
      : validateDirectNumber(input.transitionMs, "transitionMs", 0, 300_000);
  const hasState = [input.power, input.hue, input.saturation, input.brightness, input.kelvin].some(
    (value) => value !== undefined,
  );
  const hasColorState = [input.hue, input.saturation, input.brightness, input.kelvin].some(
    (value) => value !== undefined,
  );
  if (!hasState && input.hold !== false) {
    throw new LightingInputError("set at least one light state field, or use hold:false to resume automation");
  }

  const available = lifx.list();
  const requested = [...new Set((input.targets ?? []).map((target) => target.trim()).filter(Boolean))];
  const selected =
    requested.length === 0
      ? available
      : available.filter(({ id, label }) =>
          requested.some((target) => target === id || target.toLocaleLowerCase() === label.toLocaleLowerCase()),
        );
  const unknownTargets = requested.filter(
    (target) => !available.some(({ id, label }) => target === id || target.toLocaleLowerCase() === label.toLocaleLowerCase()),
  );
  if (requested.length > 0 && selected.length === 0) {
    throw new LightingInputError(`no lights matched: ${unknownTargets.join(", ")}`);
  }

  const hold = input.hold ?? true;
  const updated: SetLightsResult["updated"] = [];
  const failed: SetLightsResult["failed"] = [];
  await Promise.all(
    selected.map(async ({ id, label }) => {
      try {
        // Power-off is the critical energy-saving path. LIFX can accept it
        // without a preceding state query, so a wedged getState must not block it.
        if (input.power !== undefined && !hasColorState) {
          await lifx!.setPower(id, input.power, transitionMs);
          ownership.set(
            id,
            hold
              ? { commanded: null, owned: false }
              : { commanded: null, owned: true, settleUntil: Date.now() + transitionMs + 1000 },
          );
          updated.push({ id, label, state: { power: input.power } });
          return;
        }
        // With a mixed off+color request, power safety is independent of the
        // optional color preset. Report a partial color failure, but never leave
        // the light on merely because a state read or color write failed.
        if (input.power === false) {
          await lifx!.setPower(id, false, transitionMs);
          ownership.set(
            id,
            hold
              ? { commanded: null, owned: false }
              : { commanded: null, owned: true, settleUntil: Date.now() + transitionMs + 1000 },
          );
          let reported: Partial<LightState> = { power: false };
          try {
            const before = await lifx!.getState(id);
            const desired: LightState = {
              power: false,
              hue: input.hue ?? before.hue,
              saturation: input.saturation ?? before.saturation,
              brightness: input.brightness ?? before.brightness,
              kelvin: input.kelvin ?? before.kelvin,
            };
            await lifx!.setColor(id, desired, transitionMs);
            reported = desired;
            if (!hold) {
              ownership.set(id, {
                commanded: desired,
                owned: true,
                settleUntil: Date.now() + transitionMs + 1000,
              });
            }
          } catch (error) {
            failed.push({ id, label, error: `power off succeeded; color update failed: ${(error as Error).message}` });
          }
          updated.push({ id, label, state: reported });
          return;
        }
        // Releasing a hold is local bookkeeping; reconciliation will query the
        // bulb and apply the active controller immediately afterward.
        if (!hasState) {
          ownership.set(id, { commanded: null, owned: true });
          updated.push({ id, label, state: {} });
          return;
        }
        const before = await lifx!.getState(id);
        const desired: LightState = {
          power: input.power ?? before.power,
          hue: input.hue ?? before.hue,
          saturation: input.saturation ?? before.saturation,
          brightness: input.brightness ?? before.brightness,
          kelvin: input.kelvin ?? before.kelvin,
        };
        if (hasState) {
          if (desired.power && !before.power) await lifx!.setPower(id, true, transitionMs);
          if (
            input.hue !== undefined ||
            input.saturation !== undefined ||
            input.brightness !== undefined ||
            input.kelvin !== undefined
          ) {
            await lifx!.setColor(id, desired, transitionMs);
          }
          if (!desired.power && before.power) await lifx!.setPower(id, false, transitionMs);
        }
        ownership.set(
          id,
          hold
            ? { commanded: null, owned: false }
            : { commanded: desired, owned: true, settleUntil: Date.now() + transitionMs + 1000 },
        );
        updated.push({ id, label, state: desired });
      } catch (error) {
        failed.push({ id, label, error: (error as Error).message });
      }
    }),
  );
  await saveState(true);
  if (!hold) await runTick();
  return { matched: selected.map(({ label }) => label), unknownTargets, updated, failed, hold };
}

// Legacy all-power route: an explicit power command holds until auto/reclaim.
export async function setAllPower(on: boolean): Promise<void> {
  await setLights({ power: on, hold: true });
}

export interface ThemeInput {
  palette?: Color[];
  brightness?: number;
  drift?: boolean;
  white?: boolean;
  kelvin?: number;
}

async function reclaimAndPowerOn(): Promise<void> {
  if (!lifx) return;
  await Promise.all(
    lifx.list().map(async ({ id, label }) => {
      if (isExcludedLabel(label)) return;
      await lifx!.setPower(id, true, config.transitionMs).catch(() => {});
      ownership.set(id, { commanded: null, owned: true });
    }),
  );
}

function validateThemeInput(input: ThemeInput): void {
  if (!input || typeof input !== "object") throw new LightingInputError("theme input must be an object");
  if (input.white !== undefined && typeof input.white !== "boolean") {
    throw new LightingInputError("white must be a boolean");
  }
  if (input.palette !== undefined) {
    if (!Array.isArray(input.palette) || input.palette.length === 0) {
      throw new LightingInputError("a color theme needs at least one palette color");
    }
    for (const [index, color] of input.palette.entries()) {
      validateDirectNumber(color?.hue, `palette[${index}].hue`, 0, 360);
      validateDirectNumber(color?.saturation, `palette[${index}].saturation`, 0, 100);
    }
  }
  if (input.white && input.palette) throw new LightingInputError("choose either a color palette or white");
  if (!input.white && !input.palette) throw new LightingInputError("provide a color palette or set white:true");
  if (input.brightness !== undefined) validateDirectNumber(input.brightness, "brightness", 0, 100);
  if (input.kelvin !== undefined) validateDirectNumber(input.kelvin, "kelvin", 1500, 9000);
  if (input.drift !== undefined && typeof input.drift !== "boolean") {
    throw new LightingInputError("drift must be a boolean");
  }
}

export function setTheme(input: ThemeInput): Promise<void> {
  validateThemeInput(input);
  return serialize(() => setThemeNow(input));
}

async function setThemeNow(input: ThemeInput): Promise<void> {
  stateIssue = null;
  quietAfterPartyRestore = false;
  // A global theme explicitly reclaims even bulbs that are currently offline;
  // deleting stale entries makes them default to owned when rediscovered.
  ownership.clear();
  heldTheme = {
    color: !input.white,
    palette: input.palette ?? [],
    kelvin: input.kelvin ?? 2700,
    brightness: input.brightness ?? 45,
    drift: input.drift ?? true,
  };
  currentSceneKey = resolveActiveScene(config)?.key ?? null;
  await reclaimAndPowerOn();
  await saveState(true);
  await runTick(true);
}

export function applyScene(name: string): Promise<void> {
  const scene = config.scenes.find((candidate) => candidate.name.toLocaleLowerCase() === name.toLocaleLowerCase());
  if (!scene) throw new LightingInputError(`unknown lighting scene: ${name}`);
  return setTheme({
    palette: scene.color ? scene.palette : undefined,
    white: !scene.color,
    kelvin: scene.kelvin,
    brightness: scene.brightness,
    drift: scene.drift,
  });
}

export interface SceneLookInput extends ThemeInput {
  scene: string;
}

export function setSceneLook(input: SceneLookInput): Promise<TasteConfig> {
  if (!input || typeof input.scene !== "string") throw new LightingInputError("scene must be a name");
  const scene = config.scenes.find((candidate) => candidate.name.toLocaleLowerCase() === input.scene.toLocaleLowerCase());
  if (!scene) throw new LightingInputError(`unknown lighting scene: ${input.scene}`);
  return configureSchedule({
    upsert: [
      {
        name: scene.name,
        look: {
          colors: input.palette,
          brightness: input.brightness,
          drift: input.drift,
          white: input.white,
          kelvin: input.kelvin,
        },
      },
    ],
  });
}

function validatePartyInput(input: party.PartyInput): void {
  if (!input || typeof input !== "object") throw new LightingInputError("party input must be an object");
  if (input.intensity !== undefined) {
    validateDirectNumber(input.intensity, "intensity", 1, 10);
    if (!Number.isInteger(input.intensity)) throw new LightingInputError("intensity must be an integer");
  }
  if (input.brightness !== undefined) validateDirectNumber(input.brightness, "brightness", 1, 100);
  if (input.palette !== undefined && input.palette !== null) {
    if (!Array.isArray(input.palette)) throw new LightingInputError("palette must be colors, null, or omitted");
    for (const [index, color] of input.palette.entries()) {
      validateDirectNumber(color?.hue, `palette[${index}].hue`, 0, 360);
      validateDirectNumber(color?.saturation, `palette[${index}].saturation`, 0, 100);
    }
  }
}

export function startParty(input: party.PartyInput): Promise<void> {
  validatePartyInput(input);
  return serialize(async () => {
    if (!lifx) throw new LightingInputError("lighting has not started");
    await party.start(lifx, input, isExcludedLabel);
  });
}

export async function stopParty(): Promise<void> {
  await serialize(async () => {
    if (!lifx || !(await party.stop(lifx))) return;
    currentSceneKey = resolveActiveScene(config)?.key ?? null;
    await saveState(true);
  });
}

export async function resumeAuto(): Promise<void> {
  await serialize(async () => {
    stateIssue = null;
    quietAfterPartyRestore = false;
    heldTheme = null;
    // Clear persisted holds for offline bulbs too. Newly rediscovered bulbs then
    // default to owned instead of resurrecting a pre-resume override.
    ownership.clear();
    if (lifx) {
      for (const { id, label } of lifx.list()) {
        if (!isExcludedLabel(label)) ownership.set(id, { commanded: null, owned: true });
      }
    }
    currentSceneKey = null;
    await saveState(true);
    if (config.enabled) await runTick();
  });
}

export async function flash(times = 2): Promise<void> {
  await serialize(async () => {
    if (!lifx || party.isActive()) return;
    const count = Math.max(1, Math.min(10, Math.round(times)));
    const pulse = { hue: 210, saturation: 80, brightness: 100, kelvin: 3500 };
    await Promise.all(
      lifx.list().map(async ({ id, label }) => {
        if (isExcludedLabel(label)) return;
        const before = await lifx!.getState(id).catch(() => null);
        if (!before) return;
        for (let i = 0; i < count; i++) {
          await lifx!.setColor(id, pulse, 200).catch(() => {});
          await sleep(350);
          await lifx!.setColor(id, before, 200).catch(() => {});
          await sleep(250);
        }
      }),
    );
  });
}

export async function configureSchedule(input: ScheduleUpdate): Promise<TasteConfig> {
  return serialize(async () => {
    if (configLoadIssue() && input.replace === undefined) {
      throw new LightingInputError("the saved lighting config is invalid; repair it with a complete schedule replacement");
    }
    const before = resolveActiveScene(config);
    const next = updateSchedule(config, input);
    const after = resolveActiveScene(next);
    const occurrenceChanged = before?.key !== after?.key;
    const activeContentChanged = JSON.stringify(before?.scene ?? null) !== JSON.stringify(after?.scene ?? null);
    await saveConfig(next);
    config = next;
    clearConfigLoadIssue();
    if (occurrenceChanged) {
      // Editing which historical occurrence is currently selected is not a
      // real clock boundary. Align quietly; resumeAuto is the explicit way to
      // request reclaim/interrupt policy immediately after an edit.
      currentSceneKey = after?.key ?? null;
      await saveState(true);
    }
    if (occurrenceChanged || activeContentChanged) queueReconcile();
    return config;
  });
}

export async function configure(patch: ConfigPatch): Promise<TasteConfig> {
  return serialize(async () => {
    if (configLoadIssue()) {
      throw new LightingInputError("the saved lighting config is invalid; replace the schedule before patching configuration");
    }
    const previousPoll = config.pollSeconds;
    const previousTimezone = config.timezone;
    const next = applyConfigPatch(config, patch);
    await saveConfig(next);
    config = next;
    if (config.pollSeconds !== previousPoll && lifx) armPoll();
    if (config.timezone !== previousTimezone) {
      currentSceneKey = resolveActiveScene(config)?.key ?? null;
      await saveState(true);
    }
    for (const own of ownership.values()) if (own.owned) own.commanded = null;
    if (config.enabled || heldTheme) queueReconcile();
    return config;
  });
}

export interface TastePatch {
  light?: string;
  brightnessScale?: number;
  exclude?: boolean;
  avoidRed?: boolean;
}

export async function tune(patch: TastePatch): Promise<TasteConfig> {
  const avoidHueRanges =
    patch.avoidRed === undefined
      ? undefined
      : patch.avoidRed
        ? [...config.avoidHueRanges.filter(([start]) => start !== RED[0][0] && start !== RED[1][0]), ...RED]
        : config.avoidHueRanges.filter(([start]) => start !== RED[0][0] && start !== RED[1][0]);
  return configure({
    avoidHueRanges,
    defaultBrightnessScale: patch.light ? undefined : patch.brightnessScale,
    perLight: patch.light
      ? [{ light: patch.light, brightnessScale: patch.brightnessScale, exclude: patch.exclude }]
      : undefined,
  });
}
