import {
  CAPTURE_PROVENANCE, CAPTURE_STATE, GRADING_VERDICT, HDL_STATUS_HEADING, isFailedVerdict, MAX_SOURCE_BYTES,
  PROGRESS_KEY, PROGRESS_MESSAGE, PROGRESS_PROVIDER, PROGRESS_TEXT, SOURCE_HASH_ALGORITHM,
  type GradingVerdict,
} from './constants/progress';
import { ARTIFACT_STATE, DIAGRAM_REJECTION, MAX_DIAGRAM_REJECTIONS, MAX_DIAGRAMS } from './constants/report';
import { browser } from 'wxt/browser';
import {
  capturedReportSchema, describesProblem, diagramImagesSchema, diagramSchema, reportFieldsSchema,
} from './report';
import { z } from './schema';

// The status lines this provider states, read as the verdicts they are. Anything else is not a stated outcome.
const statedVerdict: Record<string, GradingVerdict | undefined> = HDL_STATUS_HEADING;

export const problemIdSchema = z.string().regex(/^[a-z0-9][a-z0-9_]{0,127}$/);
export const sourceHashSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const submittedSourceSchema = z.string().min(1).refine(
  source => source.length <= MAX_SOURCE_BYTES && sourceByteLength(source) <= MAX_SOURCE_BYTES,
  { error: PROGRESS_TEXT.sourceTooLarge },
);
export const submittedSourceFieldSchema = z.tuple([submittedSourceSchema]);
export const problemIdFieldSchema = z.tuple([problemIdSchema]);

interface CaptureEvidence {
  problemId: string | null;
  source: string | null;
  sourceHash: string | null;
  observedAt: string | null;
  requiresReload: boolean;
  provenance: { parentDocumentId: string | null; resultDocumentId: string | null };
}
// The evidence a recorded outcome needs: the submitted bytes, and the result document they were correlated with.
function complete(attempt: CaptureEvidence): boolean {
  return attempt.problemId !== null && attempt.source !== null && attempt.sourceHash !== null
    && attempt.observedAt !== null && attempt.provenance.parentDocumentId !== null
    && attempt.provenance.resultDocumentId !== null && !attempt.requiresReload;
}

export const attemptSchema = z.strictObject({
  schemaVersion: z.literal(1),
  id: z.uuid(),
  provider: z.literal(PROGRESS_PROVIDER),
  problemId: problemIdSchema.nullable(),
  source: submittedSourceSchema.nullable(),
  sourceHash: sourceHashSchema.nullable(),
  submittedAt: z.iso.datetime(),
  observedAt: z.iso.datetime().nullable(),
  state: z.enum(CAPTURE_STATE),
  reason: z.string(),
  requiresReload: z.boolean(),
  // Both are absent on attempts captured before outcomes and reports existed, which stay readable unchanged.
  // A report is stored for every stated outcome, passed included, and is never invented for an import.
  outcome: z.enum(GRADING_VERDICT).optional(),
  report: capturedReportSchema.optional(),
  provenance: z.strictObject({
    capture: z.literal(CAPTURE_PROVENANCE),
    requestId: z.string().min(1),
    tabId: z.int(),
    frameId: z.int(),
    parentDocumentId: z.string().min(1).nullable(),
    resultDocumentId: z.string().min(1).nullable(),
  }),
}).refine(
  // Acceptance means the result stated success. Attempts recorded before outcomes existed carry none and stay
  // readable; anything that carries one has to carry exactly that one, so a refused result can never be stored
  // as accepted.
  attempt => attempt.state !== CAPTURE_STATE.accepted || (
    complete(attempt) && (attempt.outcome === undefined || attempt.outcome === GRADING_VERDICT.success)
  ),
  { error: PROGRESS_TEXT.incompleteAcceptance },
// A failed attempt needs the same correlated evidence as an accepted one, plus the stated outcome and the
// report observed with it: an absent report can never become a recorded failure.
).refine(
  attempt => attempt.state !== CAPTURE_STATE.failed || (
    complete(attempt) && attempt.outcome !== undefined && isFailedVerdict(attempt.outcome)
    && attempt.report !== undefined
  ),
  { error: PROGRESS_TEXT.incompleteFailure },
// A stored report describes the attempt it is stored with: its attribution names this problem's page, and the
// status line it states is the one the recorded outcome was read from. Neither can be edited into agreeing
// with something the other does not say.
).refine(
  attempt => attempt.report === undefined
    || (attempt.problemId !== null && describesProblem(attempt.report, attempt.problemId)
      && (attempt.outcome === undefined || statedVerdict[attempt.report.status] === attempt.outcome)),
  { error: PROGRESS_TEXT.inconsistentReport },
);
export const attemptListSchema = z.array(attemptSchema);

export const resultObservationSchema = z.strictObject({
  type: z.literal(PROGRESS_MESSAGE.result),
  problemId: problemIdSchema.nullable(),
  verdict: z.enum(GRADING_VERDICT),
  report: capturedReportSchema.nullable(),
});
// The second half of one observation: what the same result document drew and stated once it stopped changing.
// It carries no verdict, so nothing here can turn a recorded failure into a pass.
export const artifactObservationSchema = z.strictObject({
  type: z.literal(PROGRESS_MESSAGE.artifacts),
  problemId: problemIdSchema,
  state: z.enum(ARTIFACT_STATE).exclude([ARTIFACT_STATE.pending]),
  messages: reportFieldsSchema.shape.messages,
  partialMessages: z.boolean(),
  diagrams: z.array(diagramSchema).max(MAX_DIAGRAMS),
  images: diagramImagesSchema,
  rejected: z.array(z.enum(DIAGRAM_REJECTION)).max(MAX_DIAGRAM_REJECTIONS),
}).refine(observation => observation.images.length === observation.diagrams.length
  && observation.diagrams.every((diagram, index) => observation.images[index]?.name === diagram.name));
export const progressRequestSchema = z.strictObject({ type: z.literal(PROGRESS_MESSAGE.list) });
export const progressReplySchema = z.discriminatedUnion('ok', [
  z.strictObject({ ok: z.literal(true), attempts: attemptListSchema }),
  z.strictObject({ ok: z.literal(false), error: z.string() }),
]);

export type Attempt = z.infer<typeof attemptSchema>;
export type ResultObservation = z.infer<typeof resultObservationSchema>;
export type ArtifactObservation = z.infer<typeof artifactObservationSchema>;
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

export function sourceByteLength(source: string): number {
  return new TextEncoder().encode(source).length;
}

export async function hashSource(source: string): Promise<string> {
  const digest = await crypto.subtle.digest(SOURCE_HASH_ALGORITHM, new TextEncoder().encode(source));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}
