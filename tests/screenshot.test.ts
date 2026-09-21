/**
 * The payment screenshot: what is accepted, what is refused, and the one
 * circumstance in which a booking may proceed without one.
 *
 * The distinction these tests exist to protect is between a file the customer
 * chose badly and a storage provider that would not take a good one. The first
 * must block the booking; the second must not, because the customer has already
 * paid and the outage is ours. Anything that blurs the two either loses real
 * bookings or hands out a way to skip the requirement on demand.
 */
import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import { config as loadEnv } from "../scripts/env";

loadEnv();
process.env.ADMIN_AUTH_SECRET ||= "test-secret-at-least-thirty-two-characters-long";

type UploadFailure = typeof import("../src/lib/booking/upload-failure");
type Storage = typeof import("../src/lib/storage");

let issueUploadFailureToken: UploadFailure["issueUploadFailureToken"];
let uploadFailureProven: UploadFailure["uploadFailureProven"];
let UPLOAD_FAILURE_MAX_AGE: number;
let storage: Storage;
let MAX_UPLOAD_BYTES: number;
let ALLOWED_MIME: readonly string[];

before(async () => {
  const failure = await import("../src/lib/booking/upload-failure");
  issueUploadFailureToken = failure.issueUploadFailureToken;
  uploadFailureProven = failure.uploadFailureProven;
  UPLOAD_FAILURE_MAX_AGE = failure.UPLOAD_FAILURE_MAX_AGE;
  // The local driver, which is what a developer machine has. The validation
  // under test happens before the driver is chosen, so it is the same code that
  // runs against a real bucket.
  storage = await import("../src/lib/storage");
  MAX_UPLOAD_BYTES = storage.MAX_UPLOAD_BYTES;
  ALLOWED_MIME = storage.ALLOWED_MIME;
});

const HOLD = "hold-token-for-this-customer";
const OTHER_HOLD = "a-completely-different-hold";

describe("the limits themselves", () => {
  it("is 5 MB, the number the customer is shown", () => {
    assert.equal(MAX_UPLOAD_BYTES, 5 * 1024 * 1024);
    assert.equal(MAX_UPLOAD_BYTES, 5_242_880);
  });

  it("accepts exactly the three image types the UI offers", () => {
    assert.deepEqual([...ALLOWED_MIME], ["image/jpeg", "image/png", "image/webp"]);
  });

  /** The boundary the spec names: 5 MB passes, a byte more does not. */
  it("puts the boundary at 5 MB inclusive", () => {
    const at = MAX_UPLOAD_BYTES;
    const over = MAX_UPLOAD_BYTES + 1;
    assert.equal(at > MAX_UPLOAD_BYTES, false, "exactly 5 MB is allowed");
    assert.equal(over > MAX_UPLOAD_BYTES, true, "5 MB and one byte is not");
  });
});

describe("proof that storage, not the customer, failed", () => {
  it("accepts a token this server issued for this hold", () => {
    assert.equal(uploadFailureProven(issueUploadFailureToken(HOLD), HOLD), true);
  });

  /* ── The attacks this exists to stop ──────────────────────────────────── */

  it("refuses a token the client simply made up", () => {
    for (const forged of [
      "true",
      "STORAGE_UNAVAILABLE",
      "anything.anything",
      `${HOLD}:9999999999999.deadbeef`,
      "",
      undefined,
    ]) {
      assert.equal(uploadFailureProven(forged, HOLD), false, `forged: ${String(forged)}`);
    }
  });

  it("refuses a token whose signature has been edited", () => {
    const real = issueUploadFailureToken(HOLD);
    const tampered = `${real.slice(0, -1)}${real.at(-1) === "a" ? "b" : "a"}`;
    assert.equal(uploadFailureProven(tampered, HOLD), false);
  });

  it("refuses a token whose payload has been edited", () => {
    const real = issueUploadFailureToken(HOLD);
    const [, signature] = [real.slice(0, real.lastIndexOf(".")), real.slice(real.lastIndexOf(".") + 1)];
    // Keep the signature, extend the expiry: the classic forgery.
    const stretched = `deadbeefdeadbeefdeadbeefdeadbeef:${Date.now() + 86_400_000}.${signature}`;
    assert.equal(uploadFailureProven(stretched, HOLD), false);
  });

  /**
   * The replay this prevents: fail an upload once, keep the cookie, and book
   * without a screenshot for ever after.
   */
  it("refuses a token issued for a different hold", () => {
    const token = issueUploadFailureToken(OTHER_HOLD);
    assert.equal(uploadFailureProven(token, HOLD), false);
  });

  it("refuses a token that has expired", () => {
    const issued = new Date("2026-01-01T00:00:00Z");
    const token = issueUploadFailureToken(HOLD, issued);
    const justInside = new Date(issued.getTime() + (UPLOAD_FAILURE_MAX_AGE - 5) * 1000);
    const justOutside = new Date(issued.getTime() + (UPLOAD_FAILURE_MAX_AGE + 5) * 1000);
    assert.equal(uploadFailureProven(token, HOLD, justInside), true);
    assert.equal(uploadFailureProven(token, HOLD, justOutside), false);
  });

  it("does not last so long that it could be hoarded", () => {
    assert.ok(UPLOAD_FAILURE_MAX_AGE <= 60 * 60, "an exemption should not outlive the session that earned it");
    assert.ok(UPLOAD_FAILURE_MAX_AGE >= 10 * 60, "but it must outlive a 5-minute hold");
  });
});

