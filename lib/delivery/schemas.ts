import { z } from '../schema';
import {
  DELIVERY_FAILURE, DELIVERY_MESSAGE, DELIVERY_RETRY, DELIVERY_STATE, DELIVERY_TEXT, GIT_MODE, GIT_OBJECT,
  MAX_METADATA_BYTES, MAX_TREE_ENTRIES, PUBLICATION_LAYOUT, RECORD_KIND,
} from '../constants/delivery';
import {
  CAPTURE_PROVENANCE, CAPTURE_STATE, FAILED_VERDICT, GRADING_VERDICT, HDL_ORIGIN, PROGRESS_PROVIDER,
} from '../constants/progress';
import { ARTIFACT_STATE, DIAGRAM_NAME, MAX_REPORT_BYTES, REPORT_KIND } from '../constants/report';
import { consistent, describesProblem, finalizedReportSchema, reportFieldsSchema } from '../report';
import { attemptSchema, problemIdSchema, sourceHashSchema, submittedSourceSchema } from '../progress';
import { destinationTargetSchema } from '../destination/schemas';
import { IMPORT_SNAPSHOT_KIND } from '../constants/import';
import { importedSnapshotSchema, type ImportedSnapshot } from '../import/schemas';
import { GITHUB_COMPARISON, GITHUB_CONTENT, GITHUB_PAGINATION, githubBase64CharacterLimit } from '../constants/github';

