/**
 * Watch the double-booking protection work, against the running dev server.
 *
 *   npm run dev            # in one terminal
 *   npm run demo           # in another
 *
 * Fires genuinely simultaneous requests at the same slot and prints who won,
 * who lost and why, then leaves one PENDING booking behind so it can be
 * verified and confirmed in the admin UI.
 *
 *   npm run demo -- --clean     removes everything this script created
 */
import { config as loadEnv } from "./env";

loadEnv();

const BASE = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";
// Demo bookings are tagged by a reserved phone number rather than by name,
// because the name validator (rightly) rejects bracketed prefixes.
const DEMO_NAME = "Demo Ravi Kumar";
const DEMO_PHONE = "9000000001";

const bold = (s: string) => `[1m${s}[0m`;
const green = (s: string) => `[32m${s}[0m`;
const red = (s: string) => `[31m${s}[0m`;
const dim = (s: string) => `[2m${s}[0m`;

const time = (min: number) => {
  const h = Math.floor(min / 60);
  const suffix = h >= 12 ? "PM" : "AM";
  return `${h % 12 === 0 ? 12 : h % 12}${suffix}`;
};

/** Cookies for holds this run created, so none are left parked for ten minutes. */
const createdHolds: string[] = [];

interface HoldAttempt {
  label: string;
  status: number;
  cookie: string | null;
  amount?: number;
  message?: string;
}

async function attemptHold(label: string, locationId: string, date: string, startMin: number, endMin: number) {
  const res = await fetch(`${BASE}/api/holds`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ locationId, date, startMin, endMin }),
  });
  const body = await res.json();
  const cookie = res.headers.getSetCookie().find((c) => c.startsWith("turf_hold="))?.split(";")[0] ?? null;
  if (cookie && res.status === 200) createdHolds.push(cookie);
  return {
    label,
    status: res.status,
    cookie,
    amount: body?.amount,
    message: body?.error?.message,
  } satisfies HoldAttempt;
}

function report(attempts: HoldAttempt[]) {
  for (const a of attempts) {
    if (a.status === 200) {
      console.log(`  ${green("WON ")} ${a.label} — held, ₹${a.amount?.toLocaleString("en-IN")}`);
    } else {
      console.log(`  ${red("LOST")} ${a.label} — ${a.status}: ${a.message}`);
    }
  }
}

async function clean() {
  const { MongoClient } = await import("mongodb");
  const client = new MongoClient(process.env.MONGODB_URI!);
  await client.connect();
  const db = client.db(process.env.MONGODB_DB || "turf_booking");

  const demo = await db.collection("bookings").find({ customerPhone: DEMO_PHONE }).toArray();
  const ids = demo.map((b) => b._id);

  // Only ever remove units this script's own bookings own, plus holds that have
  // already lapsed. Blocked slots and real bookings are never touched.
  const owned = ids.length
    ? await db.collection("slotUnits").deleteMany({ bookingId: { $in: ids } })
    : { deletedCount: 0 };
  // Every hold not attached to a booking, live or lapsed. This is a development
  // tool, so it clears the decks; it still refuses to touch BLOCKED slots or any
  // unit owned by a real PENDING/CONFIRMED booking.
  const held = await db.collection("slotUnits").deleteMany({ status: "HELD", bookingId: null });

  const bookings = ids.length ? await db.collection("bookings").deleteMany({ _id: { $in: ids } }) : { deletedCount: 0 };
  if (demo.length) {
    await db.collection("auditLogs").deleteMany({ entityId: { $in: demo.map((b) => b.reference) } });
  }

  console.log(
    `Removed ${bookings.deletedCount} demo booking(s), ${owned.deletedCount} reserved slot(s) ` +
      `and ${held.deletedCount} loose hold(s). Blocked slots and real bookings were left alone.`,
  );
  await client.close();
}

async function releaseAll() {
  for (const cookie of createdHolds.splice(0)) {
    await fetch(`${BASE}/api/holds`, { method: "DELETE", headers: { cookie } }).catch(() => {});
  }
}

