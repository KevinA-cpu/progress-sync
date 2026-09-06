import { browser } from 'wxt/browser';
import { z } from './schema';

export const PROGRESS_KEY = 'attempts-v1';
export const HDL_ORIGIN = 'https://hdlbits.01xz.net';
export const GRADING_URL = `${HDL_ORIGIN}/runsim.php`;
export const MAX_SOURCE_BYTES = 256 * 1024;
export const RESULT_TIMEOUT_MS = 120_000;

export const problemIdSchema = z.string().regex(/^[a-z0-9][a-z0-9_]{0,127}$/);
export const submittedSourceSchema = z.string().min(1).refine(
  source => source.length <= MAX_SOURCE_BYTES
    && new TextEncoder().encode(source).length <= MAX_SOURCE_BYTES,
  { error: 'Submitted source exceeds the byte limit.' },
);
export const submittedSourceFieldSchema = z.tuple([submittedSourceSchema]);
export const problemIdFieldSchema = z.tuple([problemIdSchema]);

export const attemptSchema = z.strictObject({
  schemaVersion: z.literal(1),
  id: z.uuid(),
  provider: z.literal('hdlbits'),
  problemId: problemIdSchema.nullable(),
  source: submittedSourceSchema.nullable(),
  sourceHash: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  submittedAt: z.iso.datetime(),
  observedAt: z.iso.datetime().nullable(),
  state: z.enum(['pending', 'accepted', 'unverified']),
  reason: z.string(),
  requiresReload: z.boolean(),
  provenance: z.strictObject({
    capture: z.literal('browser-post'),
    requestId: z.string().min(1),
    tabId: z.int(),
    frameId: z.int(),
    parentDocumentId: z.string().min(1).nullable(),
    resultDocumentId: z.string().min(1).nullable(),
  }),
}).refine(
  attempt => attempt.state !== 'accepted' || (
    attempt.problemId !== null && attempt.source !== null && attempt.sourceHash !== null
    && attempt.observedAt !== null && attempt.provenance.parentDocumentId !== null
    && attempt.provenance.resultDocumentId !== null && !attempt.requiresReload
  ),
  { error: 'Accepted attempts require complete source and result provenance.' },
);
export const attemptListSchema = z.array(attemptSchema);

export const resultObservationSchema = z.strictObject({
  type: z.literal('hdlbits:result'),
  problemId: problemIdSchema.nullable(),
  verdict: z.enum(['success', 'failure', 'unknown']),
});
export const progressRequestSchema = z.strictObject({ type: z.literal('progress:list') });
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
    throw new Error('Local progress is invalid or unsupported. It has not been overwritten.');
  }
  return parsed.data;
}

export async function hashSource(source: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(source));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}
