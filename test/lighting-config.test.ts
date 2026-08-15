import { describe, expect, test } from "bun:test";
import {
  applyConfigPatch,
  defaultConfig,
  LightingInputError,
  normalizeConfig,
  resolveActiveScene,
  updateSchedule,
} from "../src/lighting/config.js";

const fresh = () => structuredClone(defaultConfig);

describe("lighting config migration", () => {
  test("migrates legacy hourly authoritative scenes without losing their look", () => {
    const config = normalizeConfig({
      scenes: [
        {
          name: "sleep",
          startHour: 23,
          authoritative: true,
          power: "off",
          color: true,
          palette: [{ hue: 260, saturation: 50 }],
          kelvin: 2400,
          brightness: 12,
          drift: true,
        },
      ],
    });

    expect(config.scenes[0]).toMatchObject({
      name: "sleep",
      start: "23:00",
      power: "off",
      reclaim: true,
      interruptTheme: true,
      brightness: 12,
      drift: true,
    });
    expect(config.scenes[0].days).toHaveLength(7);
    expect(config.scenes[0].palette).toEqual([{ hue: 260, saturation: 50 }]);
  });

  test("rejects malformed explicit weekdays instead of broadening them to every day", () => {
    expect(() =>
      normalizeConfig({
        scenes: [{ name: "sleep", start: "23:00", days: ["Mon"], power: "off" }],
      }),
    ).toThrow(LightingInputError);
    expect(() =>
      normalizeConfig({
        scenes: [{ name: "sleep", start: "23:00", days: [], power: "off" }],
      }),
    ).toThrow(LightingInputError);
  });

  test("rejects malformed explicit scene fields instead of substituting named defaults", () => {
    const malformed = [
      { power: "of" },
      { reclaim: "yes" },
      { interruptTheme: 1 },
      { color: "true" },
      { drift: null },
      { palette: [{ hue: 999, saturation: 50 }] },
      { kelvin: 999 },
      { brightness: 101 },
      { start: "25:00" },
    ];
    for (const fields of malformed) {
      expect(() => normalizeConfig({ scenes: [{ name: "night", ...fields }] })).toThrow(LightingInputError);
    }
  });

  test("rejects malformed explicit top-level fields instead of restoring defaults", () => {
    expect(() => normalizeConfig({ enabled: "true" })).toThrow(LightingInputError);
    expect(() => normalizeConfig({ pollSeconds: "45" })).toThrow(LightingInputError);
    expect(() => normalizeConfig({ scenes: null })).toThrow(LightingInputError);
    expect(() => normalizeConfig({ perLight: [] })).toThrow(LightingInputError);
  });

  test("does not synthesize enabled midnight entries from truncated custom scenes", () => {
    expect(() => normalizeConfig({ scenes: [{ power: "on" }] })).toThrow(LightingInputError);
    expect(() => normalizeConfig({ scenes: [{ name: "custom", power: "on" }] })).toThrow(LightingInputError);
    expect(normalizeConfig({ scenes: [{ name: "night", power: "off" }] }).scenes[0]).toMatchObject({
      name: "night",
      start: "22:00",
      power: "off",
    });
    expect(normalizeConfig({ scenes: [{ name: "night", brightness: 0 }] }).scenes[0].brightness).toBe(0);
    expect(normalizeConfig({ scenes: [{ name: "night", color: true, palette: [] }] }).scenes[0]).toMatchObject({
      color: false,
      palette: [],
    });
  });
});

