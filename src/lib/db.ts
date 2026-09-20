import "server-only";
import { MongoClient, type Db, type Collection } from "mongodb";
import type {
  AdminUserDoc,
  AuditLogDoc,
  BookingDoc,
  DayBlockDoc,
  LocationDoc,
  RateLimitDoc,
  SettingsDoc,
  SlotConfigDoc,
  SlotUnitDoc,
} from "./types";

const uri = process.env.MONGODB_URI;
if (!uri) throw new Error("MONGODB_URI is not set");

const dbName = process.env.MONGODB_DB || "turf_booking";

// Next dev reloads modules constantly; one pooled client per process, not per reload.
declare global {
  // eslint-disable-next-line no-var
  var __turfMongo: { client: MongoClient; ready: Promise<Db> } | undefined;
}

function connect(): { client: MongoClient; ready: Promise<Db> } {
  const client = new MongoClient(uri!, { maxPoolSize: 10, retryWrites: true });
  const ready = client.connect().then(async (c) => {
    const db = c.db(dbName);
    await ensureIndexes(db);
    return db;
  });
  return { client, ready };
}

/**
 * One pooled client per process — but a FAILED connection is never kept.
 *
 * Caching the promise unconditionally means a single bad first attempt (Atlas
 * refusing the TLS handshake because the IP was not yet allowed, a DNS blip on a
 * cold start) is remembered for the life of the process: every later request
 * awaits the same rejected promise and 500s, long after the cause is gone. On
 * serverless that instance stays poisoned until the platform happens to recycle
 * it. Dropping the entry on rejection lets the very next request dial again.
 */
function pool(): { client: MongoClient; ready: Promise<Db> } {
  const existing = global.__turfMongo;
  if (existing) return existing;

  const created = connect();
  global.__turfMongo = created;
  created.ready.catch(() => {
    // Only clear our own entry: a newer attempt may already have replaced it.
    if (global.__turfMongo === created) global.__turfMongo = undefined;
    void created.client.close().catch(() => {});
  });
  return created;
}

/** The pooled client, for starting sessions. Callers await {@link getDb} first. */
export const getMongoClient = (): MongoClient => pool().client;
export const getDb = (): Promise<Db> => pool().ready;

export const collections = {
  locations: (db: Db) => db.collection<LocationDoc>("locations"),
  slotConfigs: (db: Db) => db.collection<SlotConfigDoc>("slotConfigurations"),
  slotUnits: (db: Db) => db.collection<SlotUnitDoc>("slotUnits"),
  dayBlocks: (db: Db) => db.collection<DayBlockDoc>("dayBlocks"),
  bookings: (db: Db) => db.collection<BookingDoc>("bookings"),
  adminUsers: (db: Db) => db.collection<AdminUserDoc>("adminUsers"),
  auditLogs: (db: Db) => db.collection<AuditLogDoc>("auditLogs"),
  settings: (db: Db) => db.collection<SettingsDoc>("settings") as unknown as Collection<SettingsDoc>,
  rateLimits: (db: Db) => db.collection<RateLimitDoc>("rateLimits"),
};

/**
 * In flight or done. Held as a promise so concurrent callers share one attempt,
 * and cleared on failure: the old boolean was set before the work finished, so a
 * half-built set of indexes was remembered as complete and never retried.
 */
let indexesEnsured: Promise<void> | null = null;

/**
 * The unique index on slotUnits is the backbone of double-booking prevention:
 * at most one document may ever exist per (locationId, date, startMin), so two
 * racing upserts for the same unit can never both insert.
 */
export function ensureIndexes(db: Db): Promise<void> {
  if (!indexesEnsured) {
    indexesEnsured = buildIndexes(db).catch((err) => {
      indexesEnsured = null;
      throw err;
    });
  }
  return indexesEnsured;
}

async function buildIndexes(db: Db): Promise<void> {
  await Promise.all([
    collections.locations(db).createIndex({ slug: 1 }, { unique: true }),
    collections.locations(db).createIndex({ active: 1, name: 1 }),

    collections.slotConfigs(db).createIndex({ locationId: 1 }, { unique: true }),

    collections.slotUnits(db).createIndex({ locationId: 1, date: 1, startMin: 1 }, { unique: true, name: "slot_unit_identity" }),
    collections.slotUnits(db).createIndex({ locationId: 1, date: 1, status: 1 }),
    collections.slotUnits(db).createIndex({ holdTokenHash: 1 }),
    collections.slotUnits(db).createIndex({ bookingId: 1 }),
    collections.slotUnits(db).createIndex({ status: 1, holdUntil: 1 }),

    collections.dayBlocks(db).createIndex({ locationId: 1, date: 1 }, { unique: true }),

    collections.bookings(db).createIndex({ reference: 1 }, { unique: true }),
    collections.bookings(db).createIndex({ status: 1, createdAt: -1 }),
    collections.bookings(db).createIndex({ locationId: 1, date: 1 }),
    collections.bookings(db).createIndex({ customerPhone: 1 }),
    collections.bookings(db).createIndex({ createdAt: -1 }),

    collections.adminUsers(db).createIndex({ username: 1 }, { unique: true }),
    collections.auditLogs(db).createIndex({ createdAt: -1 }),
    collections.auditLogs(db).createIndex({ entityType: 1, entityId: 1, createdAt: -1 }),

    collections.rateLimits(db).createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
  ]);
}

/** MongoDB duplicate-key error — in this app it always means "someone else owns that unit". */
export function isDuplicateKeyError(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: number }).code === 11000;
}

/** Transient transaction failure (write conflict, node stepdown) — safe to retry. */
export function isTransientTransactionError(err: unknown): boolean {
  const labels = (err as { errorLabels?: string[] })?.errorLabels;
  return Array.isArray(labels) && labels.includes("TransientTransactionError");
}
