/**
 * Mobile verification: the code path, the limits, and the proof the browser carries.
 *
 * Needs a database for the challenge store; the cookie tests do not, but they live
 * here because they are the other half of the same mechanism.
 */
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { config as loadEnv } from "../scripts/env";

loadEnv();

const HAS_DB = Boolean(process.env.MONGODB_URI);
process.env.MONGODB_DB = `${process.env.MONGODB_DB || "turf_booking"}_test`;
// The signing key for the verified-phone cookie. Set here so the cookie tests run
// even when the developer's .env.local has not got one.
process.env.ADMIN_AUTH_SECRET ||= "test-secret-at-least-thirty-two-characters-long";

const PHONE = "9876543210";

type Otp = typeof import("../src/lib/otp");
type Collections = typeof import("../src/lib/db")["collections"];
type Db = Awaited<ReturnType<typeof import("../src/lib/db")["getDb"]>>;

let otp: Otp;
let collections: Collections;
let db: Db;
let closeClient: () => Promise<void>;

describe("verified-phone cookie", () => {
  before(async () => {
    otp = await import("../src/lib/otp");
  });

  it("round-trips the number it was issued for", () => {
    const cookie = otp.issueVerifiedPhoneCookie(PHONE);
    assert.equal(otp.readVerifiedPhone(cookie), PHONE);
  });

  /**
   * The whole point of signing it. A client that could write this cookie could
   * book in any number it liked without ever receiving a code.
   */
  it("refuses a cookie this server did not sign", () => {
    for (const forged of [`${PHONE}:${Date.now() + 60_000}`, `${PHONE}:${Date.now() + 60_000}.abc`, "", "junk"]) {
      assert.equal(otp.readVerifiedPhone(forged), null, `forged cookie must not verify: ${forged}`);
    }
  });

  it("refuses a cookie whose number has been swapped", () => {
    const cookie = otp.issueVerifiedPhoneCookie(PHONE);
    const tampered = cookie.replace(PHONE, "9999999999");
    assert.equal(otp.readVerifiedPhone(tampered), null);
  });

  it("stops verifying once it has expired", () => {
    const cookie = otp.issueVerifiedPhoneCookie(PHONE);
    const hoursLater = new Date(Date.now() + (otp.OTP_VERIFIED_MAX_AGE + 60) * 1000);
    assert.equal(otp.readVerifiedPhone(cookie, hoursLater), null);
  });
});

describe("one-time codes", { skip: !HAS_DB }, () => {
  before(async () => {
    const dbModule = await import("../src/lib/db");
    otp = await import("../src/lib/otp");
    collections = dbModule.collections;
    db = await dbModule.getDb();
    closeClient = () => dbModule.getMongoClient().close();
  });

  beforeEach(async () => {
    await collections.otpChallenges(db).deleteMany({});
  });

  after(async () => {
    if (closeClient) await closeClient();
  });

  /** A database dump must not contain anything that can be typed into the form. */
  it("never stores the code itself", async () => {
    await otp.sendOtp(PHONE);
    const challenge = await collections.otpChallenges(db).findOne({ _id: PHONE });
    assert.ok(challenge);
    assert.equal(challenge!.codeHash.length, 64, "stored as a SHA-256 hex digest");
    assert.equal("code" in challenge!, false);
  });

  it("rejects a wrong code and counts the attempt", async () => {
    await otp.sendOtp(PHONE);
    assert.equal(await otp.verifyOtp(PHONE, "000000"), false);
    const challenge = await collections.otpChallenges(db).findOne({ _id: PHONE });
    assert.equal(challenge!.attempts, 1);
  });

  it("gives up after a handful of wrong guesses", async () => {
    await otp.sendOtp(PHONE);
    for (let i = 0; i < 5; i += 1) await otp.verifyOtp(PHONE, "000000");
    await assert.rejects(() => otp.verifyOtp(PHONE, "000000"), /too many wrong codes/i);
    assert.equal(await collections.otpChallenges(db).countDocuments({ _id: PHONE }), 0);
  });

  it("refuses a code for a number with no live challenge", async () => {
    await assert.rejects(() => otp.verifyOtp(PHONE, "123456"), /expired/i);
  });

  it("holds a resend back for the cooldown", async () => {
    await otp.sendOtp(PHONE);
    await assert.rejects(() => otp.sendOtp(PHONE), /wait \d+ seconds/i);
  });

  it("allows a resend once the cooldown has passed, and counts it", async () => {
    const start = new Date();
    await otp.sendOtp(PHONE, start);
    const later = new Date(start.getTime() + 60_000);
    await otp.sendOtp(PHONE, later);

    const challenge = await collections.otpChallenges(db).findOne({ _id: PHONE });
    assert.equal(challenge!.sends, 2);
    assert.equal(challenge!.attempts, 0, "a fresh code gets a fresh run of guesses");
  });

  /** Asking again and again must not buy unlimited attempts at a number. */
  it("stops sending after too many codes in one window", async () => {
    const start = new Date();
    await otp.sendOtp(PHONE, start);
    for (let i = 1; i < 5; i += 1) await otp.sendOtp(PHONE, new Date(start.getTime() + i * 60_000));
    await assert.rejects(() => otp.sendOtp(PHONE, new Date(start.getTime() + 5 * 60_000)), /too many codes/i);
  });

  it("expires a challenge with its TTL", async () => {
    const start = new Date();
    await otp.sendOtp(PHONE, start);
    const challenge = await collections.otpChallenges(db).findOne({ _id: PHONE });
    assert.ok(challenge!.expiresAt.getTime() > start.getTime());
    await assert.rejects(
      () => otp.verifyOtp(PHONE, "123456", new Date(challenge!.expiresAt.getTime() + 1000)),
      /expired/i,
    );
  });
});
