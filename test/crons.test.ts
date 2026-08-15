import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";

// The store is module-level state keyed off env, so point it at a scratch file
// before importing. Nothing here fires an entry — no network, no Telegram.
const FILE = "./test/.tmp/crons.json";
process.env.CRONS_FILE = FILE;
process.env.OWNER_TIMEZONE = "America/New_York";

const { configureCrons, CronInputError, cronsView, loadCrons } = await import("../src/crons.js");

const reset = async () => {
  await rm("./test/.tmp", { recursive: true, force: true });
  await loadCrons();
};

afterAll(() => rm("./test/.tmp", { recursive: true, force: true }));

describe("recurring wakeups", () => {
  beforeEach(reset);

  test("seeds a brief and a review on a box that has never had a schedule", async () => {
    expect(cronsView().entries.map((e) => e.name)).toEqual(["morning_brief", "evening_review"]);
    expect(cronsView().entries.every((e) => e.kind === "wake" && e.enabled)).toBe(true);
  });

  test("an emptied schedule stays empty across a reload", async () => {
    await configureCrons({ replace: [] });
    await loadCrons();
    expect(cronsView().entries).toHaveLength(0);
  });

  test("upsert patches by name and leaves the rest of the entry alone", async () => {
    await configureCrons({ upsert: [{ name: "morning_brief", start: "07:30" }] });
    const brief = cronsView().entries.find((e) => e.name === "morning_brief");
    expect(brief?.start).toBe("07:30");
    expect(brief?.days).toHaveLength(7);
    expect(brief?.prompt).toContain("Morning brief");
  });

  test("retiming clears lastFired so the entry can still run today", async () => {
    await configureCrons({ upsert: [{ name: "solo", start: "09:00", prompt: "think" }] });
    await configureCrons({ upsert: [{ name: "solo", start: "10:00" }] });
    expect(cronsView().entries.find((e) => e.name === "solo")?.lastFired).toBeUndefined();
  });

  test("next run skips to the following matching weekday", async () => {
    await configureCrons({
      replace: [{ name: "friday_wrap", start: "16:00", days: ["fri"], prompt: "wrap up", kind: "wake" }],
    });
    const next = cronsView().entries[0]?.nextRun;
    expect(next).toMatch(/^\d{4}-\d{2}-\d{2}T16:00 \(America\/New_York\)$/);
    // Whatever today is, the next occurrence must land on a Friday.
    expect(new Date(`${next!.slice(0, 10)}T12:00:00Z`).getUTCDay()).toBe(5);
  });

  test("removal is case-insensitive and runs after replacement", async () => {
    await configureCrons({
      replace: [{ name: "Alpha", start: "08:00", prompt: "a" }, { name: "beta", start: "09:00", prompt: "b" }],
      remove: ["ALPHA"],
    });
    expect(cronsView().entries.map((e) => e.name)).toEqual(["beta"]);
  });

  test("bad input is a typed error, not a crash", async () => {
    const bad = [
      { upsert: [{ name: "x", start: "25:00", prompt: "p" }] },
      { upsert: [{ name: "x", start: "10:00", prompt: "p", days: ["funday"] }] },
      { upsert: [{ name: "x", start: "10:00" }] }, // no prompt
      { upsert: [{ name: "x", prompt: "p" }] }, // new entry with no start
      { remove: [] }, // nothing to do
      { replace: [{ name: "a", start: "08:00", prompt: "p" }, { name: "A", start: "09:00", prompt: "p" }] },
    ];
    for (const input of bad) {
      await expect(configureCrons(input as never)).rejects.toBeInstanceOf(CronInputError);
    }
  });
});
