import "server-only";
import { MongoClient, type CreateIndexesOptions, type Db, type Collection } from "mongodb";
import type {
  AdminUserDoc,
  AuditLogDoc,
  BookingDoc,
  DayBlockDoc,
  FacilityDoc,
  LocationDoc,
  OtpChallengeDoc,
  RateLimitDoc,
  ResourceDoc,
  SettingsDoc,
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
  const client = new MongoClient(uri!, {
    /*
     * How many database connections one server instance may hold open.
     *
     * Every hold and every submission runs inside a transaction, which needs a
     * connection for its whole duration. At ten, thirty customers booking at once
     * spend most of their time queueing for one — measured at 2.9s to place a
     * hold that takes the database 30ms to do.
     *
     * Tunable because the right number depends on where this runs: one long-lived
     * server wants a generous pool, while a serverless deployment multiplies it by
     * however many instances are warm and has an account-wide ceiling to respect.
     */
    maxPoolSize: Number(process.env.MONGODB_POOL_SIZE) || 40,
    retryWrites: true,
    // Fail a request rather than let it wait forever for a connection that is
    // never coming; the customer gets an honest error instead of a hung page.
    waitQueueTimeoutMS: 10_000,
  });
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
  facilities: (db: Db) => db.collection<FacilityDoc>("facilities"),
  resources: (db: Db) => db.collection<ResourceDoc>("resources"),
  slotUnits: (db: Db) => db.collection<SlotUnitDoc>("slotUnits"),
  dayBlocks: (db: Db) => db.collection<DayBlockDoc>("dayBlocks"),
  bookings: (db: Db) => db.collection<BookingDoc>("bookings"),
  adminUsers: (db: Db) => db.collection<AdminUserDoc>("adminUsers"),
  auditLogs: (db: Db) => db.collection<AuditLogDoc>("auditLogs"),
  settings: (db: Db) => db.collection<SettingsDoc>("settings") as unknown as Collection<SettingsDoc>,
  otpChallenges: (db: Db) => db.collection<OtpChallengeDoc>("otpChallenges") as unknown as Collection<OtpChallengeDoc>,
  rateLimits: (db: Db) => db.collection<RateLimitDoc>("rateLimits"),
};

/**
 * In flight or done. Held as a promise so concurrent callers share one attempt,
 * and cleared on failure: the old boolean was set before the work finished, so a
 * half-built set of indexes was remembered as complete and never retried.
 */
let indexesEnsured: Promise<void> | null = null;

/**
 * Which collection an index belongs to, what it is on, and what it is for.
 *
 * Written as data rather than as a list of createIndex calls so the set can be
 * compared against what the database already has. Building them unconditionally
 * cost 910ms of every cold start — paid by whichever customer happened to open
 * the site when a serverless instance booted — on work that does nothing at all
 * after the first time.
 */
interface IndexSpec {
  collection: keyof typeof collections;
  /** The name MongoDB stores it under, which is what existence is checked by. */
  name: string;
  keys: Record<string, 1 | -1>;
  options?: CreateIndexesOptions;
}

/**
 * The unique index on slotUnits is the backbone of double-booking prevention:
 * at most one document may ever exist per (resourceId, date, startMin), so two
 * racing upserts for the same unit can never both insert.
 *
 * It is keyed on the RESOURCE, not the location: that single choice is what makes
 * Pickleball Court 1 and Court 2 independently bookable at the same hour, and what
 * lets a bowling machine sell 15-minute units beside a turf selling hours.
 */
