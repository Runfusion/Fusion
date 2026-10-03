import { z } from "zod";
import { externalSessionIdentifier, externalSessionUsageSchema } from "./contract.js";

const safeCounter = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const timestamp = z.string().datetime({ offset: true }).transform(value => new Date(value).toISOString());
const transcriptText = (max: number) => z.string().max(max).refine(value => !value.includes("\u0000"), "Transcript text cannot contain NUL bytes");

export const externalSessionFileChangeSchema = z.object({
  path: z.string().min(1).max(4096).refine(value => !value.includes("\u0000")),
  operation: z.enum(["add", "delete", "modify", "rename"]),
  previousPath: z.string().min(1).max(4096).refine(value => !value.includes("\u0000")).optional(),
  addedLines: safeCounter.nullable(),
  removedLines: safeCounter.nullable(),
  patchAvailable: z.boolean(),
  patch: transcriptText(262_144).optional(),
  truncated: z.boolean(),
}).strict().superRefine((value, ctx) => {
  if (value.operation === "rename" && value.previousPath === undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["previousPath"], message: "Renames require the previous path" });
  }
  if (!value.patchAvailable && value.patch !== undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["patch"], message: "Unavailable patches cannot include patch text" });
  }
  if (value.patchAvailable && value.patch === undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["patch"], message: "Available patches require patch text" });
  }
});

const promptSchema = z.object({
  at: timestamp.nullable(),
  text: transcriptText(262_144),
}).strict();


/*
FNXC:ExternalSessionRates 2026-09-24-00:04:
Rates applicable when this turn was ingested. Fusion's catalog is a single current baseline with no effective
dates, so nothing can reconstruct a past rate after the fact: the only way a turn is ever priced at what it
actually cost is to record the rate at the moment it arrives.

This is server-stamped. The field is part of the turn schema because the store revalidates the whole turn, but
the ingest route always OVERWRITES it, so a collector cannot choose the rates its own work is priced at.
A turn without this stamp stays explicitly unpriced-at-recorded-rates; it is never back-filled from today's
catalog and called a billed cost.
*/
const rateSchema = z.object({
  inputPer1M: z.number().min(0).max(1_000_000),
  outputPer1M: z.number().min(0).max(1_000_000),
  cacheReadPer1M: z.number().min(0).max(1_000_000),
  cacheWritePer1M: z.number().min(0).max(1_000_000),
  source: z.string().min(1).max(512),
}).strict();

/*
FNXC:ExternalSessionRates 2026-09-24-04:51 (operator decision F2 = C):
A frozen stamp is preserved by DEFAULT, so a provider price change never rewrites what past work cost. An
operator may still restamp after a CATALOG CORRECTION — a rate that was wrong when it was recorded — and that
is an audited act, not a silent recomputation: the audit keeps who did it, why, and the basis it replaced, so
a restamped figure can always be traced back to the one it superseded.
*/
const restampSchema = z.object({
  actor: z.string().min(1).max(256),
  reason: z.string().min(1).max(1024),
  at: z.string().datetime({ offset: true }).transform(value => new Date(value).toISOString()),
  previousAsOf: z.string().min(1).max(64),
  previousSource: z.string().min(1).max(512),
}).strict();

export const externalSessionTurnPricingSchema = z.object({
  /** Date the recorded rates were current as of. */
  asOf: z.string().min(1).max(64),
  /** Where the basis came from: the built-in baseline or an operator refresh. */
  source: z.string().min(1).max(512),
  /** Applicable rate per `<pricingProvider>:<model>`, exactly as used to price this turn. */
  rates: z.record(z.string().min(1).max(512), rateSchema),
  /** Present only when an operator deliberately replaced an earlier stamp. */
  restamp: restampSchema.optional(),
}).strict();

export type ExternalSessionTurnPricing = z.infer<typeof externalSessionTurnPricingSchema>;

/**
 * Durable provider-neutral turn payload. Missing native telemetry stays null/absent rather
 * than being converted to zero. Historical patches belong to their turn and are bounded;
 * callers must never replace them with a live working-tree diff.
 */
export const externalSessionTurnSchema = z.object({
  nativeTurnId: externalSessionIdentifier,
  revision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  ordinal: safeCounter,
  state: z.enum(["ongoing", "completed", "failed", "interrupted", "unknown"]),
  prompts: z.array(promptSchema).min(1).max(32),
  response: transcriptText(1_048_576).nullable(),
  startedAt: timestamp.nullable(),
  endedAt: timestamp.nullable(),
  durationMs: safeCounter.nullable(),
  durationSource: z.enum(["native", "derived"]).nullable(),
  toolCallCount: safeCounter.nullable(),
  fileChanges: z.array(externalSessionFileChangeSchema).max(128),
  /*
  FNXC:ExternalSessionUsage 2026-09-23-23:24: Measured per-request usage for this turn, so a turn's cost is
  priced from what the provider reported rather than apportioned from the session total. Optional because a
  provider or an older collector may report none, and absent must stay distinguishable from zero.
  requestId keys the record so a rewritten transcript cannot double count.
  */
  usage: z.array(externalSessionUsageSchema.extend({ requestId: externalSessionIdentifier })).max(64).optional(),
  usageComplete: z.boolean().optional(),
  /** Whole input of the newest request: what the model actually saw, against the provider window. */
  contextTokens: safeCounter.nullable().optional(),
  contextCapacity: safeCounter.nullable().optional(),
  pricing: externalSessionTurnPricingSchema.optional(),
}).strict().superRefine((value, ctx) => {
  if ((value.durationMs === null) !== (value.durationSource === null)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["durationSource"], message: "Duration value and source must be reported together" });
  }
  if (value.startedAt !== null && value.endedAt !== null && Date.parse(value.endedAt) < Date.parse(value.startedAt)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["endedAt"], message: "Turn cannot end before it starts" });
  }
  if (value.state === "ongoing" && value.endedAt !== null) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["endedAt"], message: "Ongoing turns cannot have an end timestamp" });
  }
});

const sessionReadId = z.string().regex(/^[a-f0-9]{64}$/);
export const externalSessionTurnIngestionSchema = z.object({
  schemaVersion: z.literal(1),
  eventId: externalSessionIdentifier,
  sessionId: sessionReadId,
  turn: externalSessionTurnSchema,
}).strict();

export type ExternalSessionFileChange = z.infer<typeof externalSessionFileChangeSchema>;
export type ExternalSessionTurn = z.infer<typeof externalSessionTurnSchema>;
export type ExternalSessionTurnIngestion = z.infer<typeof externalSessionTurnIngestionSchema>;
