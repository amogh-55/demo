import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  applyBallPricing,
  buildDayTemplate,
  isWeekendRate,
  hoursTouched,
  minutesForOvers,
  oversLadder,
  priceForStart,
  resolveUnits,
  runIsFree,
  slotsForOvers,
  totalPrice,
} from "../src/lib/booking/schedule";
import { istWeekday } from "../src/lib/time";
import { generateBookingReference, generateHoldToken, hashHoldToken } from "../src/lib/booking/reference";

const CONFIG = {
  openMin: 17 * 60, // 5 PM
  closeMin: 21 * 60, // 9 PM
  slotMinutes: 60,
  priceRules: [
    { fromMin: 17 * 60, toMin: 19 * 60, price: 800 },
    { fromMin: 19 * 60, toMin: 21 * 60, price: 900 },
  ],
};

describe("slot template", () => {
  it("splits the operating window into atomic units", () => {
    const template = buildDayTemplate(CONFIG);
    assert.deepEqual(
      template.map((u) => [u.startMin, u.endMin, u.price]),
      [
        [1020, 1080, 800],
        [1080, 1140, 800],
        [1140, 1200, 900],
        [1200, 1260, 900],
      ],
    );
  });

  it("never emits a unit that runs past closing time", () => {
    const template = buildDayTemplate({ ...CONFIG, closeMin: 20 * 60 + 30 });
    assert.equal(template.at(-1)!.endMin, 20 * 60);
  });

  it("omits time no price band covers, so it cannot be sold by accident", () => {
    const template = buildDayTemplate({ ...CONFIG, priceRules: [{ fromMin: 17 * 60, toMin: 19 * 60, price: 800 }] });
    assert.equal(template.length, 2);
    assert.equal(priceForStart(CONFIG.priceRules, 16 * 60), null);
  });

  it("prices a unit from the band containing its start", () => {
    assert.equal(priceForStart(CONFIG.priceRules, 17 * 60), 800);
    assert.equal(priceForStart(CONFIG.priceRules, 19 * 60), 900); // band boundary is half-open
  });
});

describe("resolving a requested range into units", () => {
  const template = buildDayTemplate(CONFIG);

  it("resolves a single hour", () => {
    const units = resolveUnits(template, 1020, 1080);
    assert.equal(units?.length, 1);
    assert.equal(totalPrice(units!), 800);
  });

  it("resolves multi-hour ranges into every underlying unit", () => {
    assert.equal(resolveUnits(template, 1020, 1140)?.length, 2); // 5–7
    assert.equal(resolveUnits(template, 1020, 1260)?.length, 4); // 5–9
    assert.equal(totalPrice(resolveUnits(template, 1020, 1260)!), 800 + 800 + 900 + 900);
  });

  it("sums the component prices rather than using a duration price", () => {
    // 6–8 PM straddles two bands: one hour at 800 and one at 900.
    assert.equal(totalPrice(resolveUnits(template, 1080, 1200)!), 1700);
  });

  it("rejects ranges that do not line up with the schedule", () => {
    assert.equal(resolveUnits(template, 1050, 1110), null); // starts mid-slot
    assert.equal(resolveUnits(template, 1020, 1110), null); // ends mid-slot
    assert.equal(resolveUnits(template, 1020, 1020), null); // zero length
    assert.equal(resolveUnits(template, 1140, 1080), null); // backwards
    assert.equal(resolveUnits(template, 1020, 1320), null); // past closing time
    assert.equal(resolveUnits(template, 960, 1080), null); // before opening time
  });

  it("treats intervals as half-open so adjacent bookings do not overlap", () => {
    const first = resolveUnits(template, 1020, 1140)!; // 5–7
    const second = resolveUnits(template, 1140, 1260)!; // 7–9
    const firstStarts = new Set(first.map((u) => u.startMin));
    assert.ok(second.every((u) => !firstStarts.has(u.startMin)), "[5,7) and [7,9) must not share a unit");
  });

  it("detects overlap between 5–7 and 6–8 as a shared unit", () => {
    const a = resolveUnits(template, 1020, 1140)!; // 5–7
    const b = resolveUnits(template, 1080, 1200)!; // 6–8
    const shared = a.filter((u) => b.some((other) => other.startMin === u.startMin));
    assert.equal(shared.length, 1);
    assert.equal(shared[0]!.startMin, 1080); // the 6–7 hour
  });
});

