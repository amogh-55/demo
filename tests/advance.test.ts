import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { advanceFor, isPastSlot } from "../src/lib/booking/schedule";
import type { FacilityConfig } from "../src/lib/types";

const base: FacilityConfig = {
  slotMinutes: 60,
  openMin: 6 * 60,
  closeMin: 23 * 60,
  priceRules: [{ fromMin: 6 * 60, toMin: 23 * 60, price: 700 }],
  weekendPriceRules: [],
  weekendDays: [5, 6, 0],
  bookingWindowDays: 30,
  holdMinutes: 8,
  oversPerSlot: 0,
  payAtVenueMaxOvers: 0,
  advancePercent: 0,
  ballTypes: [],
};

const withAdvance = (percent: number): FacilityConfig => ({ ...base, advancePercent: percent });

/**
 * What a customer may pay now. This is money, and it is computed on the server
 * precisely so that a browser cannot name its own figure — the tests below are
 * what stop it naming one by accident.
 */
describe("the advance a customer may pay online", () => {
  it("is half the booking at 50%", () => {
    assert.equal(advanceFor(withAdvance(50), 700), 350);
    assert.equal(advanceFor(withAdvance(50), 1200), 600);
  });

  it("is nothing when the facility does not offer one", () => {
    assert.equal(advanceFor(base, 700), 0);
    assert.equal(advanceFor(withAdvance(0), 700), 0);
  });

  /** Rounding goes to the ground, never away from it. */
  it("rounds a part rupee up, so the gate is never short", () => {
    assert.equal(advanceFor(withAdvance(50), 701), 351);
    assert.equal(advanceFor(withAdvance(33), 100), 33);
    assert.equal(advanceFor(withAdvance(1), 150), 2);
  });

  it("never equals or exceeds the total", () => {
    // 99% of ₹1 rounds up to ₹1, which is the whole booking — not an advance.
    assert.equal(advanceFor(withAdvance(99), 1), 0);
    assert.equal(advanceFor(withAdvance(50), 1), 0);
    for (const percent of [1, 33, 50, 99]) {
      const advance = advanceFor(withAdvance(percent), 700);
      assert.ok(advance === 0 || (advance > 0 && advance < 700), `${percent}% gave ${advance}`);
    }
  });

  it("is nothing on a free or nonsensical total", () => {
    assert.equal(advanceFor(withAdvance(50), 0), 0);
    assert.equal(advanceFor(withAdvance(50), -100), 0);
  });

  /** Out-of-range percentages are refused rather than clamped into a wrong charge. */
  it("ignores a percentage outside its own range", () => {
    assert.equal(advanceFor(withAdvance(100), 700), 0);
    assert.equal(advanceFor(withAdvance(150), 700), 0);
    assert.equal(advanceFor(withAdvance(-50), 700), 0);
  });
});

/**
 * The admin grid and the customer grid disagreed about this: the public page
 * greyed out this morning, the admin page offered it, and staff only found out
 * by filling in a phone booking and being refused on save.
 */
describe("whether a slot has already passed", () => {
  /** 22 Sep 2026, 14:30 IST — 09:00 UTC. */
  const now = new Date("2026-09-22T09:00:00.000Z");

  it("is true for an earlier hour today", () => {
    assert.equal(isPastSlot("2026-09-22", 6 * 60, now), true);
    assert.equal(isPastSlot("2026-09-22", 14 * 60, now), true);
  });

  it("is false for a later hour today", () => {
    assert.equal(isPastSlot("2026-09-22", 15 * 60, now), false);
    assert.equal(isPastSlot("2026-09-22", 22 * 60, now), false);
  });

  it("is true for yesterday, whatever the hour", () => {
    assert.equal(isPastSlot("2026-09-21", 22 * 60, now), true);
  });

  it("is false for tomorrow, whatever the hour", () => {
    assert.equal(isPastSlot("2026-09-23", 6 * 60, now), false);
  });

  /** The boundary belongs to the past: a slot starting exactly now cannot be booked. */
  it("counts the current minute as gone", () => {
    assert.equal(isPastSlot("2026-09-22", 14 * 60 + 30, now), true);
    assert.equal(isPastSlot("2026-09-22", 14 * 60 + 31, now), false);
  });
});
