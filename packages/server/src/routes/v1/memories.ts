import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { eq, and, isNull, or, ilike, gt, lt, sql, type SQL } from "drizzle-orm";
import * as schema from "../../db/schema";
import { SCOPE_MAX_LENGTH, zodErrorHook } from "../../lib/validation";
import { findEndUser } from "../../lib/end-users";
import type { WorkerEnv, AppVariables } from "../../types";

const { wmMemories, wmEndUsers } = schema;

// ─── UUID v4 regex for path param validation ─────────────────────────────────
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ─── List memories schema ────────────────────────────────────────────────────

const listMemoriesSchema = z.object({
  forScope: z.string().min(1).max(SCOPE_MAX_LENGTH).optional(),
  source: z.enum(["explicit", "extracted", "all"]).optional().default("all"),
  search: z.string().min(1).max(500).optional(),
  createdAfter: z.string().datetime().optional(),
  createdBefore: z.string().datetime().optional(),
  orderBy: z
    .enum(["updatedAt", "createdAt", "importance", "lastRecalledAt"])
    .optional()
    .default("updatedAt"),
  orderDir: z.enum(["desc", "asc"]).optional().default("desc"),
  limit: z.number().int().min(1).max(200).optional().default(50),
  cursor: z.string().optional(),
  includeTotal: z.boolean().optional().default(false),
});

const listValidator = zValidator("json", listMemoriesSchema, zodErrorHook);

// ─── Order column mapping ────────────────────────────────────────────────────

const ORDER_COLUMNS = {
  updatedAt: wmMemories.updatedAt,
  createdAt: wmMemories.createdAt,
  importance: wmMemories.importance,
  lastRecalledAt: wmMemories.lastRecalledAt,
} as const;

type OrderByField = keyof typeof ORDER_COLUMNS;

// ─── Cursor helpers ──────────────────────────────────────────────────────────
// Cursors are opaque to the client. Internal format is base64-encoded JSON.

type CursorPayload = { v: string | null; id: string };

function encodeCursor(orderValue: string | null, id: string): string {
  return btoa(JSON.stringify({ v: orderValue, id }));
}

function decodeCursor(raw: string): CursorPayload | null {
  try {
    const json = JSON.parse(atob(raw));
    if (typeof json !== "object" || json === null) return null;
    if (typeof json.id !== "string") return null;
    if (json.v !== null && typeof json.v !== "string") return null;
    return json as CursorPayload;
  } catch {
    return null;
  }
}

function getOrderValue(
  row: { updatedAt: Date; createdAt: Date; importance: number; lastRecalledAt: Date | null },
  orderBy: OrderByField
): string | null {
  switch (orderBy) {
    case "updatedAt":
      return row.updatedAt.toISOString();
    case "createdAt":
      return row.createdAt.toISOString();
    case "importance":
      return row.importance.toString();
    case "lastRecalledAt":
      return row.lastRecalledAt?.toISOString() ?? null;
  }
}

// ─── Route ───────────────────────────────────────────────────────────────────

