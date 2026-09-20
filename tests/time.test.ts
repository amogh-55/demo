import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  daysFromToday,
  formatBusinessDate,
  formatCompactRange,
  formatMinutes,
  formatRange,
  istDateString,
  istInstant,
  istMinutesOfDay,
  isValidBusinessDate,
  minutesToDuration,
} from "../src/lib/time";

describe("IST business time", () => {
  it("reads the business date from a UTC instant", () => {
    // 2026-10-10T18:30:00Z is exactly midnight IST on the 11th.
    assert.equal(istDateString(new Date("2026-10-10T18:30:00Z")), "2026-10-11");
    assert.equal(istDateString(new Date("2026-10-10T18:29:59Z")), "2026-10-10");
  });

  it("reads minutes of day in IST, not UTC", () => {
    assert.equal(istMinutesOfDay(new Date("2026-10-10T11:30:00Z")), 17 * 60); // 5:00 PM IST
    assert.equal(istMinutesOfDay(new Date("2026-10-10T18:30:00Z")), 0); // midnight IST
  });

  it("converts a business date and minute back to the right UTC instant", () => {
    assert.equal(istInstant("2026-10-10", 17 * 60).toISOString(), "2026-10-10T11:30:00.000Z");
    assert.equal(istInstant("2026-10-10", 0).toISOString(), "2026-10-09T18:30:00.000Z");
  });

  it("round-trips date and minute through the instant", () => {
    for (const minute of [0, 330, 719, 1020, 1439]) {
      const instant = istInstant("2026-03-01", minute);
      assert.equal(istDateString(instant), "2026-03-01");
      assert.equal(istMinutesOfDay(instant), minute);
    }
  });

  it("rejects impossible calendar dates", () => {
    assert.equal(isValidBusinessDate("2026-02-30"), false);
    assert.equal(isValidBusinessDate("2026-13-01"), false);
    assert.equal(isValidBusinessDate("2026-1-1"), false);
    assert.equal(isValidBusinessDate("not-a-date"), false);
    assert.equal(isValidBusinessDate("2026-02-28"), true);
    assert.equal(isValidBusinessDate("2028-02-29"), true); // leap year
  });

  it("measures whole days from today regardless of the current IST hour", () => {
    const lateEvening = new Date("2026-09-19T17:00:00Z"); // 10:30 PM IST on the 19th
    assert.equal(daysFromToday("2026-09-19", lateEvening), 0);
    assert.equal(daysFromToday("2026-09-18", lateEvening), -1);
    assert.equal(daysFromToday("2026-10-19", lateEvening), 30);

    const justAfterIstMidnight = new Date("2026-09-19T18:35:00Z"); // 12:05 AM IST on the 20th
    assert.equal(daysFromToday("2026-09-20", justAfterIstMidnight), 0);
    assert.equal(daysFromToday("2026-09-19", justAfterIstMidnight), -1);
  });

  it("formats times for humans", () => {
    assert.equal(formatMinutes(0), "12:00 AM");
    assert.equal(formatMinutes(12 * 60), "12:00 PM");
    assert.equal(formatMinutes(17 * 60), "5:00 PM");
    assert.equal(formatMinutes(23 * 60 + 30), "11:30 PM");
    assert.equal(formatRange(17 * 60, 19 * 60), "5:00 PM – 7:00 PM");
    assert.equal(formatBusinessDate("2026-10-10"), "Sat, 10 Oct 2026");
    assert.equal(minutesToDuration(60), "1 hour");
    assert.equal(minutesToDuration(120), "2 hours");
    assert.equal(minutesToDuration(90), "1h 30m");
  });
});

describe("formatCompactRange", () => {
  it("says the meridiem once when both ends share it", () => {
    assert.equal(formatCompactRange(6 * 60, 7 * 60), "6 – 7 AM");
    assert.equal(formatCompactRange(20 * 60, 21 * 60), "8 – 9 PM");
  });

  it("spells out both sides when the range crosses midday or midnight", () => {
    assert.equal(formatCompactRange(11 * 60, 12 * 60), "11 AM – 12 PM");
    assert.equal(formatCompactRange(23 * 60, 24 * 60), "11 PM – 12 AM");
  });

  it("keeps the minutes when a slot does not start on the hour", () => {
    assert.equal(formatCompactRange(6 * 60 + 30, 7 * 60 + 30), "6:30 – 7:30 AM");
  });

  it("renders midnight as 12, never 0", () => {
    assert.equal(formatCompactRange(0, 60), "12 – 1 AM");
  });
});
