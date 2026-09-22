import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { phoneFromVerification } from "../src/lib/msg91-widget";

/**
 * Which number a verification belongs to.
 *
 * This is the whole security argument for the widget: MSG91 says a token is good,
 * and this decides whose handset it was. Get it wrong in the lenient direction and
 * a customer can verify their own number and put it against somebody else's.
 */

/** A JWT-shaped token whose payload is `claims`. The signature is never checked. */
function token(claims: Record<string, unknown>): string {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${part({ alg: "HS256", typ: "JWT" })}.${part(claims)}.signature`;
}

describe("the number a verified access token belongs to", () => {
  it("takes the number MSG91 puts in the response", () => {
    assert.equal(phoneFromVerification({ type: "success", message: "919876543210" }, token({})), "9876543210");
  });

  it("accepts the number however MSG91 punctuates it", () => {
    assert.equal(phoneFromVerification({ message: "+91 98765 43210" }, token({})), "9876543210");
  });

  /** Older accounts answer "success" and leave the number in the token. */
  it("falls back to the token payload when the response carries no number", () => {
    assert.equal(phoneFromVerification({ type: "success", message: "success" }, token({ mobile: "919876543210" })), "9876543210");
  });

  it("reads the other names MSG91 has used for it", () => {
    assert.equal(phoneFromVerification({ message: "ok" }, token({ identifier: "919876543210" })), "9876543210");
    assert.equal(phoneFromVerification({ message: "ok" }, token({ phone: "9876543210" })), "9876543210");
  });

  it("prefers the response over the token", () => {
    // If the two ever disagree, MSG91's live answer is the newer word.
    assert.equal(phoneFromVerification({ message: "918888888888" }, token({ mobile: "919999999999" })), "8888888888");
  });

  /*
   * Everything below must come back null, because null is refused by the caller.
   * A number invented here would be a verification nobody ever passed.
   */
  it("is null when nothing anywhere names a number", () => {
    assert.equal(phoneFromVerification({ type: "success", message: "success" }, token({ user: "someone" })), null);
    assert.equal(phoneFromVerification({ type: "success" }, token({})), null);
    assert.equal(phoneFromVerification(null, token({})), null);
  });

  it("is null for a token that is not a JWT", () => {
    assert.equal(phoneFromVerification({ message: "success" }, "not-a-jwt"), null);
    assert.equal(phoneFromVerification({ message: "success" }, "a.b.c"), null);
  });

  it("is null for something too short to be a mobile number", () => {
    assert.equal(phoneFromVerification({ message: "12345" }, token({})), null);
    assert.equal(phoneFromVerification({ message: "success" }, token({ mobile: "123" })), null);
  });

  it("ignores a payload that is not an object", () => {
    const odd = `${Buffer.from(JSON.stringify({})).toString("base64url")}.${Buffer.from('"919876543210"').toString("base64url")}.sig`;
    assert.equal(phoneFromVerification({ message: "success" }, odd), null);
  });
});