export const gitShaSchema = z.string().regex(/^[a-f0-9]{40}$/);
export const gitObjectSchema = z.object({ sha: gitShaSchema });
export const metadataBlobSchema = z.object({
  sha: gitShaSchema, size: z.int().nonnegative().max(MAX_METADATA_BYTES), encoding: z.literal(GITHUB_CONTENT.base64),
  content: z.string().max(githubBase64CharacterLimit(MAX_METADATA_BYTES)),
});
export { sourceHashSchema };
// A snapshot is the immutable copy a job publishes, so its report has to be one the artifact phase finished:
// nothing still being observed is ever sent.
export const acceptedSnapshotSchema = attemptSchema.safeExtend({
  state: z.literal(CAPTURE_STATE.accepted), problemId: problemIdSchema, source: submittedSourceSchema,
  sourceHash: sourceHashSchema, observedAt: z.iso.datetime(), report: finalizedReportSchema.optional(),
});
export type AcceptedSnapshot = z.infer<typeof acceptedSnapshotSchema>;
// A failed attempt carries the same correlated evidence as an accepted one plus its stated outcome and the
// report observed with it. It is a separate shape, so no failed record can ever satisfy the accepted schema.
export const failedSnapshotSchema = attemptSchema.safeExtend({
  state: z.literal(CAPTURE_STATE.failed), problemId: problemIdSchema, source: submittedSourceSchema,
  sourceHash: sourceHashSchema, observedAt: z.iso.datetime(),
  outcome: z.enum(FAILED_VERDICT), report: finalizedReportSchema,
});
export type FailedSnapshot = z.infer<typeof failedSnapshotSchema>;
// Imports ride the same publication transport but keep their own snapshot shape and metadata.
export const deliverySnapshotSchema = z.union([acceptedSnapshotSchema, failedSnapshotSchema, importedSnapshotSchema]);
export type DeliverySnapshot = z.infer<typeof deliverySnapshotSchema>;
export function isImportedSnapshot(snapshot: DeliverySnapshot): snapshot is ImportedSnapshot {
  return 'kind' in snapshot && snapshot.kind === IMPORT_SNAPSHOT_KIND;
}
export function isFailedSnapshot(snapshot: DeliverySnapshot): snapshot is FailedSnapshot {
  return !isImportedSnapshot(snapshot) && snapshot.state === CAPTURE_STATE.failed;
}
export const acceptanceRecordSchema = z.strictObject({
  schemaVersion: z.literal(1), provider: z.literal(PROGRESS_PROVIDER), problemId: problemIdSchema,
  attemptId: z.uuid(), sourceHash: sourceHashSchema,
  submittedAt: z.iso.datetime(), observedAt: z.iso.datetime(),
  // Absent on records published before accepted attempts carried a report; those stay valid unchanged. When
  // present, the exact report bytes published with the record are pinned here.
  reportHash: sourceHashSchema.optional(), reportBytes: z.int().positive().max(MAX_REPORT_BYTES).optional(),
  provenance: z.strictObject({ capture: z.literal(CAPTURE_PROVENANCE), verdict: z.literal(GRADING_VERDICT.success) }),
}).refine(record => (record.reportHash === undefined) === (record.reportBytes === undefined));
// A published failed record states its kind and outcome, and points at the exact report bytes stored with it.
// It has no verdict a reader could confuse with acceptance and no field the acceptance schema would accept.
export const failedRecordSchema = z.strictObject({
  schemaVersion: z.literal(1), kind: z.literal(RECORD_KIND.failed), accepted: z.literal(false),
  provider: z.literal(PROGRESS_PROVIDER), problemId: problemIdSchema, attemptId: z.uuid(),
  outcome: z.enum(FAILED_VERDICT), sourceHash: sourceHashSchema,
  sourceBytes: z.int().nonnegative(),
  submittedAt: z.iso.datetime(), observedAt: z.iso.datetime(),
  reportHash: sourceHashSchema, reportBytes: z.int().positive().max(MAX_REPORT_BYTES),
  provenance: z.strictObject({
    capture: z.literal(CAPTURE_PROVENANCE), verdict: z.enum(FAILED_VERDICT), origin: z.literal(HDL_ORIGIN),
  }),
  // The record states one outcome, in both places it states it.
}).refine(record => record.outcome === record.provenance.verdict);
export type FailedRecord = z.infer<typeof failedRecordSchema>;
export const reportRecordSchema = z.strictObject({
  schemaVersion: z.literal(1), kind: z.literal(REPORT_KIND), provider: z.literal(PROGRESS_PROVIDER),
  problemId: problemIdSchema, attemptId: z.uuid(), outcome: z.enum(GRADING_VERDICT),
  observedAt: z.iso.datetime(),
  status: reportFieldsSchema.shape.status, messages: reportFieldsSchema.shape.messages,
  // Each published image is named here with its exact bytes, dimensions, and media type, and the diagrams carry
  // the provider attribution and the problem page they were rendered from.
  diagrams: reportFieldsSchema.shape.diagrams, attribution: reportFieldsSchema.shape.attribution,
  coverage: reportFieldsSchema.shape.coverage,
  provenance: z.strictObject({ capture: z.literal(CAPTURE_PROVENANCE), origin: z.literal(HDL_ORIGIN) }),
  // A published report answers to exactly the rules a captured one does, rather than to a looser copy of them:
  // the same self-consistency, the same byte budget, and an artifact phase that actually concluded. A record
  // rewritten as a whole and rehashed still has to satisfy them.
}).refine(record => consistent(record) && record.coverage.artifacts !== ARTIFACT_STATE.pending
  // The attribution is the canonical link for the problem the record itself names, so a report cannot be
  // republished under another problem while pointing at the page it was captured from.
  && describesProblem(record, record.problemId)
  && (record.diagrams ?? []).every((diagram, index) => diagram.name === DIAGRAM_NAME(index + 1)));