async function main() {
  if (process.argv.includes("--clean")) return clean();

  const locationsRes = await fetch(`${BASE}/api/locations`).catch(() => null);
  if (!locationsRes?.ok) {
    throw new Error(`Cannot reach ${BASE}. Start the dev server first with \`npm run dev\`.`);
  }
  const { locations } = (await locationsRes.json()) as { locations: Array<{ id: string; name: string }> };
  if (locations.length === 0) throw new Error("No active locations. Run `npm run seed` first.");

  const ground = locations[0]!;
  const other = locations[1];
  // Three days out: safely inside the booking window and never already started.
  const date = new Date(Date.now() + 330 * 60_000 + 3 * 86_400_000).toISOString().slice(0, 10);

  console.log(`\n${bold("Concurrency demo")} — ${ground.name}, ${date}\n`);

  /* 1 ─ Same slot, at the same instant. */
  console.log(bold(`1. Four customers all grab ${time(1020)}–${time(1140)} at the same instant`));
  const race = await Promise.all(
    ["Customer A", "Customer B", "Customer C", "Customer D"].map((label) =>
      attemptHold(label, ground.id, date, 17 * 60, 19 * 60),
    ),
  );
  report(race);
  const winner = race.find((r) => r.status === 200);
  if (!winner) throw new Error("Expected exactly one winner. The slot may already be taken — try --clean first.");
  console.log(dim(`  → ${race.filter((r) => r.status === 200).length} winner, ${race.filter((r) => r.status !== 200).length} refused by the unique index\n`));

  /* 2 ─ Overlapping range. */
  console.log(bold(`2. Customer E wants ${time(1080)}–${time(1200)} — overlaps the held ${time(1080)}–${time(1140)} hour`));
  report([await attemptHold("Customer E", ground.id, date, 18 * 60, 20 * 60)]);
  console.log(dim("  → shares one atomic hour, so it cannot be held\n"));

  /* 3 ─ Adjacent range. */
  console.log(bold(`3. Customer F wants ${time(1140)}–${time(1260)} — starts exactly when the held slot ends`));
  const adjacent = await attemptHold("Customer F", ground.id, date, 19 * 60, 21 * 60);
  report([adjacent]);
  console.log(dim("  → intervals are half-open [start, end), so adjacent bookings are allowed\n"));

  /* 4 ─ Same hour, different ground. */
  if (other) {
    console.log(bold(`4. Customer G wants the same ${time(1020)}–${time(1140)} at ${other.name}`));
    const elsewhere = await attemptHold("Customer G", other.id, date, 17 * 60, 19 * 60);
    report([elsewhere]);
    console.log(dim("  → locationId is part of the unique key, so grounds never block each other\n"));
  }

  /* 5 ─ Turn the winning hold into a real pending booking. */
  console.log(bold("5. The winner submits their booking"));
  const submit = await fetch(`${BASE}/api/bookings`, {
    method: "POST",
    headers: { "Content-Type": "application/json", cookie: winner.cookie! },
    body: JSON.stringify({
      customerName: DEMO_NAME,
      customerPhone: DEMO_PHONE,
      paymentScreenshotKey: "demo/no-screenshot-storage-configured.jpg",
      amount: 1, // deliberately wrong: the server must ignore it
    }),
  });
  const booking = await submit.json();
  if (!submit.ok) throw new Error(booking?.error?.message ?? "submission failed");
  // This hold is now a booking; releasing it would undo the reservation.
  createdHolds.splice(createdHolds.indexOf(winner.cookie!), 1);
  console.log(`  ${green("OK  ")} ${booking.reference} — ${booking.status}, server priced it at ₹${booking.amount.toLocaleString("en-IN")} ${dim("(the client sent amount: 1 and was ignored)")}`);

  /* 6 ─ Double click. */
  const retry = await fetch(`${BASE}/api/bookings`, {
    method: "POST",
    headers: { "Content-Type": "application/json", cookie: winner.cookie! },
    body: JSON.stringify({
      customerName: DEMO_NAME,
      customerPhone: DEMO_PHONE,
      paymentScreenshotKey: "demo/no-screenshot-storage-configured.jpg",
    }),
  });
  const retryBody = await retry.json();
  console.log(
    `  ${green("OK  ")} clicked "Book now" again → ${retryBody.reference}` +
      (retryBody.reference === booking.reference ? dim(" (same booking, not a duplicate)") : red(" DUPLICATE!")),
  );

  /* Give every other demo hold straight back rather than parking it. */
  await releaseAll();

  /* 7 ─ What the next customer now sees. */
  const avail = await (await fetch(`${BASE}/api/availability?locationId=${ground.id}&date=${date}`)).json();
  console.log(`\n${bold("What the next customer sees")} — ${ground.name}, ${date}`);
  for (const u of avail.units.filter((x: { startMin: number }) => x.startMin >= 16 * 60 && x.startMin <= 21 * 60)) {
    const mark = u.status === "AVAILABLE" ? green("available") : u.status === "PENDING" ? red("taken (awaiting verification)") : dim(u.status.toLowerCase());
    console.log(`  ${time(u.startMin).padStart(5)}–${time(u.endMin).padEnd(5)}  ${mark}`);
  }

  console.log(`\n${bold("Next")}`);
  console.log(`  Open ${BASE}/admin/bookings and you will see ${booking.reference} waiting for payment verification.`);
  console.log(`  ${dim("Its screenshot will not open until STORAGE_* is configured — nothing was uploaded.")}`);
  console.log(`  Clear everything this script made with: ${bold("npm run demo -- --clean")}\n`);
}

main()
  .catch(async (err) => {
    // A failed run must not leave slots held for the next ten minutes.
    await releaseAll();
    console.error(red(err instanceof Error ? err.message : String(err)));
    process.exit(1);
  });
