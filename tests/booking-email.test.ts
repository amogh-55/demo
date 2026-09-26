import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { escapeHtml, ownerBookingEmail, type BookingEmailFacts } from "../src/lib/email";

const facts = (over: Partial<BookingEmailFacts> = {}): BookingEmailFacts => ({
  businessName: "Spirit Cricket Zone",
  reference: "TURF-AB12CD",
  customerName: "Aarav Sharma",
  customerPhone: "9876543210",
  locationName: "Medipally",
  locationAddress: "Peerzadiguda, Hyderabad",
  service: "Box Cricket",
  date: "Tue, 23 Sep 2026",
  time: "6:00 PM – 7:00 PM",
  duration: "1 hour",
  amount: 700,
  amountPaid: 700,
  amountRemaining: 0,
  paymentMethod: "Razorpay (upi)",
  paymentStatus: "VERIFIED",
  supportPhone: "9876500000",
  ...over,
});

/**
 * The brief lists exactly what a confirmation email has to state. These check the
 * list rather than the wording — a missing phone number on the owner's copy is
 * the owner ringing us, which is the thing this whole integration is meant to
 * stop happening.
 */
describe("the confirmation email", () => {
  const required = (f: BookingEmailFacts) => [
    f.reference,
    f.customerName,
    f.customerPhone,
    f.locationName,
    f.service,
    f.date,
    f.time,
    f.duration,
    f.paymentMethod,
    f.paymentStatus,
  ];

  it("states everything the owner needs, in both the HTML and the plain text", () => {
    const f = facts();
    const mail = ownerBookingEmail(f);
    for (const wanted of required(f)) {
      assert.ok(mail.html.includes(wanted), `html missing ${wanted}`);
      assert.ok(mail.text.includes(wanted), `text missing ${wanted}`);
    }
    assert.match(mail.subject, /TURF-AB12CD/);
  });

  it("states the money three ways: total, paid and balance", () => {
    const mail = ownerBookingEmail(facts({ amountPaid: 350, amountRemaining: 350, paymentStatus: "PARTIAL" }));
    assert.ok(mail.text.includes("Total: ₹700"), mail.text);
    assert.ok(mail.text.includes("Paid: ₹350"), mail.text);
    assert.ok(mail.text.includes("Balance: ₹350"), mail.text);
    assert.match(mail.text, /payable at the ground/);
  });

  /**
   * A customer types their own name and it ends up inside a document. Not a
   * cross-site scripting risk in a mail client, but a name with an angle bracket
   * in it would silently swallow the rest of the email.
   */
  it("escapes a name that would otherwise break the document", () => {
    const mail = ownerBookingEmail(facts({ customerName: '<script>alert("x")</script> & co' }));
    assert.ok(!mail.html.includes("<script>"), "raw markup reached the html");
    assert.ok(mail.html.includes("&lt;script&gt;"), "not escaped");
    assert.ok(mail.html.includes("&amp;"), "ampersand not escaped");
    // The plain-text part is not markup and must keep what they typed.
    assert.ok(mail.text.includes('<script>alert("x")</script> & co'));
  });

  it("escapes the four characters that matter, and nothing else", () => {
    assert.equal(escapeHtml(`<a href="x">Tom & Jerry</a>`), "&lt;a href=&quot;x&quot;&gt;Tom &amp; Jerry&lt;/a&gt;");
    assert.equal(escapeHtml("Aarav Sharma"), "Aarav Sharma");
  });

  it("copes with a ground that has no address on file", () => {
    const mail = ownerBookingEmail(facts({ locationAddress: undefined }));
    assert.ok(mail.text.includes("Ground: Medipally"));
    assert.ok(!mail.text.includes("undefined"), mail.text);
  });
});
