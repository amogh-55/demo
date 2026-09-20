/**
 * Creates or updates an admin user.
 *
 * The password is read from ADMIN_PASSWORD rather than argv so it does not end up
 * in shell history, and only its scrypt hash is ever written to the database.
 *
 *   ADMIN_USERNAME=owner ADMIN_PASSWORD='...' npm run create-admin
 */
import crypto from "node:crypto";
import { MongoClient, ObjectId } from "mongodb";
import { config as loadEnv } from "./env";

loadEnv();

function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(password, salt, 64);
  return `scrypt$${salt.toString("hex")}$${key.toString("hex")}`;
}

async function main() {
  const uri = process.env.MONGODB_URI;
  const username = (process.env.ADMIN_USERNAME || "").trim().toLowerCase();
  const password = process.env.ADMIN_PASSWORD || "";
  const displayName = process.env.ADMIN_DISPLAY_NAME || username;

  if (!uri) throw new Error("MONGODB_URI is not set.");
  if (username.length < 3) throw new Error("Set ADMIN_USERNAME to at least 3 characters.");
  if (password.length < 12) throw new Error("Set ADMIN_PASSWORD to at least 12 characters.");

  const client = new MongoClient(uri);
  await client.connect();
  const db = client.db(process.env.MONGODB_DB || "turf_booking");

  await db.collection("adminUsers").createIndex({ username: 1 }, { unique: true });
  await db.collection("adminUsers").updateOne(
    { username },
    {
      $set: { passwordHash: hashPassword(password), displayName, active: true },
      $setOnInsert: { _id: new ObjectId(), username, createdAt: new Date(), lastLoginAt: null },
    },
    { upsert: true },
  );

  console.log(`✓ Admin "${username}" is ready. Sign in at /admin/login`);
  await client.close();
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
