import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  adminBookingCreateSchema,
  adminLoginSchema,
  addPaymentSchema,
  bookingSubmitSchema,
  customerNameSchema,
  phoneSchema,
  settingsSchema,
  facilityConfigSchema,
  locationCreateSchema,
  utrSchema,
} from "../src/lib/validation";
import { normaliseWhatsappNumber, confirmationMessage, rejectionMessage, whatsappUrl } from "../src/lib/whatsapp";
import { readJson } from "../src/lib/api";

describe("phone numbers", () => {
  it("normalises the formats Indian customers actually type", () => {
    for (const input of ["9876543210", "+919876543210", "91 98765 43210", "098765 43210", "+91-98765-43210", "(98765) 43210"]) {
      assert.equal(phoneSchema.parse(input), "9876543210", `failed for ${input}`);
    }
  });

  it("rejects numbers that cannot be Indian mobiles", () => {
    for (const input of ["1234567890", "5876543210", "98765", "98765432101", "abcdefghij", ""]) {
      assert.equal(phoneSchema.safeParse(input).success, false, `should reject ${input}`);
    }
  });
});

describe("customer name", () => {
  it("accepts real names including initials and accents", () => {
    for (const name of ["Ravi Kumar", "A. R. Rahman", "O'Brien", "José García", "Sai-Krishna"]) {
      assert.equal(customerNameSchema.parse(name), name);
    }
  });

  it("rejects empty, oversized and script-like input", () => {
    for (const name of ["", "R", "<script>alert(1)</script>", "x".repeat(61)]) {
      assert.equal(customerNameSchema.safeParse(name).success, false, `should reject ${name}`);
    }
  });
});

describe("booking submission payload", () => {
  const valid = {
    holdToken: "a".repeat(64),
    customerName: "Ravi Kumar",
    customerPhone: "9876543210",
    // The shape the upload route actually mints: dated folder + UUID + real extension.
    paymentScreenshotKey: "payment-screenshots/2026-10-10/3f1b9c2a-7d64-4e51-9a0b-2c8e5d7f4a13.jpg",
  };

  it("accepts a well-formed submission", () => {
    assert.equal(bookingSubmitSchema.parse(valid).customerPhone, "9876543210");
  });

  it("ignores any amount the client tries to send", () => {
    const parsed = bookingSubmitSchema.parse({ ...valid, amount: 1, status: "CONFIRMED", paymentVerificationStatus: "VERIFIED" });
    assert.equal("amount" in parsed, false, "client-supplied amount must never survive validation");
    assert.equal("status" in parsed, false, "client-supplied status must never survive validation");
  });

  it("rejects a missing or stubby hold token", () => {
    assert.equal(bookingSubmitSchema.safeParse({ ...valid, holdToken: "short" }).success, false);
    assert.equal(bookingSubmitSchema.safeParse({ ...valid, holdToken: undefined }).success, false);
  });

  /**
   * A missing key is allowed here because a short bowling session is paid for at
   * the ground. Whether THIS booking may skip it is decided server-side from the
   * hold, so leaving it out never makes a booking free by itself.
   */
  it("allows no screenshot at all, for pay-at-the-ground bookings", () => {
    const parsed = bookingSubmitSchema.parse({ ...valid, paymentScreenshotKey: undefined });
    assert.equal(parsed.paymentScreenshotKey, null);
    assert.equal(bookingSubmitSchema.parse({ ...valid, paymentScreenshotKey: null }).paymentScreenshotKey, null);
  });

  it("still rejects a key that is present but malformed", () => {
    assert.equal(bookingSubmitSchema.safeParse({ ...valid, paymentScreenshotKey: "" }).success, false);
    assert.equal(bookingSubmitSchema.safeParse({ ...valid, paymentScreenshotKey: "nonsense.jpg" }).success, false);
  });

  /**
   * Storage keys are minted by the server. A browser that invents one would
   * produce a booking with no screenshot behind it, leaving the admin nothing to
   * verify — so only the real shape is accepted.
   */
  it("rejects a screenshot key the client made up", () => {
    for (const key of [
      "payment-screenshots/2026-10-10/abc.jpg",
      "../../../../etc/passwd",
      "payment-screenshots/../../.env",
      "/etc/passwd",
      "payment-screenshots/2026-10-10/3f1b9c2a-7d64-4e51-9a0b-2c8e5d7f4a13.exe",
      "payment-screenshots/20261010/3f1b9c2a-7d64-4e51-9a0b-2c8e5d7f4a13.jpg",
      "some-other-prefix/2026-10-10/3f1b9c2a-7d64-4e51-9a0b-2c8e5d7f4a13.jpg",
    ]) {
      assert.equal(
        bookingSubmitSchema.safeParse({ ...valid, paymentScreenshotKey: key }).success,
        false,
        `forged key must be refused: ${key}`,
      );
    }
  });

  it("accepts every extension the uploader can produce", () => {
    for (const ext of ["jpg", "png", "webp"]) {
      const key = `payment-screenshots/2026-10-10/3f1b9c2a-7d64-4e51-9a0b-2c8e5d7f4a13.${ext}`;
      assert.equal(bookingSubmitSchema.safeParse({ ...valid, paymentScreenshotKey: key }).success, true, ext);
    }
  });
});

