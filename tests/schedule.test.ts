import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildDayTemplate, priceForStart, resolveUnits, totalPrice } from "../src/lib/booking/schedule";
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
