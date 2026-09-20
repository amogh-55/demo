/**
 * Real round-trip against the configured screenshot bucket.
 *
 *   npm run probe-storage
 *
 * Catches what otherwise only surfaces in production: a wrong bucket name or
 * region, a key without write permission, or a signed URL the admin's browser
 * cannot actually fetch. Uploads one 1x1 PNG, reads it back, deletes it.
 */
import { DeleteObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { config as loadEnv } from "./env";

loadEnv();

// A genuine PNG — the uploader sniffs magic bytes, so random data is refused.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

async function main() {
  const storage = await import("../src/lib/storage");

  const driver = storage.storageDriver();
  console.log(`driver:   ${driver}`);
  console.log(`bucket:   ${process.env.STORAGE_BUCKET ?? "(unset)"}`);
  console.log(`endpoint: ${process.env.STORAGE_ENDPOINT ?? "(unset)"}`);
  console.log(`region:   ${process.env.STORAGE_REGION ?? "(unset)"}\n`);

  if (driver !== "s3") {
    console.log("✗ Still on local disk. STORAGE_BUCKET, STORAGE_ACCESS_KEY and");
    console.log("  STORAGE_SECRET_KEY must all be set for the S3 driver to engage.");
    process.exit(1);
  }

  const file = new File([new Uint8Array(PNG)], "probe.png", { type: "image/png" });
  const { key, mime, size } = await storage.storePaymentScreenshot(file);
  console.log(`✓ upload    ${key}  (${mime}, ${size} bytes)`);

  const access = await storage.getScreenshotAccess(key, 300);
  if (access.kind !== "redirect") {
    console.log("✗ expected a signed URL, got raw bytes — the S3 driver did not engage");
    process.exit(1);
  }
  console.log(`✓ signed    ${access.url.split("?")[0]}?…`);

  // What the admin's browser will actually do with that URL.
  const res = await fetch(access.url);
  const body = Buffer.from(await res.arrayBuffer());
  console.log(`✓ fetch     HTTP ${res.status}`);
  console.log(`  type:     ${res.headers.get("content-type")}`);
  console.log(`  disp:     ${res.headers.get("content-disposition") ?? "(none)"}`);
  console.log(`  bytes:    ${body.length} ${body.equals(PNG) ? "(identical)" : "(MISMATCH)"}`);

  const opensInline =
    res.ok &&
    (res.headers.get("content-type") ?? "").startsWith("image/") &&
    !(res.headers.get("content-disposition") ?? "").startsWith("attachment");
  console.log(`\n  opens in a tab, no download prompt: ${opensInline ? "YES" : "NO"}`);

  /**
   * The signature is what guards the image. If the bucket is public, the same
   * object is readable by anyone who can guess the URL — no session, no key —
   * and every customer's payment screenshot is on the open internet.
   */
  const host = (process.env.STORAGE_ENDPOINT ?? "").replace(/\/storage\/v1\/s3\/?$/, "");
  const publicUrl = `${host}/storage/v1/object/public/${process.env.STORAGE_BUCKET}/${key}`;
  const unsigned = await fetch(publicUrl);
  const isPrivate = !unsigned.ok;
  console.log(`  bucket is private (unsigned read refused): ${isPrivate ? `YES (HTTP ${unsigned.status})` : "NO — PUBLIC, FIX THIS"}`);
  if (!isPrivate) {
    console.error("\n  ✗ Anyone with the URL can read uploaded screenshots.");
    console.error("    Supabase → Storage → Files → bucket → Edit → turn Public bucket OFF.");
  }

  // Nothing left behind in the real bucket.
  const s3 = new S3Client({
    region: process.env.STORAGE_REGION || "auto",
    endpoint: process.env.STORAGE_ENDPOINT,
    forcePathStyle: true,
    credentials: {
      accessKeyId: process.env.STORAGE_ACCESS_KEY!,
      secretAccessKey: process.env.STORAGE_SECRET_KEY!,
    },
  });
  await s3.send(new DeleteObjectCommand({ Bucket: process.env.STORAGE_BUCKET!, Key: key }));
  console.log("✓ cleaned up");

  if (!res.ok || !body.equals(PNG) || !isPrivate) process.exit(1);
}

main().catch((err) => {
  const message = String(err?.message ?? err);
  console.error("\n✗ FAILED:", message);
  if (message.includes("NoSuchBucket")) console.error("  → STORAGE_BUCKET does not match the bucket you created.");
  if (message.includes("SignatureDoesNotMatch")) console.error("  → STORAGE_SECRET_KEY is wrong or truncated.");
  if (message.includes("InvalidAccessKeyId")) console.error("  → STORAGE_ACCESS_KEY is wrong.");
  if (message.includes("AccessDenied")) console.error("  → the key exists but lacks permission on that bucket.");
  process.exit(1);
});