export type ReportRecord = z.infer<typeof reportRecordSchema>;
// The exact bytes a report is published as. Capture measures a report against its own size limit with this, so
// what is trimmed locally is decided by the file that will actually be written, not by an estimate of it.
export function reportRecordContent(fields: {
  provider: string; problemId: string; attemptId: string; outcome: string; observedAt: string; capture: string;
  report: Pick<ReportRecord, 'status' | 'messages' | 'diagrams' | 'attribution' | 'coverage'>;
}): string {
  const record = reportRecordSchema.parse({
    schemaVersion: 1, kind: REPORT_KIND, provider: fields.provider, problemId: fields.problemId,
    attemptId: fields.attemptId, outcome: fields.outcome, observedAt: fields.observedAt,
    status: fields.report.status, messages: fields.report.messages,
    ...fields.report.diagrams !== undefined ? { diagrams: fields.report.diagrams } : {},
    ...fields.report.attribution !== undefined ? { attribution: fields.report.attribution } : {},
    coverage: fields.report.coverage,
    provenance: { capture: fields.capture, origin: HDL_ORIGIN },
  });
  return JSON.stringify(record, null, 2) + '\n';
}
export const deliveryReceiptSchema = z.strictObject({
  commitSha: gitShaSchema, treeSha: gitShaSchema, confirmedAt: z.iso.datetime(),
});
export const publicationCandidateSchema = z.strictObject({
  baseCommitSha: gitShaSchema, treeSha: gitShaSchema, commitSha: gitShaSchema,
});
export type PublicationCandidate = z.infer<typeof publicationCandidateSchema>;
export const deliveryRetrySchema = z.strictObject({
  attempts: z.int().nonnegative().max(DELIVERY_RETRY.recordedAttemptLimit),
  nextAttemptAt: z.iso.datetime().nullable(), failure: z.enum(DELIVERY_FAILURE),
  reservedAt: z.iso.datetime().nullish(),
});
export type DeliveryRetry = z.infer<typeof deliveryRetrySchema>;
export const deliveryThrottleSchema = z.record(z.string().min(1).max(256), z.iso.datetime());
export type DeliveryThrottle = z.infer<typeof deliveryThrottleSchema>;
export const scheduleHealthSchema = z.strictObject({
  schemaVersion: z.literal(1), failedAt: z.iso.datetime(), detail: z.string().min(1).max(1024),
});
export type ScheduleHealth = z.infer<typeof scheduleHealthSchema>;
export const deliveryJobSchema = z.strictObject({
  schemaVersion: z.literal(1), id: z.uuid(), snapshot: deliverySnapshotSchema, target: destinationTargetSchema,
  createdAt: z.iso.datetime(), state: z.enum(DELIVERY_STATE), detail: z.string().nullable(),
  // The layout a job was created with fixes its paths. Jobs saved before layouts existed carry none and stay
  // legacy, and a later change to the destination's choice never moves an existing job.
  layout: z.enum(PUBLICATION_LAYOUT).optional(),
  receipt: deliveryReceiptSchema.nullable(),
  candidate: publicationCandidateSchema.nullable().optional(),
  retry: deliveryRetrySchema.nullable().optional(),
}).refine(job => job.id === job.snapshot.id
  && (job.state === DELIVERY_STATE.saved) === (job.receipt !== null)
  && (job.state !== DELIVERY_STATE.saved || !job.retry?.nextAttemptAt)
  && ((job.state === DELIVERY_STATE.blocked || job.state === DELIVERY_STATE.uncertain) === (job.detail !== null)));
export const deliveryJobsSchema = z.array(deliveryJobSchema)
  .refine(jobs => new Set(jobs.map(job => job.id)).size === jobs.length);
