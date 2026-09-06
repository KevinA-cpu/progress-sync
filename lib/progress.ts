import {
  CAPTURE_PROVENANCE, CAPTURE_STATE, GRADING_VERDICT, MAX_SOURCE_BYTES, PROGRESS_KEY, PROGRESS_MESSAGE,
  PROGRESS_PROVIDER, PROGRESS_TEXT, SOURCE_HASH_ALGORITHM,
} from './constants/progress';
import { browser } from 'wxt/browser';
import { z } from './schema';

export const problemIdSchema = z.string().regex(/^[a-z0-9][a-z0-9_]{0,127}$/);
export const submittedSourceSchema = z.string().min(1).refine(
  source => source.length <= MAX_SOURCE_BYTES
    && new TextEncoder().encode(source).length <= MAX_SOURCE_BYTES,
  { error: PROGRESS_TEXT.sourceTooLarge },
);
export const submittedSourceFieldSchema = z.tuple([submittedSourceSchema]);
export const problemIdFieldSchema = z.tuple([problemIdSchema]);

export const attemptSchema = z.strictObject({
  schemaVersion: z.literal(1),
  id: z.uuid(),
  provider: z.literal(PROGRESS_PROVIDER),
  problemId: problemIdSchema.nullable(),
  source: submittedSourceSchema.nullable(),
  sourceHash: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  submittedAt: z.iso.datetime(),
  observedAt: z.iso.datetime().nullable(),
  state: z.enum(CAPTURE_STATE),
  reason: z.string(),
  requiresReload: z.boolean(),
  provenance: z.strictObject({
    capture: z.literal(CAPTURE_PROVENANCE),
    requestId: z.string().min(1),
    tabId: z.int(),
    frameId: z.int(),
    parentDocumentId: z.string().min(1).nullable(),
    resultDocumentId: z.string().min(1).nullable(),
  }),
}).refine(
  attempt => attempt.state !== CAPTURE_STATE.accepted || (
    attempt.problemId !== null && attempt.source !== null && attempt.sourceHash !== null
    && attempt.observedAt !== null && attempt.provenance.parentDocumentId !== null
    && attempt.provenance.resultDocumentId !== null && !attempt.requiresReload
  ),
  { error: PROGRESS_TEXT.incompleteAcceptance },
);
export const attemptListSchema = z.array(attemptSchema);

export const resultObservationSchema = z.strictObject({
  type: z.literal(PROGRESS_MESSAGE.result),
  problemId: problemIdSchema.nullable(),
  verdict: z.enum(GRADING_VERDICT),
});
export const progressRequestSchema = z.strictObject({ type: z.literal(PROGRESS_MESSAGE.list) });
export const progressReplySchema = z.discriminatedUnion('ok', [
  z.strictObject({ ok: z.literal(true), attempts: attemptListSchema }),
  z.strictObject({ ok: z.literal(false), error: z.string() }),
]);

export type Attempt = z.infer<typeof attemptSchema>;
export type ResultObservation = z.infer<typeof resultObservationSchema>;
export type ProgressReply = z.infer<typeof progressReplySchema>;

export async function readAttempts(): Promise<Attempt[]> {
  const stored: unknown = (await browser.storage.local.get(PROGRESS_KEY))[PROGRESS_KEY];
  if (stored === undefined) return [];
  const parsed = attemptListSchema.safeParse(stored);
  if (!parsed.success) {
    throw new Error(PROGRESS_TEXT.invalidStoredData);
  }
  return parsed.data;
}

export async function hashSource(source: string): Promise<string> {
  const digest = await crypto.subtle.digest(SOURCE_HASH_ALGORITHM, new TextEncoder().encode(source));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}
