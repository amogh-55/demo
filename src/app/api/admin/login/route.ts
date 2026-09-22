import { fail, ok, readJson } from "@/lib/api";
import { authenticateAdmin, startSession } from "@/lib/auth";
import { appError } from "@/lib/errors";
import { clientIp, rateLimit, resetRateLimit } from "@/lib/rate-limit";
import { adminLoginSchema } from "@/lib/validation";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const ip = clientIp(request.headers);
  try {
    // Two limits: one per source address, one per account, so neither a single
    // attacker nor a distributed one can grind a password.
    await rateLimit(`login-ip:${ip}`, 10, 300, { shared: true });

    const input = adminLoginSchema.parse(await readJson(request));
    await rateLimit(`login-user:${input.username.toLowerCase()}`, 8, 300, { shared: true });

    const session = await authenticateAdmin(input.username.toLowerCase(), input.password);
    // Deliberately identical response whether the username exists or not.
    if (!session) throw appError("UNAUTHORIZED", "Incorrect username or password.");

    await startSession(session);
    await resetRateLimit(`login-user:${input.username.toLowerCase()}`);

    return ok({ user: { username: session.username, displayName: session.displayName } });
  } catch (err) {
    return fail(err, { route: "POST /api/admin/login", ip });
  }
}