export type DeliveryJob = z.infer<typeof deliveryJobSchema>;
export function importedJobSnapshot(job: DeliveryJob): ImportedSnapshot | null {
  return isImportedSnapshot(job.snapshot) ? job.snapshot : null;
}
export function failedJobSnapshot(job: DeliveryJob): FailedSnapshot | null {
  return isFailedSnapshot(job.snapshot) ? job.snapshot : null;
}
export function acceptedJobSnapshot(job: DeliveryJob): AcceptedSnapshot | null {
  return isImportedSnapshot(job.snapshot) || isFailedSnapshot(job.snapshot) ? null : job.snapshot;
}
// Either kind of captured attempt belongs in the attempt history, whatever its outcome.
export function capturedJobSnapshot(job: DeliveryJob): AcceptedSnapshot | FailedSnapshot | null {
  return isImportedSnapshot(job.snapshot) ? null : job.snapshot;
}
export const publishRequestSchema = z.strictObject({
  type: z.literal(DELIVERY_MESSAGE.publish), attemptId: z.uuid(), expectedConnectionId: z.uuid(),
  expectedSelectionId: z.uuid(), publicConfirmed: z.literal(true),
});
export type PublishRequest = z.infer<typeof publishRequestSchema>;
// Publishing a failed attempt is its own explicit request: the accepted confirmation never covers one.
export const publishFailedRequestSchema = z.strictObject({
  type: z.literal(DELIVERY_MESSAGE.publishFailed), attemptId: z.uuid(), expectedConnectionId: z.uuid(),
  expectedSelectionId: z.uuid(), publicConfirmed: z.literal(true), failedConfirmed: z.literal(true),
});
export type PublishFailedRequest = z.infer<typeof publishFailedRequestSchema>;
export const retryRequestSchema = z.strictObject({
  type: z.literal(DELIVERY_MESSAGE.retry), jobId: z.uuid(), expectedConnectionId: z.uuid(), expectedSelectionId: z.uuid(),
});
export type RetryRequest = z.infer<typeof retryRequestSchema>;
export const discardedDeliveryIdsSchema = z.array(z.uuid())
  .refine(ids => new Set(ids).size === ids.length);
export const discardRequestSchema = z.strictObject({
  type: z.literal(DELIVERY_MESSAGE.discard), jobId: z.uuid(), localConfirmed: z.literal(true),
});
export type DiscardRequest = z.infer<typeof discardRequestSchema>;
export const deliveryRequestSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal(DELIVERY_MESSAGE.list) }), publishRequestSchema, publishFailedRequestSchema,
  retryRequestSchema, discardRequestSchema,
]);
export const deliveryReplySchema = z.discriminatedUnion('ok', [
  z.strictObject({
    ok: z.literal(true), jobs: deliveryJobsSchema, selection: destinationTargetSchema.nullable(),
    scheduling: scheduleHealthSchema.nullable(), discarded: discardedDeliveryIdsSchema,
  }),
  z.strictObject({ ok: z.literal(false), error: z.string() }),
]);
export type DeliveryReply = z.infer<typeof deliveryReplySchema>;
export const gitCommitSchema = z.object({
  sha: gitShaSchema, tree: z.object({ sha: gitShaSchema }), parents: z.array(z.object({ sha: gitShaSchema })),
  message: z.string().optional(),
});
export const gitComparisonSchema = z.object({
  status: z.enum(GITHUB_COMPARISON),
  base_commit: gitObjectSchema, merge_base_commit: gitObjectSchema,
});
export const pathCommitsSchema = z.array(gitObjectSchema).max(GITHUB_PAGINATION.pageSize)
  .refine(commits => new Set(commits.map(commit => commit.sha)).size === commits.length);
export const gitTreeSchema = z.object({
  sha: gitShaSchema, truncated: z.literal(false),
  tree: z.array(z.object({
    path: z.string().min(1).max(4096), mode: z.enum(GIT_MODE), type: z.enum(GIT_OBJECT), sha: gitShaSchema,
  })).max(MAX_TREE_ENTRIES).refine(entries => new Set(entries.map(entry => entry.path)).size === entries.length),
});
export const gitRefSchema = z.object({
  ref: z.string(), object: z.object({ type: z.literal(GIT_OBJECT.commit), sha: gitShaSchema }),
});
export class DeliveryFault extends Error {
  constructor(message: string) { super(message); }
}
export class DeliveryBlocked extends DeliveryFault {}
export function parseDelivery<T>(value: unknown, schema: z.ZodType<T>, error: string = DELIVERY_TEXT.invalidResponse): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new DeliveryFault(error);
  return result.data;
}