export function memoriesRoute() {
  const app = new Hono<{ Bindings: WorkerEnv; Variables: AppVariables }>();

  // POST /v1/memories/list — list memories with filtering, search, cursor pagination
  app.post("/memories/list", listValidator, async (c) => {
    const db = c.get("db");
    const account = c.get("account");
    const {
      forScope,
      source,
      search,
      createdAfter,
      createdBefore,
      orderBy,
      orderDir,
      limit,
      cursor,
      includeTotal,
    } = c.req.valid("json");

    // ── Resolve optional forScope to end_user_id ─────────────────────────
    let endUserId: string | undefined;
    if (forScope) {
      const endUser = await findEndUser(db, account.id, forScope);
      if (!endUser) {
        return c.json({
          memories: [],
          nextCursor: null,
          ...(includeTotal ? { total: 0 } : {}),
          request_id: c.get("requestId"),
        });
      }
      endUserId = endUser.id;
    }

    // ── Build base WHERE conditions (shared by count + main query) ───────
    const baseConditions: SQL[] = [
      eq(wmMemories.accountId, account.id),
      isNull(wmMemories.supersededBy),
    ];

    if (endUserId) {
      baseConditions.push(eq(wmMemories.endUserId, endUserId));
    }

    if (source !== "all") {
      baseConditions.push(eq(wmMemories.source, source));
    }

    if (search) {
      // Escape LIKE wildcards in user input so % and _ are matched literally
      const escaped = search.replace(/[%_\\]/g, "\\$&");
      baseConditions.push(
        or(ilike(wmMemories.key, `%${escaped}%`), ilike(wmMemories.content, `%${escaped}%`))!
      );
    }

    if (createdAfter) {
      baseConditions.push(gt(wmMemories.createdAt, new Date(createdAfter)));
    }

    if (createdBefore) {
      baseConditions.push(lt(wmMemories.createdAt, new Date(createdBefore)));
    }

    // ── Optional total count (same filters, no cursor/limit) ─────────────
    let total: number | undefined;
    if (includeTotal) {
      const [row] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(wmMemories)
        .where(and(...baseConditions));
      total = row.count;
    }

    // ── Cursor condition (added only to the main query) ──────────────────
    const mainConditions = [...baseConditions];
    const col = ORDER_COLUMNS[orderBy];

    if (cursor) {
      const decoded = decodeCursor(cursor);
      if (!decoded) {
        return c.json(
          {
            error: {
              code: "invalid_request",
              message: "Invalid cursor",
              request_id: c.get("requestId"),
            },
          },
          400
        );
      }

      if (decoded.v === null) {
        // Cursor row had a null value — continue within the null group
        if (orderDir === "desc") {
          mainConditions.push(sql`(${col} IS NULL AND ${wmMemories.id} < ${decoded.id}::uuid)`);
        } else {
          mainConditions.push(sql`(${col} IS NULL AND ${wmMemories.id} > ${decoded.id}::uuid)`);
        }
      } else {
        // Cast the cursor value to the column's Postgres type
        const cv =
          orderBy === "importance" ? sql`${decoded.v}::real` : sql`${decoded.v}::timestamptz`;

        // Keyset pagination: continue past the cursor position.
        // NULLS LAST means null values come after all non-nulls regardless
        // of ASC/DESC, so non-null cursors include `OR col IS NULL` to
        // correctly transition into the null section on the next page.
        if (orderDir === "desc") {
          mainConditions.push(
            sql`(${col} < ${cv} OR (${col} = ${cv} AND ${wmMemories.id} < ${decoded.id}::uuid) OR ${col} IS NULL)`
          );
        } else {
          mainConditions.push(
            sql`(${col} > ${cv} OR (${col} = ${cv} AND ${wmMemories.id} > ${decoded.id}::uuid) OR ${col} IS NULL)`
          );
        }
      }
    }

    // ── ORDER BY with NULLS LAST + id tiebreaker ─────────────────────────
    const orderClause =
      orderDir === "desc"
        ? sql`${col} DESC NULLS LAST, ${wmMemories.id} DESC`
        : sql`${col} ASC NULLS LAST, ${wmMemories.id} ASC`;

    // ── Execute main query (limit+1 to detect next page) ─────────────────
    const rows = await db
      .select({
        id: wmMemories.id,
        key: wmMemories.key,
        content: wmMemories.content,
        source: wmMemories.source,
        status: wmMemories.status,
        statusError: wmMemories.statusError,
        importance: wmMemories.importance,
        lastRecalledAt: wmMemories.lastRecalledAt,
        createdAt: wmMemories.createdAt,
        updatedAt: wmMemories.updatedAt,
        externalUserId: wmEndUsers.externalId,
      })
      .from(wmMemories)
      .innerJoin(wmEndUsers, eq(wmMemories.endUserId, wmEndUsers.id))
      .where(and(...mainConditions))
      .orderBy(orderClause)
      .limit(limit + 1);

    // ── Pagination: detect next page, compute cursor ─────────────────────
    const hasMore = rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;

    let nextCursor: string | null = null;
    if (hasMore) {
      const lastRow = pageRows[pageRows.length - 1];
      nextCursor = encodeCursor(getOrderValue(lastRow, orderBy), lastRow.id);
    }

    // ── Map to Memory response shape (explicit column projection) ────────
    const memories = pageRows.map((r) => ({
      id: r.id,
      forScope: r.externalUserId,
      forKey: r.key,
      value: r.content,
      source: r.source as "explicit" | "extracted",
      status: r.status,
      statusError: r.statusError,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    }));

    return c.json({
      memories,
      nextCursor,
      ...(includeTotal ? { total } : {}),
      request_id: c.get("requestId"),
    });
  });

  // ── DELETE /v1/memories/:id — delete a single memory by ID ─────────────
  app.delete("/memories/:id", async (c) => {
    const db = c.get("db");
    const account = c.get("account");
    const memoryId = c.req.param("id");

    if (!UUID_RE.test(memoryId)) {
      return c.json(
        {
          error: {
            code: "invalid_request",
            message: "Invalid memory ID format",
            request_id: c.get("requestId"),
          },
        },
        400
      );
    }

    const result = await db
      .delete(wmMemories)
      .where(and(eq(wmMemories.id, memoryId), eq(wmMemories.accountId, account.id)))
      .returning({ id: wmMemories.id });

    return c.json({ deleted: result.length > 0, request_id: c.get("requestId") });
  });

  return app;
}
