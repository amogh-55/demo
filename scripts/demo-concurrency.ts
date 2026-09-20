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
/**
 * A well-formed key pointing at nothing.
 *
 * Booking submission checks the SHAPE of a screenshot key so a browser cannot
 * invent one, and this has to satisfy that check. No file is uploaded, so the
 * image simply will not open in the admin screen — which is the honest outcome
 * for a demo booking nobody paid for.
 */
const DEMO_SCREENSHOT_KEY = "payment-screenshots/2026-01-01/00000000-0000-4000-8000-000000000de0.jpg";

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

async function attemptHold(label: string, resourceId: string, date: string, startMin: number, endMin: number) {
  const res = await fetch(`${BASE}/api/holds`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ resourceId, date, startMin, endMin }),
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
  const { locations } = (await locationsRes.json()) as {
    locations: Array<{
      id: string;
      name: string;
      facilities: Array<{
        id: string;
        name: string;
        kind: "HOURLY" | "OVERS";
        resources: Array<{ id: string; name: string }>;
      }>;
    }>;
  };
  if (locations.length === 0) throw new Error("Nothing bookable. Run `npm run seed` first.");

  // Everything below races one RESOURCE against itself, so the demo needs the
  // leaf, not the ground: a ground with two courts is two independent things.
  const hourly = locations
    .flatMap((l) => l.facilities.map((f) => ({ location: l, facility: f })))
    .filter((x) => x.facility.kind === "HOURLY" && x.facility.resources.length > 0);
  if (hourly.length === 0) throw new Error("No hourly facility to demonstrate with. Run `npm run seed` first.");

  const first = hourly[0]!;
  const ground = { id: first.facility.resources[0]!.id, name: `${first.facility.name} · ${first.location.name}` };

  /**
   * Something at a DIFFERENT resource, to show they do not block each other.
   * A second court under the same facility is the sharpest version of that,
   * so it is preferred over a different ground.
   */
  const sibling = first.facility.resources[1];
  const elsewhereEntry = hourly.find((x) => x.facility.id !== first.facility.id);
  const other = sibling
    ? { id: sibling.id, name: `${first.facility.name} · ${sibling.name}` }
    : elsewhereEntry
      ? {
          id: elsewhereEntry.facility.resources[0]!.id,
          name: `${elsewhereEntry.facility.name} · ${elsewhereEntry.location.name}`,
        }
      : undefined;

  const bowling = locations
    .flatMap((l) => l.facilities.map((f) => ({ location: l, facility: f })))
    .find((x) => x.facility.kind === "OVERS" && x.facility.resources.length > 0);
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

  /* 4 ─ Same hour, different bookable resource. */
  if (other) {
    console.log(bold(`4. Customer G wants the same ${time(1020)}–${time(1140)} at ${other.name}`));
    const elsewhere = await attemptHold("Customer G", other.id, date, 17 * 60, 19 * 60);
    report([elsewhere]);
    console.log(dim("  → the unique key is (resource, date, start), so separate courts never block each other\n"));
  }

  /* 4b ─ Overs bookings lock quarter-hours, and overlap at that granularity. */
  if (bowling) {
    const machine = bowling.facility.resources[0]!;
    console.log(bold(`4b. Two bowling sessions at ${bowling.facility.name} · ${bowling.location.name}`));

    const book = (label: string, startMin: number, overs: number, ballTypeId: string) =>
      fetch(`${BASE}/api/holds`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ resourceId: machine.id, date, startMin, overs, ballTypeId }),
      }).then(async (res) => {
        const body = await res.json();
        const cookie = res.headers.getSetCookie().find((c) => c.startsWith("turf_hold="))?.split(";")[0] ?? null;
        if (cookie && res.status === 200) createdHolds.push(cookie);
        return { label, status: res.status, cookie, amount: body?.amount, message: body?.error?.message };
      });

    // 6:00 + 20 overs is 6:00–6:30; 6:15 + 20 overs is 6:15–6:45. They share
    // 6:15–6:30, so exactly one can win.
    report(await Promise.all([book("Customer H (20 overs from 6:00)", 18 * 60, 20, "synthetic"), book("Customer I (20 overs from 6:15)", 18 * 60 + 15, 20, "leather")]));
    console.log(dim("  → overs become 15-minute units, and the overlap is caught at that granularity\n"));

    console.log(bold("4c. Customer J asks for more overs than are on sale"));
    const tooMany = await book("Customer J (100 overs)", 20 * 60, 100, "synthetic");
    report([tooMany]);
    console.log(dim("  → the ceiling is the largest configured option, refused server-side\n"));
  }

  /* 5 ─ Turn the winning hold into a real pending booking. */
  console.log(bold("5. The winner submits their booking"));
  const submit = await fetch(`${BASE}/api/bookings`, {
    method: "POST",
    headers: { "Content-Type": "application/json", cookie: winner.cookie! },
    body: JSON.stringify({
      customerName: DEMO_NAME,
      customerPhone: DEMO_PHONE,
      paymentScreenshotKey: DEMO_SCREENSHOT_KEY,
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
      paymentScreenshotKey: DEMO_SCREENSHOT_KEY,
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
  const avail = await (await fetch(`${BASE}/api/availability?resourceId=${ground.id}&date=${date}`)).json();
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