describe("identifiers", () => {
  it("generates readable references without ambiguous characters", () => {
    for (let i = 0; i < 200; i += 1) {
      const reference = generateBookingReference();
      assert.match(reference, /^TURF-[2-9A-HJ-NP-Z]{6}$/);
      assert.ok(!/[01ILO]/.test(reference.slice(5)), "must avoid 0/1/I/L/O");
    }
  });

  it("produces references that do not collide in practice", () => {
    const seen = new Set(Array.from({ length: 5000 }, generateBookingReference));
    assert.ok(seen.size > 4990, `expected near-unique references, got ${seen.size}/5000`);
  });

  it("issues unguessable hold tokens and stores only their hash", () => {
    const token = generateHoldToken();
    assert.equal(token.length, 64); // 256 bits of entropy
    assert.notEqual(hashHoldToken(token), token);
    assert.equal(hashHoldToken(token), hashHoldToken(token));
    assert.notEqual(hashHoldToken(token), hashHoldToken(generateHoldToken()));
  });
});

/* ── The overs/quarter-hour arithmetic behind the bowling grid ───────────── */

describe("overs and duration", () => {
  it("turns whole blocks of overs into slots", () => {
    assert.equal(slotsForOvers(10, 10), 1);
    assert.equal(slotsForOvers(10, 40), 4);
    assert.equal(slotsForOvers(10, 70), 7);
    assert.equal(slotsForOvers(10, 200), 20);
  });

  /**
   * The owner wants no ceiling, so there is none here — 500 overs resolves
   * perfectly well and is only refused later, by the clock, when its slots run
   * past closing time.
   */
  it("puts no upper limit on a session", () => {
    assert.equal(slotsForOvers(10, 500), 50);
  });

  /** Half a block cannot be reserved, so it is not a bookable amount. */
  it("refuses overs that are not a whole number of blocks", () => {
    for (const overs of [0, 5, 15, 25, 33, -10, 10.5]) {
      assert.equal(slotsForOvers(10, overs), null, `${overs} overs must not resolve`);
    }
  });

  it("converts overs to minutes on the machine", () => {
    assert.equal(minutesForOvers(10, 15, 10), 15);
    assert.equal(minutesForOvers(10, 15, 40), 60);
    assert.equal(minutesForOvers(10, 15, 70), 105);
    assert.equal(minutesForOvers(10, 15, 25), null);
  });

  it("generates a ladder limited only by the length of the day", () => {
    // 6 AM to 11 PM in quarter-hours is 68 blocks.
    const ladder = oversLadder(10, 15, 6 * 60, 23 * 60);
    assert.deepEqual(ladder.slice(0, 4), [10, 20, 30, 40]);
    assert.equal(ladder.at(-1), 680);
  });
});

describe("ball pricing", () => {
  const synthetic = { id: "synthetic", name: "Synthetic", pricePerSlot: 180 };

  /**
   * The owner's words: ₹180 for 10 overs, ₹360 for 20. Each block costs one ball
   * price, and nothing is pro-rated by the clock.
   */
  it("charges one ball price per block", () => {
    const units = [
      { startMin: 1080, endMin: 1095, price: 0 },
      { startMin: 1095, endMin: 1110, price: 0 },
    ];
    const priced = applyBallPricing(units, synthetic);
    assert.deepEqual(priced.map((u) => u.price), [180, 180]);
    assert.equal(totalPrice(priced), 360, "20 overs is two blocks at 180");
  });

  it("scales with the number of blocks, with no rounding to go wrong", () => {
    const units = Array.from({ length: 7 }, (_, i) => ({
      startMin: 1080 + i * 15,
      endMin: 1095 + i * 15,
      price: 0,
    }));
    assert.equal(totalPrice(applyBallPricing(units, synthetic)), 1260, "70 overs is seven blocks");
  });
});

describe("whether a session fits at a start time", () => {
  const free = (...starts: number[]) => new Set(starts);

  it("accepts a run that is entirely free", () => {
    assert.equal(runIsFree(15, free(1080, 1095, 1110, 1125), 1080, 4), true);
  });

  /**
   * The case the grid exists to show: 6:00 is free, but 6:30 is not, so a
   * customer may start a 10 or 20 over session there and nothing longer.
   */
  it("refuses a run that crosses a taken quarter", () => {
    const starts = free(1080, 1095, 1125); // 6:30 missing
    assert.equal(runIsFree(15, starts, 1080, 2), true);
    assert.equal(runIsFree(15, starts, 1080, 3), false);
    assert.equal(runIsFree(15, starts, 1080, 4), false);
  });

  it("refuses anything from a quarter that is itself taken", () => {
    assert.equal(runIsFree(15, free(1095, 1110), 1080, 1), false);
  });

  it("refuses a run that would continue past the end of the day", () => {
    assert.equal(runIsFree(15, free(1365), 1365, 1), true);
    assert.equal(runIsFree(15, free(1365), 1365, 2), false);
  });
});

