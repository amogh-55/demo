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

if (!global.__turfMongo) global.__turfMongo = connect();

export const mongoClient = global.__turfMongo.client;
export const getDb = (): Promise<Db> => global.__turfMongo!.ready;

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

let indexesEnsured = false;

/**
 * The unique index on slotUnits is the backbone of double-booking prevention:
 * at most one document may ever exist per (locationId, date, startMin), so two
 * racing upserts for the same unit can never both insert.
 */
export async function ensureIndexes(db: Db) {
  if (indexesEnsured) return;
  indexesEnsured = true;
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