describe("facility configuration", () => {
  const base = {
    slotMinutes: 60,
    openMin: 6 * 60,
    closeMin: 23 * 60,
    priceRules: [{ fromMin: 6 * 60, toMin: 23 * 60, price: 800 }],
    bookingWindowDays: 30,
    holdMinutes: 5,
    oversPerSlot: 0,
    payAtVenueMaxOvers: 0,
    ballTypes: [],
  };

  const bowling = {
    ...base,
    slotMinutes: 15,
    priceRules: [{ fromMin: 6 * 60, toMin: 23 * 60, price: 0 }],
    oversPerSlot: 10,
    payAtVenueMaxOvers: 40,
    ballTypes: [{ id: "synthetic", name: "Synthetic ball", pricePerSlot: 180 }],
  };

  it("accepts a sane configuration", () => {
    assert.equal(facilityConfigSchema.parse(base).slotMinutes, 60);
  });

  it("rejects closing before opening", () => {
    assert.equal(facilityConfigSchema.safeParse({ ...base, closeMin: 5 * 60 }).success, false);
  });

  it("rejects hours that do not divide into whole slots", () => {
    assert.equal(facilityConfigSchema.safeParse({ ...base, closeMin: 22 * 60 + 30 }).success, false);
  });

  it("requires at least one price band", () => {
    assert.equal(facilityConfigSchema.safeParse({ ...base, priceRules: [] }).success, false);
  });

  it("accepts a bowling configuration", () => {
    const parsed = facilityConfigSchema.parse(bowling);
    assert.equal(parsed.oversPerSlot, 10);
    assert.equal(parsed.payAtVenueMaxOvers, 40);
  });

  /**
   * A pay-at-the-ground limit of 45 on ten-over blocks could never be reached
   * exactly: the customer books 40 or 50, so the rule would silently mean 40 and
   * the owner would have set a number that does nothing.
   */
  it("rejects a pay-at-the-ground limit that is not a whole number of blocks", () => {
    assert.equal(facilityConfigSchema.safeParse({ ...bowling, payAtVenueMaxOvers: 45 }).success, false);
  });

  it("accepts 0, meaning every session pays online", () => {
    assert.equal(facilityConfigSchema.parse({ ...bowling, payAtVenueMaxOvers: 0 }).payAtVenueMaxOvers, 0);
  });

  it("rejects two ball types sharing an id", () => {
    const broken = {
      ...bowling,
      ballTypes: [
        { id: "synthetic", name: "Synthetic", pricePerSlot: 180 },
        { id: "synthetic", name: "Also synthetic", pricePerSlot: 100 },
      ],
    };
    assert.equal(facilityConfigSchema.safeParse(broken).success, false);
  });
});

describe("maps links", () => {
  /** A javascript: URL in this field would run in every customer's browser. */
  it("refuses a link that is not http or https", () => {
    for (const mapsUrl of ["javascript:alert(1)", "data:text/html,<script>", "maps.google.com"]) {
      const result = locationCreateSchema.safeParse({
        name: "Test Ground",
        slug: "test-ground",
        address: "Somewhere in Hyderabad",
        phone: "9876543210",
        mapsUrl,
      });
      assert.equal(result.success, false, `should reject ${mapsUrl}`);
    }
  });

  it("accepts a real Google Maps link, and blank", () => {
    for (const mapsUrl of ["https://maps.app.goo.gl/abc123", ""]) {
      const result = locationCreateSchema.safeParse({
        name: "Test Ground",
        slug: "test-ground",
        address: "Somewhere in Hyderabad",
        phone: "9876543210",
        mapsUrl,
      });
      assert.equal(result.success, true, `should accept "${mapsUrl}"`);
    }
  });
});

