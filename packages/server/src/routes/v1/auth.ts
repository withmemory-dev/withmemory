import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { eq, and, gt, isNull, sql } from "drizzle-orm";
import * as schema from "../../db/schema";
import type { WorkerEnv, AppVariables } from "../../types";
import { zodErrorHook } from "../../lib/validation";
import { sha256Hex } from "../../lib/hash";
import { getClientIp } from "../../lib/ip";

const { wmAuthCodes, wmAccounts, wmApiKeys } = schema;

// ─── Zod schemas ──────────────────────────────────────────────────────────

const RequestCodeSchema = z
  .object({
    email: z.string().email().max(255),
  })
  .strict();

const VerifyCodeSchema = z
  .object({
    email: z.string().email().max(255),
    code: z.string().length(6),
  })
  .strict();

// ─── Route factory ──────────────────────────────────────────────────────────

export function authRoute() {
  const app = new Hono<{ Bindings: WorkerEnv; Variables: AppVariables }>();

  // ─── POST /auth/request-code — send a verification code ───────────────
  app.post("/auth/request-code", zValidator("json", RequestCodeSchema, zodErrorHook), async (c) => {
    const db = c.get("db");
    const { email } = c.req.valid("json");
    const normalizedEmail = email.toLowerCase();
    const ip = getClientIp(c);

    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);

    // Per-IP rate limit — 20 codes/hour. Catches automated abuse (cycling
    // email addresses from a single source to burn sending reputation) while
    // leaving headroom for shared IPs like corporate NATs and VPNs.
    if (ip !== "unknown") {
      const [ipCountRow] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(wmAuthCodes)
        .where(and(eq(wmAuthCodes.ipAddress, ip), gt(wmAuthCodes.createdAt, oneHourAgo)));

      if ((ipCountRow?.count ?? 0) >= 20) {
        return c.json(
          {
            error: {
              code: "rate_limited",
              message: "Too many code requests from this network. Try again later.",
              request_id: c.get("requestId"),
            },
          },
          429
        );
      }
    }

    // Per-email rate limit: 3 codes per email per hour
    const [countRow] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(wmAuthCodes)
      .where(and(eq(wmAuthCodes.email, normalizedEmail), gt(wmAuthCodes.createdAt, oneHourAgo)));

    if ((countRow?.count ?? 0) >= 3) {
      return c.json(
        {
          error: {
            code: "rate_limited",
            message: "Too many code requests. Try again in an hour.",
            request_id: c.get("requestId"),
          },
        },
        429
      );
    }

    // Generate 6-digit code using a CSPRNG. Modulo bias is ~0.00002% which is
    // negligible for a 6-digit code; rejection sampling would be overkill.
    const codeBuf = new Uint32Array(1);
    crypto.getRandomValues(codeBuf);
    const code = (100000 + (codeBuf[0] % 900000)).toString();
    const codeHash = await sha256Hex(code);
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

    await db.insert(wmAuthCodes).values({
      email: normalizedEmail,
      codeHash,
      ipAddress: ip === "unknown" ? null : ip,
      expiresAt,
    });

    // Send email via Resend
    const resendKey = c.env.RESEND_API_KEY;
    if (resendKey) {
      try {
        await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${resendKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            from: "WithMemory <noreply@mail.reprom.run>",
            to: [normalizedEmail],
            subject: "Your WithMemory verification code",
            text: `Your verification code is: ${code}\n\nThis code expires in 10 minutes.\n\nIf you didn't request this, you can safely ignore this email.`,
            html: `<p>Your verification code is:</p><h1 style="font-family: monospace; font-size: 32px; letter-spacing: 8px;">${code}</h1><p>This code expires in 10 minutes.</p><p style="color: #666;">If you didn't request this, you can safely ignore this email.</p>`,
          }),
        });
      } catch (err) {
        console.error("Resend email failed:", err);
      }
    } else {
      console.warn("RESEND_API_KEY not configured, skipping email send");
    }

    return c.json({
      result: { sent: true },
      request_id: c.get("requestId"),
    });
  });

  // ─── POST /auth/verify-code — verify code and return API key ──────────
  app.post("/auth/verify-code", zValidator("json", VerifyCodeSchema, zodErrorHook), async (c) => {
    const db = c.get("db");
    const { email, code } = c.req.valid("json");
    const normalizedEmail = email.toLowerCase();

    // Find the most recent unused, unexpired code for this email
    const [authCode] = await db
      .select()
      .from(wmAuthCodes)
      .where(
        and(
          eq(wmAuthCodes.email, normalizedEmail),
          isNull(wmAuthCodes.usedAt),
          gt(wmAuthCodes.expiresAt, new Date())
        )
      )
      .orderBy(sql`${wmAuthCodes.createdAt} DESC`)
      .limit(1);

    if (!authCode) {
      return c.json(
        {
          error: {
            code: "invalid_code",
            message: "Invalid or expired verification code",
            request_id: c.get("requestId"),
          },
        },
        401
      );
    }

    // Check lock
    if (authCode.lockedUntil && authCode.lockedUntil.getTime() > Date.now()) {
      return c.json(
        {
          error: {
            code: "rate_limited",
            message: "Too many attempts. Try again later.",
            details: { locked_until: authCode.lockedUntil.toISOString() },
            request_id: c.get("requestId"),
          },
        },
        429
      );
    }

    // Verify code
    const providedHash = await sha256Hex(code);
    if (providedHash !== authCode.codeHash) {
      const newAttempts = authCode.attempts + 1;
      const lockUpdate: Record<string, unknown> = { attempts: newAttempts };
      if (newAttempts >= 5) {
        lockUpdate.lockedUntil = new Date(Date.now() + 30 * 60 * 1000);
      }
      await db.update(wmAuthCodes).set(lockUpdate).where(eq(wmAuthCodes.id, authCode.id));

      return c.json(
        {
          error: {
            code: "invalid_code",
            message: "Invalid or expired verification code",
            request_id: c.get("requestId"),
          },
        },
        401
      );
    }

    // Code matches — mark as used
    await db
      .update(wmAuthCodes)
      .set({ usedAt: new Date() })
      .where(eq(wmAuthCodes.id, authCode.id));

    // Look up or create account
    let accountId: string;
    let isNewAccount = false;

    const [existingAccount] = await db
      .select({ id: wmAccounts.id })
      .from(wmAccounts)
      .where(eq(wmAccounts.email, normalizedEmail))
      .limit(1);

    if (existingAccount) {
      accountId = existingAccount.id;
    } else {
      const [newAccount] = await db
        .insert(wmAccounts)
        .values({ email: normalizedEmail })
        .returning({ id: wmAccounts.id });
      accountId = newAccount.id;
      isNewAccount = true;
    }

    // Generate API key
    const randomBuf = new Uint8Array(32);
    crypto.getRandomValues(randomBuf);
    const rawRandom = btoa(String.fromCharCode(...randomBuf))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    const rawKey = `wm_live_${rawRandom}`;
    const keyPrefix = rawKey.slice(0, 11);
    const keyHash = await sha256Hex(rawKey);

    await db.insert(wmApiKeys).values({
      accountId,
      keyHash,
      keyPrefix,
      issuedTo: "Agent-created key",
      scopes: "memory:read,memory:write,account:admin",
    });

    return c.json({
      result: {
        apiKey: rawKey,
        accountId,
        isNewAccount,
      },
      request_id: c.get("requestId"),
    });
  });

  return app;
}