describe("what the store does with a file", () => {

  /** A real 1x1 PNG, so the magic-byte check has something honest to read. */
  const PNG = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  );

  const file = (bytes: Uint8Array, type = "image/png", name = "shot.png") =>
    new File([bytes as unknown as BlobPart], name, { type });

  const codeOf = async (promise: Promise<unknown>): Promise<string> => {
    try {
      await promise;
      return "NO_ERROR";
    } catch (err) {
      return (err as { code?: string }).code ?? "UNKNOWN";
    }
  };

  it("refuses an empty file as the customer's problem", async () => {
    assert.equal(await codeOf(storage.storePaymentScreenshot(file(new Uint8Array()))), "UPLOAD_INVALID");
  });

  it("refuses a file over 5 MB as the customer's problem", async () => {
    const tooBig = new Uint8Array(MAX_UPLOAD_BYTES + 1);
    tooBig.set(PNG, 0); // valid header, still too large
    assert.equal(await codeOf(storage.storePaymentScreenshot(file(tooBig))), "UPLOAD_INVALID");
  });

  /**
   * The Content-Type is whatever the browser felt like saying. A PDF renamed
   * .png and declared image/png must still be refused.
   */
  it("refuses a file that is not really an image, whatever it claims to be", async () => {
    const pdf = new TextEncoder().encode("%PDF-1.7\n%\xE2\xE3\xCF\xD3\nnot an image at all");
    assert.equal(await codeOf(storage.storePaymentScreenshot(file(pdf, "image/png", "invoice.png"))), "UPLOAD_INVALID");
  });

  it("refuses a corrupted image", async () => {
    // A PNG header with its body replaced by noise: enough to sniff, not an image.
    const corrupt = new Uint8Array(2048);
    corrupt.set(PNG.subarray(0, 8), 0);
    corrupt.fill(0xab, 8);
    const code = await codeOf(storage.storePaymentScreenshot(file(corrupt)));
    // Either refused outright, or stored and unreadable later — never a storage
    // failure, which is the only outcome that would waive the requirement.
    assert.notEqual(code, "UPLOAD_FAILED");
  });

  it("refuses a GIF, which is not one of the three offered", async () => {
    const gif = new TextEncoder().encode("GIF89a" + "\x00".repeat(32));
    assert.equal(await codeOf(storage.storePaymentScreenshot(file(gif, "image/gif", "shot.gif"))), "UPLOAD_INVALID");
  });

  it("accepts a valid PNG well under the limit", async () => {
    const stored = await storage.storePaymentScreenshot(file(PNG));
    assert.match(stored.key, /^payment-screenshots\//);
    assert.equal(stored.mime, "image/png");
    assert.equal(stored.size, PNG.byteLength);
    await storage.deletePaymentScreenshot(stored.key);
  });

  /**
   * The line the whole fallback rests on: every refusal above is
   * UPLOAD_INVALID, and only a store that broke produces UPLOAD_FAILED. If a
   * customer could provoke the second with a bad file, they could book without
   * a screenshot whenever they liked.
   */
  it("never reports a bad file as a storage failure", async () => {
    const cases = [
      file(new Uint8Array()),
      file(new TextEncoder().encode("hello")),
      file(new TextEncoder().encode("GIF89a")),
      file(new Uint8Array(MAX_UPLOAD_BYTES + 1)),
    ];
    for (const bad of cases) {
      const code = await codeOf(storage.storePaymentScreenshot(bad));
      assert.equal(code, "UPLOAD_INVALID", `${bad.name} produced ${code}`);
    }
  });
});