describe("settings and login", () => {
  it("validates UPI identifiers", () => {
    assert.equal(settingsSchema.safeParse({
      businessName: "Turf",
      supportPhone: "9876543210",
      whatsappNumber: "9876543210",
      upiId: "turf@okicici",
      upiPayeeName: "Turf Arena",
      upiQrImageUrl: "",
    }).success, true);

    assert.equal(settingsSchema.safeParse({
      businessName: "Turf",
      supportPhone: "9876543210",
      whatsappNumber: "9876543210",
      upiId: "not-a-upi-id",
      upiPayeeName: "Turf Arena",
      upiQrImageUrl: "",
    }).success, false);
  });

  /** It ends up in an <img src> on the payment screen, so it is a link or nothing. */
  it("refuses a UPI QR image that is not an http link", () => {
    const base = {
      businessName: "Turf",
      supportPhone: "9876543210",
      whatsappNumber: "9876543210",
      upiId: "turf@okicici",
      upiPayeeName: "Turf Arena",
    };
    for (const upiQrImageUrl of ["javascript:alert(1)", "data:text/html,<script>", "not a url"]) {
      assert.equal(settingsSchema.safeParse({ ...base, upiQrImageUrl }).success, false, upiQrImageUrl);
    }
    for (const upiQrImageUrl of ["https://cdn.example.com/qr.png", ""]) {
      assert.equal(settingsSchema.safeParse({ ...base, upiQrImageUrl }).success, true, `"${upiQrImageUrl}"`);
    }
  });

  it("requires a password long enough to be worth hashing", () => {
    assert.equal(adminLoginSchema.safeParse({ username: "owner", password: "short" }).success, false);
    assert.equal(adminLoginSchema.safeParse({ username: "owner", password: "a-long-enough-password" }).success, true);
  });
});

describe("WhatsApp links", () => {
  const booking = {
    businessName: "Greenfield Turf",
    reference: "TURF-7K92AB",
    customerName: "Ravi",
    locationName: "Uppal",
    date: "2026-10-10",
    startMin: 17 * 60,
    endMin: 19 * 60,
    amount: 1600,
    supportPhone: "9876543210",
  };

  it("normalises numbers to wa.me format", () => {
    assert.equal(normaliseWhatsappNumber("9876543210"), "919876543210");
    assert.equal(normaliseWhatsappNumber("+91 98765 43210"), "919876543210");
    assert.equal(normaliseWhatsappNumber("919876543210"), "919876543210");
  });

  it("builds a pre-filled click-to-chat URL", () => {
    const url = whatsappUrl("9876543210", "Hello & welcome");
    assert.ok(url.startsWith("https://wa.me/919876543210?text="));
    assert.ok(url.includes("Hello%20%26%20welcome"), "message must be URL-encoded");
  });

  it("includes the details a customer needs in the confirmation", () => {
    const message = confirmationMessage(booking);
    assert.ok(message.includes("TURF-7K92AB"));
    assert.ok(message.includes("5:00 PM – 7:00 PM"));
    assert.ok(message.includes("₹1,600"));
    assert.ok(message.includes("Sat, 10 Oct 2026"));
  });

  it("states the reason in the rejection message", () => {
    const message = rejectionMessage({ ...booking, reason: "Payment not received" });
    assert.ok(message.includes("could not be confirmed"));
    assert.ok(message.includes("Payment not received"));
  });
});

describe("UPI reference numbers", () => {
  it("accepts the 12 digits people copy out of a payment app", () => {
    for (const input of ["123456789012", " 123456789012 ", "1234 5678 9012", "1234-5678-9012"]) {
      assert.equal(utrSchema.parse(input), "123456789012", `failed for ${input}`);
    }
  });

  it("rejects anything that is not 12 digits", () => {
    for (const input of ["", "12345678901", "1234567890123", "12345678901a", "abcdefghijkl"]) {
      assert.equal(utrSchema.safeParse(input).success, false, `should reject ${input}`);
    }
  });

  it("lets a booking through without a screenshot, but keeps the reference", () => {
    const parsed = bookingSubmitSchema.parse({
      holdToken: "t".repeat(40),
      customerName: "Ravi Kumar",
      customerPhone: "9876543210",
      utr: "123456789012",
    });
    assert.equal(parsed.paymentScreenshotKey, null);
    assert.equal(parsed.utr, "123456789012");
  });

  it("refuses a balance payment with no reference behind it", () => {
    assert.equal(addPaymentSchema.safeParse({ paymentScreenshotKey: null }).success, false);
    assert.equal(addPaymentSchema.parse({ utr: "123456789012" }).utr, "123456789012");
  });
});