describe("lighting schedule updates", () => {
  test("can turn the existing night entry into an energy-saving off window", () => {
    const config = updateSchedule(fresh(), { upsert: [{ name: "night", power: "off" }] });
    expect(config.scenes.find(({ name }) => name === "night")).toMatchObject({
      start: "22:00",
      power: "off",
      reclaim: true,
      interruptTheme: true,
      drift: true,
    });
  });

  test("adds a minute-precise weekday power-off entry with an independent policy", () => {
    const config = updateSchedule(fresh(), {
      upsert: [
        {
          name: "energy saver",
          start: "23:30",
          days: ["sun", "mon", "tue", "wed", "thu"],
          power: "off",
          reclaim: true,
          interruptTheme: false,
          look: { colors: [{ hue: 190, saturation: 40 }], brightness: 20, drift: false },
        },
      ],
    });

    expect(config.scenes.at(-1)).toMatchObject({
      name: "energy saver",
      start: "23:30",
      power: "off",
      reclaim: true,
      interruptTheme: false,
      brightness: 20,
      drift: false,
    });
  });

  test("applies replace, remove, then upsert and permits an empty schedule", () => {
    const replaced = updateSchedule(fresh(), {
      replace: [{ name: "sleep", start: "22:45", power: "off" }],
      upsert: [{ name: "sleep", start: "23:00" }],
    });
    expect(replaced.scenes.map(({ name, start }) => ({ name, start }))).toEqual([
      { name: "sleep", start: "23:00" },
    ]);
    expect(updateSchedule(replaced, { remove: ["SLEEP"] }).scenes).toEqual([]);
    expect(updateSchedule(fresh(), { replace: [] }).scenes).toEqual([]);
  });

  test("rejects enabled entries that overlap on any weekday", () => {
    expect(() =>
      updateSchedule(fresh(), {
        replace: [
          { name: "one", start: "08:15", days: ["mon", "tue"] },
          { name: "two", start: "08:15", days: ["tue", "wed"] },
        ],
      }),
    ).toThrow(LightingInputError);
  });
});

describe("active lighting scene resolution", () => {
  test("wraps to the latest eligible previous-day entry", () => {
    const config = updateSchedule({ ...fresh(), timezone: "UTC" }, {
      replace: [
        { name: "monday", start: "20:00", days: ["mon"], power: "off" },
        { name: "tuesday", start: "10:00", days: ["tue"], power: "on" },
      ],
    });

    const beforeTuesday = resolveActiveScene(config, new Date("2026-08-18T09:00:00Z"));
    expect(beforeTuesday?.scene.name).toBe("monday");
    expect(beforeTuesday?.key).toBe("monday@2026-08-17T20:00");

    const afterTuesday = resolveActiveScene(config, new Date("2026-08-18T10:01:00Z"));
    expect(afterTuesday?.scene.name).toBe("tuesday");
    expect(afterTuesday?.key).toBe("tuesday@2026-08-18T10:00");
  });

  test("uses a new occurrence key each day and returns null for an idle schedule", () => {
    const config = updateSchedule({ ...fresh(), timezone: "UTC" }, {
      replace: [{ name: "daily", start: "00:00" }],
    });
    expect(resolveActiveScene(config, new Date("2026-08-15T12:00:00Z"))?.key).toBe(
      "daily@2026-08-15T00:00",
    );
    expect(resolveActiveScene(config, new Date("2026-08-16T12:00:00Z"))?.key).toBe(
      "daily@2026-08-16T00:00",
    );
    expect(resolveActiveScene({ ...config, scenes: [] })).toBeNull();
  });

  test("keeps a weekly entry active before its next same-weekday occurrence", () => {
    const config = updateSchedule({ ...fresh(), timezone: "UTC" }, {
      replace: [{ name: "weekly", start: "20:00", days: ["mon"] }],
    });
    const active = resolveActiveScene(config, new Date("2026-08-17T19:00:00Z"));
    expect(active?.scene.name).toBe("weekly");
    expect(active?.key).toBe("weekly@2026-08-10T20:00");
  });
});

describe("lighting configuration patches", () => {
  test("sets, clears, and removes per-light configuration", () => {
    let config = applyConfigPatch(fresh(), {
      driftPeriodMinutes: 75,
      perLight: [{ light: "Desk", brightnessScale: 0.6, exclude: true }],
    });
    expect(config.perLight.Desk).toEqual({ brightnessScale: 0.6, exclude: true });

    config = applyConfigPatch(config, {
      perLight: [{ light: "Desk", brightnessScale: null, exclude: false }],
    });
    expect(config.perLight.Desk).toEqual({ exclude: false });

    config = applyConfigPatch(config, { perLight: [{ light: "Desk", remove: true }] });
    expect(config.perLight.Desk).toBeUndefined();
  });

  test("validates daemon bounds and timezone", () => {
    expect(() => applyConfigPatch(fresh(), { pollSeconds: 0 })).toThrow(LightingInputError);
    expect(() => applyConfigPatch(fresh(), { timezone: "Mars/Olympus_Mons" })).toThrow(LightingInputError);
  });
});
