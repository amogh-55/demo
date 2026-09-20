import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  adminLoginSchema,
  bookingSubmitSchema,
  customerNameSchema,
  phoneSchema,
  settingsSchema,
  slotConfigSchema,
} from "../src/lib/validation";
import { normaliseWhatsappNumber, confirmationMessage, rejectionMessage, whatsappUrl } from "../src/lib/whatsapp";

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

  it("requires a payment screenshot key", () => {
    assert.equal(bookingSubmitSchema.safeParse({ ...valid, paymentScreenshotKey: "" }).success, false);
    assert.equal(bookingSubmitSchema.safeParse({ ...valid, paymentScreenshotKey: undefined }).success, false);
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

describe("schedule configuration", () => {
  const base = {
    slotMinutes: 60,
    openMin: 6 * 60,
    closeMin: 23 * 60,
    priceRules: [{ fromMin: 6 * 60, toMin: 23 * 60, price: 800 }],
    bookingWindowDays: 30,
    holdMinutes: 10,
  };

  it("accepts a sane configuration", () => {
    assert.equal(slotConfigSchema.parse(base).slotMinutes, 60);
  });

  it("rejects closing before opening", () => {
    assert.equal(slotConfigSchema.safeParse({ ...base, closeMin: 5 * 60 }).success, false);
  });

  it("rejects hours that do not divide into whole slots", () => {
    assert.equal(slotConfigSchema.safeParse({ ...base, closeMin: 22 * 60 + 30 }).success, false);
  });

  it("requires at least one price band", () => {
    assert.equal(slotConfigSchema.safeParse({ ...base, priceRules: [] }).success, false);
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