describe("bookings taken over the telephone", () => {
  const base = {
    resourceId: "000000000000000000000021",
    date: new Date(Date.now() + 5 * 86_400_000).toISOString().slice(0, 10),
    startMin: 1020,
    endMin: 1080,
    customerName: "Phone Caller",
    customerPhone: "98765 43210",
  };

  it("takes the customer's details in the formats a person says them", () => {
    const parsed = adminBookingCreateSchema.parse(base);
    assert.equal(parsed.customerPhone, "9876543210");
    assert.equal(parsed.amountPaid, 0, "collect at the ground unless the owner says otherwise");
  });

  it("refuses a negative collection or a number that is not a mobile", () => {
    assert.equal(adminBookingCreateSchema.safeParse({ ...base, amountPaid: -1 }).success, false);
    assert.equal(adminBookingCreateSchema.safeParse({ ...base, customerPhone: "12345" }).success, false);
  });

  /** No price field exists at all: the schedule decides, so there is nothing to tamper with. */
  it("has no way to state a price", () => {
    const parsed: Record<string, unknown> = adminBookingCreateSchema.parse({ ...base, amount: 1, price: 1 });
    assert.equal(parsed.amount, undefined);
    assert.equal(parsed.price, undefined);
  });
});

describe("weekend price bands", () => {
  const base = {
    slotMinutes: 60,
    openMin: 6 * 60,
    closeMin: 22 * 60,
    priceRules: [{ fromMin: 6 * 60, toMin: 22 * 60, price: 700 }],
    bookingWindowDays: 30,
    holdMinutes: 5,
  };

  it("defaults to one price all week", () => {
    const parsed = facilityConfigSchema.parse(base);
    assert.deepEqual(parsed.weekendPriceRules, []);
    assert.deepEqual(parsed.weekendDays, [5, 6, 0], "Friday to Sunday, as the grounds around here charge");
  });

  it("accepts a weekend table covering the same hours", () => {
    const parsed = facilityConfigSchema.parse({
      ...base,
      weekendPriceRules: [{ fromMin: 6 * 60, toMin: 22 * 60, price: 1000 }],
      weekendDays: [6, 0],
    });
    assert.equal(parsed.weekendPriceRules[0]!.price, 1000);
    assert.deepEqual(parsed.weekendDays, [6, 0]);
  });

  /** A gap here would make part of a Saturday silently unbookable. */
  it("refuses a weekend table that leaves hours unpriced", () => {
    const result = facilityConfigSchema.safeParse({
      ...base,
      weekendPriceRules: [{ fromMin: 6 * 60, toMin: 12 * 60, price: 1000 }],
    });
    assert.equal(result.success, false);
  });

  it("refuses weekend prices with no days to apply to", () => {
    const result = facilityConfigSchema.safeParse({
      ...base,
      weekendPriceRules: [{ fromMin: 6 * 60, toMin: 22 * 60, price: 1000 }],
      weekendDays: [],
    });
    assert.equal(result.success, false);
  });

  it("refuses a day listed twice, or a day that is not a day", () => {
    assert.equal(facilityConfigSchema.safeParse({ ...base, weekendDays: [6, 6] }).success, false);
    assert.equal(facilityConfigSchema.safeParse({ ...base, weekendDays: [7] }).success, false);
    assert.equal(facilityConfigSchema.safeParse({ ...base, weekendDays: [-1] }).success, false);
  });

  it("refuses a negative weekend price", () => {
    const result = facilityConfigSchema.safeParse({
      ...base,
      weekendPriceRules: [{ fromMin: 6 * 60, toMin: 22 * 60, price: -100 }],
    });
    assert.equal(result.success, false);
  });
});

describe("request bodies", () => {
  const post = (body: string, headers: Record<string, string> = {}) =>
    new Request("http://localhost/api/holds", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body,
    });

  it("reads an ordinary body", async () => {
    assert.deepEqual(await readJson(post(JSON.stringify({ hello: "world" }))), { hello: "world" });
  });

  /**
   * All of these parse. The danger is what happens next: a route that reads a
   * field off the result crashes with a 500, which reads as our bug rather than
   * as a refusal.
   */
  it("refuses valid JSON that is not an object", async () => {
    for (const body of ["null", "[]", '"hello"', "42", "true"]) {
      await assert.rejects(readJson(post(body)), /Malformed request/, `should refuse ${body}`);
    }
  });

  it("refuses malformed JSON without leaking the parser error", async () => {
    await assert.rejects(readJson(post("{ not json")), /Malformed request/);
  });

  /**
   * Nothing this API accepts is large. Parsing a megabyte before validating it
   * spends the server's memory on a request that was never going to be valid,
   * which is free for whoever sends it and not for us.
   */
  it("refuses a body far larger than anything it accepts", async () => {
    const huge = JSON.stringify({ padding: "x".repeat(64 * 1024) });
    await assert.rejects(readJson(post(huge)), /too large/i);
  });

  it("refuses an oversized body even when the length is not declared", async () => {
    const huge = JSON.stringify({ padding: "x".repeat(64 * 1024) });
    const request = new Request("http://localhost/api/holds", { method: "POST", body: huge });
    // Strip the length the constructor worked out, so only the read-side guard is left.
    request.headers.delete("content-length");
    await assert.rejects(readJson(request), /too large/i);
  });
});
