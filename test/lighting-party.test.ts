import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Lifx, LightInfo, LightState } from "../src/lighting/lifx.js";

const stateFile = join(tmpdir(), `sf-pi-party-${process.pid}-${Date.now()}.json`);
process.env.PARTY_STATE_FILE = stateFile;

const party = await import("../src/lighting/party.js");

type ColorState = Omit<LightState, "power">;

class FakeLifx {
  readonly calls: Array<{ operation: "color" | "power"; id: string }> = [];
  readonly #states = new Map<string, LightState>();
  readonly #labels = new Map<string, string>();
  readonly #discovered = new Set<string>();
  readonly #unreachable = new Set<string>();
  readonly #colorFailures = new Set<string>();

  constructor(lights: Array<{ id: string; label?: string; state: LightState }>) {
    for (const light of lights) this.add(light.id, light.state, light.label);
  }

  add(id: string, state: LightState, label = id): void {
    this.#states.set(id, structuredClone(state));
    this.#labels.set(id, label);
    this.#discovered.add(id);
    this.#unreachable.delete(id);
  }

  lose(id: string): void {
    this.#discovered.delete(id);
    this.#unreachable.add(id);
  }

  recover(id: string, current: LightState): void {
    this.add(id, current, this.#labels.get(id));
  }

  recoverAll(): void {
    for (const id of this.#states.keys()) {
      this.#discovered.add(id);
      this.#unreachable.delete(id);
    }
  }

  failColor(id: string): void {
    this.#colorFailures.add(id);
  }

  allowColor(id: string): void {
    this.#colorFailures.delete(id);
  }

  list(): LightInfo[] {
    return [...this.#discovered].map((id) => ({ id, label: this.#labels.get(id) ?? id }));
  }

  async getState(id: string): Promise<LightState> {
    return structuredClone(this.#require(id));
  }

  async setColor(id: string, color: ColorState, _durationMs = 1000): Promise<void> {
    const current = this.#require(id);
    if (this.#colorFailures.has(id)) throw new Error(`light ${id} color failed`);
    this.calls.push({ operation: "color", id });
    this.#states.set(id, { ...current, ...color });
  }

  async setPower(id: string, power: boolean, _durationMs = 1000): Promise<void> {
    const current = this.#require(id);
    this.calls.push({ operation: "power", id });
    this.#states.set(id, { ...current, power });
  }

  state(id: string): LightState {
    const state = this.#states.get(id);
    if (!state) throw new Error(`unknown fake light ${id}`);
    return structuredClone(state);
  }

  callsFor(id: string): Array<{ operation: "color" | "power"; id: string }> {
    return this.calls.filter((call) => call.id === id);
  }

  #require(id: string): LightState {
    const state = this.#states.get(id);
    if (!state || this.#unreachable.has(id)) throw new Error(`light ${id} not found`);
    return state;
  }
}

const asLifx = (fake: FakeLifx): Lifx => fake as unknown as Lifx;
const includeAll = () => false;
const lightState = (overrides: Partial<LightState> = {}): LightState => ({
  power: true,
  hue: 32,
  saturation: 68,
  brightness: 54,
  kelvin: 3200,
  ...overrides,
});

let currentFake: FakeLifx | undefined;

afterEach(async () => {
  if (party.isActive() && currentFake) {
    currentFake.recoverAll();
    await party.stop(asLifx(currentFake));
  }
  currentFake = undefined;
  await rm(stateFile, { force: true });
  await rm(`${stateFile}.tmp`, { force: true });
});

afterAll(async () => {
  await rm(stateFile, { force: true });
  await rm(`${stateFile}.tmp`, { force: true });
});

describe("party mode persistence and restoration", () => {
  test("retuning without a palette preserves the active palette", async () => {
    const fake = (currentFake = new FakeLifx([{ id: "desk", state: lightState() }]));
    const palette = [
      { hue: 15, saturation: 90 },
      { hue: 210, saturation: 75 },
    ];

    await party.start(asLifx(fake), { intensity: 3, palette, brightness: 64 }, includeAll);
    await party.start(asLifx(fake), { intensity: 8 }, includeAll);

    expect(party.partyStatus()).toMatchObject({
      active: true,
      restoring: false,
      intensity: 8,
      palette,
      brightness: 64,
    });
    expect(await party.stop(asLifx(fake))).toBe(true);
  });

  test("stop restores each snapshotted light to its exact pre-party state", async () => {
    const onBefore = lightState({ power: true, hue: 286, saturation: 41, brightness: 37, kelvin: 2750 });
    const offBefore = lightState({ power: false, hue: 48, saturation: 12, brightness: 23, kelvin: 4100 });
    const fake = (currentFake = new FakeLifx([
      { id: "on", state: onBefore },
      { id: "off", state: offBefore },
    ]));

    await party.start(asLifx(fake), { intensity: 10, brightness: 93 }, includeAll);
    expect(JSON.parse(await readFile(stateFile, "utf8"))).toMatchObject({
      restoring: false,
      snapshot: { on: onBefore, off: offBefore },
    });

    expect(await party.stop(asLifx(fake))).toBe(true);
    expect(fake.state("on")).toEqual(onBefore);
    expect(fake.state("off")).toEqual(offBefore);
    expect(await Bun.file(stateFile).exists()).toBe(false);
  });

  test("an unreachable snapshotted light keeps restoration pending and can recover later", async () => {
    const reachableBefore = lightState({ hue: 120 });
    const missingBefore = lightState({ hue: 240, brightness: 28 });
    const fake = (currentFake = new FakeLifx([
      { id: "reachable", state: reachableBefore },
      { id: "missing", state: missingBefore },
    ]));

    await party.start(asLifx(fake), { intensity: 4 }, includeAll);
    fake.lose("missing");

    expect(await party.stop(asLifx(fake))).toBe(false);
    expect(party.partyStatus()).toMatchObject({ active: false, restoring: true });
    expect(JSON.parse(await readFile(stateFile, "utf8"))).toMatchObject({
      restoring: true,
      snapshot: { missing: missingBefore },
    });

    fake.recover("missing", lightState({ hue: 5, brightness: 100 }));
    expect(await party.stop(asLifx(fake))).toBe(true);
    expect(fake.state("missing")).toEqual(missingBefore);
    expect(await Bun.file(stateFile).exists()).toBe(false);
  });

  test("a saved-off light powers off even when exact color restoration must retry", async () => {
    const before = lightState({ power: false, hue: 48, saturation: 12, brightness: 23, kelvin: 4100 });
    const fake = (currentFake = new FakeLifx([{ id: "sleep", state: before }]));

    await party.start(asLifx(fake), { intensity: 3 }, includeAll);
    fake.failColor("sleep");

    expect(await party.stop(asLifx(fake))).toBe(false);
    expect(fake.state("sleep").power).toBe(false);
    expect(party.partyStatus()).toMatchObject({ active: false, restoring: true });

    fake.allowColor("sleep");
    expect(await party.stop(asLifx(fake))).toBe(true);
    expect(fake.state("sleep")).toEqual(before);
  });

  test("lights discovered after the snapshot are never controlled by party mode", async () => {
    const fake = (currentFake = new FakeLifx([{ id: "original", state: lightState() }]));

    await party.start(asLifx(fake), { intensity: 10 }, includeAll);
    fake.add("late", lightState({ hue: 175 }), "Late arrival");
    await new Promise((resolve) => setTimeout(resolve, 725));
    expect(await party.stop(asLifx(fake))).toBe(true);

    expect(fake.callsFor("late")).toEqual([]);
  });
});