const INDEXES: IndexSpec[] = [
  { collection: "locations", name: "slug_1", keys: { slug: 1 }, options: { unique: true } },
  { collection: "locations", name: "active_1_name_1", keys: { active: 1, name: 1 } },

  { collection: "facilities", name: "locationId_1_slug_1", keys: { locationId: 1, slug: 1 }, options: { unique: true } },
  { collection: "facilities", name: "locationId_1_sortOrder_1", keys: { locationId: 1, sortOrder: 1 } },

  { collection: "resources", name: "facilityId_1_slug_1", keys: { facilityId: 1, slug: 1 }, options: { unique: true } },
  { collection: "resources", name: "facilityId_1_sortOrder_1", keys: { facilityId: 1, sortOrder: 1 } },
  { collection: "resources", name: "locationId_1", keys: { locationId: 1 } },

  {
    collection: "slotUnits",
    name: "slot_unit_identity_v2",
    keys: { resourceId: 1, date: 1, startMin: 1 },
    options: { unique: true },
  },
  { collection: "slotUnits", name: "resourceId_1_date_1_status_1", keys: { resourceId: 1, date: 1, status: 1 } },
  { collection: "slotUnits", name: "locationId_1_date_1_status_1", keys: { locationId: 1, date: 1, status: 1 } },
  { collection: "slotUnits", name: "holdTokenHash_1", keys: { holdTokenHash: 1 } },
  { collection: "slotUnits", name: "bookingId_1", keys: { bookingId: 1 } },
  { collection: "slotUnits", name: "status_1_holdUntil_1", keys: { status: 1, holdUntil: 1 } },

  {
    collection: "dayBlocks",
    name: "day_block_identity_v2",
    keys: { resourceId: 1, date: 1 },
    options: { unique: true },
  },
  // Explicitly named: the auto-generated name would be the one the retired
  // unique index used, and reusing it is what caused the clash handled below.
  { collection: "dayBlocks", name: "day_block_by_location", keys: { locationId: 1, date: 1 } },

  { collection: "bookings", name: "reference_1", keys: { reference: 1 }, options: { unique: true } },
  { collection: "bookings", name: "status_1_createdAt_-1", keys: { status: 1, createdAt: -1 } },
  { collection: "bookings", name: "locationId_1_date_1", keys: { locationId: 1, date: 1 } },
  // The dashboard asks "what is on today, across every ground" three times over
  // — the takings, the list and the upcoming count — and had no index for it.
  { collection: "bookings", name: "date_1_status_1", keys: { date: 1, status: 1 } },
  { collection: "bookings", name: "resourceId_1_date_1", keys: { resourceId: 1, date: 1 } },
  { collection: "bookings", name: "customerPhone_1", keys: { customerPhone: 1 } },
  { collection: "bookings", name: "createdAt_-1", keys: { createdAt: -1 } },

  { collection: "adminUsers", name: "username_1", keys: { username: 1 }, options: { unique: true } },
  { collection: "auditLogs", name: "createdAt_-1", keys: { createdAt: -1 } },
  {
    collection: "auditLogs",
    name: "entityType_1_entityId_1_createdAt_-1",
    keys: { entityType: 1, entityId: 1, createdAt: -1 },
  },

  {
    collection: "otpChallenges",
    name: "expiresAt_1",
    keys: { expiresAt: 1 },
    options: { expireAfterSeconds: 0 },
  },
  { collection: "rateLimits", name: "expiresAt_1", keys: { expiresAt: 1 }, options: { expireAfterSeconds: 0 } },
];

/**
 * Indexes from before facilities existed, which are actively wrong now.
 *
 * Both are keyed on locationId. The slotUnits one is unique, so while it exists
 * it enforces "one booking per ground-hour" across every court and machine at a
 * ground; the dayBlocks one carries the name the current non-unique index would
 * otherwise be auto-assigned, so creating that one fails outright with "An
 * existing index has the same name".
 */
const RETIRED: Array<{ collection: keyof typeof collections; name: string }> = [
  { collection: "slotUnits", name: "slot_unit_identity" },
  { collection: "dayBlocks", name: "locationId_1_date_1" },
];

export function ensureIndexes(db: Db): Promise<void> {
  if (!indexesEnsured) {
    indexesEnsured = buildIndexes(db).catch((err) => {
      indexesEnsured = null;
      throw err;
    });
  }
  return indexesEnsured;
}

/**
 * Bring the database's indexes up to date, doing nothing when they already are.
 *
 * One round trip per collection to read what is there, then work only on the
 * difference — which on every start after the first is no work at all. The read
 * is what makes this cheap enough to keep in front of the first request, where
 * the unique indexes have to be: they are the double-booking guard, and a write
 * that lands before they exist is a write the database will not refuse.
 */
async function buildIndexes(db: Db): Promise<void> {
  const names = [...new Set(INDEXES.map((i) => i.collection))];
  const found = await Promise.all(
    names.map(async (name) => {
      try {
        const list = await collections[name](db).listIndexes().toArray();
        return [name, new Set(list.map((i) => i.name as string))] as const;
      } catch {
        // A collection that does not exist yet has no indexes, which is the
        // same answer as far as this is concerned.
        return [name, new Set<string>()] as const;
      }
    }),
  );
  const existing = new Map(found);

  const drops = RETIRED.filter((r) => existing.get(r.collection)?.has(r.name));
  if (drops.length > 0) {
    // Before the creates: the retired slotUnits index enforces the wrong
    // uniqueness, and the retired dayBlocks one holds a name that is now taken.
    await Promise.all(drops.map((r) => collections[r.collection](db).dropIndex(r.name).catch(() => {})));
  }

  const missing = INDEXES.filter((spec) => !existing.get(spec.collection)?.has(spec.name));
  if (missing.length === 0) return;

  await Promise.all(
    missing.map((spec) =>
      collections[spec.collection](db).createIndex(spec.keys as never, { name: spec.name, ...spec.options }),
    ),
  );
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
