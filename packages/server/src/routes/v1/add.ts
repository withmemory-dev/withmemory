import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import * as schema from "../../db/schema";
import { SCOPE_MAX_LENGTH, zodErrorHook } from "../../lib/validation";
import type { WorkerEnv, AppVariables } from "../../types";
import { ensureEndUser } from "../../lib/end-users";
import { embedTexts } from "../../lib/embeddings";
import { checkMemoryQuota, PlanEnforcementError } from "../../lib/plan-enforcement";
import { addWithExtraction, ExtractionError } from "../../lib/add-with-extraction";
import { parseMaxInputBytes } from "../../lib/extraction";
import EXTRACTION_PROMPT from "../../lib/extraction-prompt.txt";

const { wmMemories } = schema;

const AddRequestSchema = z
  .object({
    scope: z.string().min(1).max(SCOPE_MAX_LENGTH),
    key: z.string().min(1).max(128).optional(),
    value: z.string().min(1).max(16384),
  })
  .strict();

const validator = zValidator("json", AddRequestSchema, zodErrorHook);

export function addRoute() {
  const app = new Hono<{ Bindings: WorkerEnv; Variables: AppVariables }>();

  app.post("/memories", validator, async (c) => {
    const db = c.get("db");
    const account = c.get("account");
    const { scope, key, value } = c.req.valid("json");

    // Quota check: reject before any DB write or API call
    try {
      await checkMemoryQuota(db, account, 1);
    } catch (e) {
      if (e instanceof PlanEnforcementError) {
        const body = e.toResponseBody();
        body.error.request_id = c.get("requestId");
        return c.json(body, 403);
      }
      throw e;
    }

    const endUser = await ensureEndUser(db, account.id, scope);

    if (key !== undefined) {
      // Explicit path: direct write, no extraction
      let embedding: number[] | null = null;
      const apiKey = c.env.OPENAI_API_KEY;
      if (apiKey && value.length >= 20) {
        try {
          const results = await embedTexts(apiKey, [value]);
          embedding = results[0] ?? null;
        } catch (err) {
          console.warn(
            `add: embedding failed for key="${key}" (account=${account.id}): ${
              err instanceof Error ? err.message : "unknown error"
            }`
          );
        }
      }

      const [memory] = await db
        .insert(wmMemories)
        .values({
          accountId: account.id,
          endUserId: endUser.id,
          key,
          content: value,
          source: "explicit",
          embedding,
        })
        .onConflictDoUpdate({
          target: [wmMemories.accountId, wmMemories.endUserId, wmMemories.key],
          set: {
            content: value,
            embedding,
            updatedAt: new Date(),
          },
        })
        .returning();

      return c.json({
        memories: [
          {
            id: memory.id,
            scope,
            key: memory.key!,
            value: memory.content,
            source: memory.source,
            status: memory.status,
            statusError: memory.statusError,
            createdAt: memory.createdAt.toISOString(),
            updatedAt: memory.updatedAt.toISOString(),
          },
        ],
        request_id: c.get("requestId"),
      });
    } else {
      // Extraction path: synchronous LLM extraction
      const maxBytes = parseMaxInputBytes(c.env.EXTRACTION_MAX_INPUT_BYTES);
      const encoder = new TextEncoder();
      const actualBytes = encoder.encode(value).byteLength;
      if (actualBytes > maxBytes) {
        return c.json(
          {
            error: {
              code: "invalid_request",
              message: "Value exceeds maximum size for extraction",
              request_id: c.get("requestId"),
              details: { maxBytes, actualBytes },
            },
          },
          400
        );
      }

      const extractionPrompt = account.extractionPrompt ?? EXTRACTION_PROMPT;
      const promptVersion = account.extractionPrompt
        ? "custom"
        : c.env.EXTRACTION_PROMPT_VERSION || null;
      const idempotencyKey = c.req.header("Idempotency-Key");

      try {
        const memories = await addWithExtraction(
          {
            db,
            env: c.env,
            account,
            endUser,
            value,
            extractionPrompt,
            promptVersion,
            idempotencyKey,
          },
          scope
        );
        return c.json({ memories, request_id: c.get("requestId") });
      } catch (err) {
        if (err instanceof ExtractionError) {
          return c.json(
            { error: { code: err.code, message: err.message, request_id: c.get("requestId") } },
            err.status as 500
          );
        }
        console.error("Extraction failed:", err);
        return c.json(
          {
            error: {
              code: "extraction_failed",
              message: "Extraction pipeline failed",
              request_id: c.get("requestId"),
            },
          },
          500
        );
      }
    }
  });

  return app;
}
