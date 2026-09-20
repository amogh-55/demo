/**
 * A failed connection must not be remembered.
 *
 * This is the bug that took the deployed site down: the pooled client was cached
 * unconditionally at module load, so when Atlas refused the very first handshake
 * (the server's IP was not yet on the access list) every later request awaited
 * that same rejected promise and returned 500 — for the whole life of the
 * process, long after the access list was fixed.
 *
 * Runs against an unreachable address with a short selection timeout, so it needs
 * no database of its own.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

// Set before importing: the module reads MONGODB_URI at load time. Port 1 refuses
// immediately, so the failure is fast and deterministic.
process.env.MONGODB_URI = "mongodb://127.0.0.1:1/?serverSelectionTimeoutMS=300&connectTimeoutMS=300";
process.env.MONGODB_DB = "unreachable_probe";

describe("connection recovery", () => {
  it("forgets a failed connection so the next request dials again", async () => {
    const db = await import("../src/lib/db");
    const cached = () => (globalThis as { __turfMongo?: unknown }).__turfMongo;

    await assert.rejects(() => db.getDb(), "an unreachable server must reject");
    assert.equal(cached(), undefined, "the failed client must not stay cached");

    // The real symptom: a second call has to be a fresh attempt, not a replay of
    // the first rejection. If it were replayed, the site could never recover.
    const first = db.getDb();
    await assert.rejects(() => first);
    const second = db.getDb();
    await assert.rejects(() => second);
    assert.notEqual(first, second, "each attempt must be a new connection, not the cached rejection");
    assert.equal(cached(), undefined);
  });
});