describe("hours a session touches", () => {
  it("is just its own hour when it fits inside one", () => {
    assert.deepEqual(hoursTouched(6 * 60, 6 * 60 + 30), [6 * 60]);
    assert.deepEqual(hoursTouched(6 * 60 + 45, 7 * 60), [6 * 60]);
  });

  /** 60 overs from 6:45 runs to 8:15, so the picker must open 6, 7 and 8. */
  it("covers every hour a long session runs into", () => {
    assert.deepEqual(hoursTouched(6 * 60 + 45, 8 * 60 + 15), [6 * 60, 7 * 60, 8 * 60]);
    assert.deepEqual(hoursTouched(6 * 60, 8 * 60), [6 * 60, 7 * 60]);
  });

  it("returns nothing for an empty or backwards range", () => {
    assert.deepEqual(hoursTouched(600, 600), []);
    assert.deepEqual(hoursTouched(660, 600), []);
  });
});

describe("weekend pricing", () => {
  const base = {
    openMin: 6 * 60,
    closeMin: 10 * 60,
    slotMinutes: 60,
    priceRules: [{ fromMin: 6 * 60, toMin: 10 * 60, price: 700 }],
    weekendPriceRules: [{ fromMin: 6 * 60, toMin: 10 * 60, price: 1000 }],
    weekendDays: [5, 6, 0],
  };

  // 2026-09-19 is a Saturday, 2026-09-22 a Tuesday, 2026-09-18 a Friday.
  const SATURDAY = "2026-09-19";
  const TUESDAY = "2026-09-22";
  const FRIDAY = "2026-09-18";
  const SUNDAY = "2026-09-20";

  it("charges the weekday price on a weekday", () => {
    const day = buildDayTemplate(base, TUESDAY);
    assert.ok(day.every((u) => u.price === 700));
  });

  it("charges the weekend price on the days the owner named", () => {
    for (const date of [FRIDAY, SATURDAY, SUNDAY]) {
      const day = buildDayTemplate(base, date);
      assert.ok(day.every((u) => u.price === 1000), `${date} should be a weekend`);
    }
  });

  it("charges one price all week when no weekend table is set", () => {
    const flat = { ...base, weekendPriceRules: [] };
    assert.ok(buildDayTemplate(flat, SATURDAY).every((u) => u.price === 700));
    assert.ok(buildDayTemplate(flat, TUESDAY).every((u) => u.price === 700));
  });

  it("falls back to weekday prices when no date is given", () => {
    assert.ok(buildDayTemplate(base).every((u) => u.price === 700));
  });

  it("honours an unusual week — a ground busy on Wednesdays", () => {
    const midweek = { ...base, weekendDays: [3] };
    assert.ok(buildDayTemplate(midweek, "2026-09-23").every((u) => u.price === 1000), "Wednesday");
    assert.ok(buildDayTemplate(midweek, SATURDAY).every((u) => u.price === 700), "Saturday is normal here");
  });

  /** An old facility document has neither field at all, and must keep working. */
  it("prices a configuration saved before weekends existed", () => {
    const legacy = { openMin: 6 * 60, closeMin: 10 * 60, slotMinutes: 60, priceRules: base.priceRules };
    assert.ok(buildDayTemplate(legacy as never, SATURDAY).every((u) => u.price === 700));
    assert.equal(isWeekendRate(legacy as never, SATURDAY), false);
  });

  it("knows which dates are charged at weekend rates", () => {
    assert.equal(isWeekendRate(base, SATURDAY), true);
    assert.equal(isWeekendRate(base, TUESDAY), false);
    assert.equal(isWeekendRate({ ...base, weekendPriceRules: [] }, SATURDAY), false);
  });

  it("reads the weekday off the business date, not the server's clock", () => {
    // Late on a Friday night in IST it is still Friday, whatever UTC says.
    assert.equal(istWeekday("2026-09-18"), 5);
    assert.equal(istWeekday("2026-09-19"), 6);
    assert.equal(istWeekday("2026-09-20"), 0);
  });

  it("can price different hours differently on each table", () => {
    const split = {
      ...base,
      closeMin: 22 * 60,
      priceRules: [
        { fromMin: 6 * 60, toMin: 17 * 60, price: 700 },
        { fromMin: 17 * 60, toMin: 22 * 60, price: 900 },
      ],
      weekendPriceRules: [
        { fromMin: 6 * 60, toMin: 17 * 60, price: 800 },
        { fromMin: 17 * 60, toMin: 22 * 60, price: 1200 },
      ],
    };
    const saturday = buildDayTemplate(split, SATURDAY);
    assert.equal(saturday.find((u) => u.startMin === 10 * 60)!.price, 800);
    assert.equal(saturday.find((u) => u.startMin === 19 * 60)!.price, 1200);
    const tuesday = buildDayTemplate(split, TUESDAY);
    assert.equal(tuesday.find((u) => u.startMin === 19 * 60)!.price, 900);
  });
});
