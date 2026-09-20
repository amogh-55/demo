import fs from "node:fs";
import path from "node:path";

/**
 * Loads .env.local then .env for the standalone scripts, matching Next's own
 * precedence. Uses Node's built-in loader, so no dotenv dependency.
 */
export function config(): void {
  for (const file of [".env.local", ".env"]) {
    const full = path.resolve(process.cwd(), file);
    if (!fs.existsSync(full)) continue;
    try {
      process.loadEnvFile(full);
    } catch {
      // A malformed line should not stop the script; the missing-variable check reports it.
    }
  }
}
