import { z } from '../schema';
import {
  IMPORT_CLAIM, IMPORT_FAILURE, IMPORT_LIMIT, IMPORT_MESSAGE, IMPORT_PROVENANCE, IMPORT_SNAPSHOT_KIND,
  IMPORT_SOURCE, IMPORT_STATUS, IMPORT_STOP, IMPORT_TEXT,
} from '../constants/import';
import { HDL_ORIGIN, PROGRESS_PROVIDER, SOURCE_HASH_ALGORITHM } from '../constants/progress';
import { problemIdSchema, sourceByteLength, sourceHashSchema, submittedSourceSchema } from '../progress';
import type { DestinationTarget } from '../destination/schemas';

export const importSubmissionIdSchema = z.string().regex(/^[0-9]{1,20}$/);
export const importLabelSchema = z.string().min(1).max(IMPORT_LIMIT.labelCharacters);
// The site may add fields; only status is always present. A failed load carries an error string and no data.
export const providerLoadSchema = z.object({ status: z.int(), data: z.unknown() });

// Byte count is part of the record's identity, so it is checked against the source itself, not just its shape.
const consistentBytes = (candidate: { source: string; sourceBytes: number }) =>
  candidate.sourceBytes === sourceByteLength(candidate.source);
const importCandidateShape = z.strictObject({
  schemaVersion: z.literal(1),
  recordId: z.uuid(),
  provider: z.literal(PROGRESS_PROVIDER),
  problemId: problemIdSchema,
  submissionId: importSubmissionIdSchema,
  claim: z.literal(IMPORT_CLAIM),
  verified: z.literal(false),
  providerLabel: importLabelSchema,
  providerStatus: z.int(),
  source: submittedSourceSchema,
  sourceHash: sourceHashSchema,
  sourceBytes: z.int().positive().max(IMPORT_LIMIT.sourceBytes),
  discoveredAt: z.iso.datetime(),
});
export const importCandidateSchema = importCandidateShape.refine(consistentBytes);
export type ImportCandidate = z.infer<typeof importCandidateSchema>;
export const importedSnapshotSchema = importCandidateShape.safeExtend({
  kind: z.literal(IMPORT_SNAPSHOT_KIND), id: z.uuid(),
}).refine(consistentBytes);
export type ImportedSnapshot = z.infer<typeof importedSnapshotSchema>;

// The published record states an import claim and never an acceptance verdict.
export const importRecordSchema = z.strictObject({
  schemaVersion: z.literal(1),
  kind: z.literal(IMPORT_SNAPSHOT_KIND),
  provider: z.literal(PROGRESS_PROVIDER),
  problemId: problemIdSchema,
  submissionId: importSubmissionIdSchema,
  recordId: z.uuid(),
  importId: z.uuid(),
  claim: z.literal(IMPORT_CLAIM),
  verified: z.literal(false),
  sourceHash: sourceHashSchema,
  sourceBytes: z.int().positive().max(IMPORT_LIMIT.sourceBytes),
  providerLabel: importLabelSchema,
  providerStatus: z.int(),
  discoveredAt: z.iso.datetime(),
  provenance: z.strictObject({
    capture: z.literal(IMPORT_PROVENANCE), origin: z.literal(HDL_ORIGIN),
  }),
});
export type ImportRecord = z.infer<typeof importRecordSchema>;

export const importFailureSchema = z.strictObject({
  problemId: problemIdSchema, reason: z.enum(IMPORT_FAILURE),
});
export const importInventorySchema = z.int().nonnegative().max(IMPORT_LIMIT.inventory);
export const importSourceSchema = z.enum(IMPORT_SOURCE);
export type ImportSource = z.infer<typeof importSourceSchema>;
export const importDiscoverySchema = z.strictObject({
  schemaVersion: z.literal(1),
  status: z.enum(IMPORT_STATUS),
  origin: z.literal(HDL_ORIGIN),
  startedAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  // A pass reads a bounded window of the solved problems the page lists; the rest stay reachable from offset.
  offset: importInventorySchema,
  inventory: importInventorySchema,
  // Which list the offset counts against. Absent in state saved before the statistics page could be read.
  source: importSourceSchema.nullish(),
  scanned: z.int().nonnegative().max(IMPORT_LIMIT.problems),
  total: z.int().nonnegative().max(IMPORT_LIMIT.problems),
  stopped: z.enum(IMPORT_STOP).nullable(),
  candidates: z.array(importCandidateSchema).max(IMPORT_LIMIT.problems)
    .refine(items => new Set(items.map(item => item.recordId)).size === items.length),
  // Every skipped problem in the enumerated inventory stays listed; continuation passes never drop earlier ones.
  failures: z.array(importFailureSchema).max(IMPORT_LIMIT.inventory)
    .refine(items => new Set(items.map(item => item.problemId)).size === items.length),
  error: z.string().min(1).nullable(),
}).refine(state => (state.status === IMPORT_STATUS.failed) === (state.error !== null));
export type ImportDiscovery = z.infer<typeof importDiscoverySchema>;

export const importPublishRequestSchema = z.strictObject({
  type: z.literal(IMPORT_MESSAGE.publish), recordId: z.uuid(), expectedSourceHash: sourceHashSchema,
  expectedConnectionId: z.uuid(), expectedSelectionId: z.uuid(), publicConfirmed: z.literal(true),
});
export type ImportPublishRequest = z.infer<typeof importPublishRequestSchema>;
export const importRequestSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal(IMPORT_MESSAGE.list) }),
  z.strictObject({ type: z.literal(IMPORT_MESSAGE.discover) }),
  z.strictObject({ type: z.literal(IMPORT_MESSAGE.cancel) }),
  importPublishRequestSchema,
]);
export const importReplySchema = z.discriminatedUnion('ok', [
  z.strictObject({ ok: z.literal(true), state: importDiscoverySchema.nullable() }),
  z.strictObject({ ok: z.literal(false), error: z.string() }),
]);
export type ImportReply = z.infer<typeof importReplySchema>;

export const importReadySchema = z.strictObject({ type: z.literal(IMPORT_MESSAGE.ready) });
export const importReadyReplySchema = z.object({ ok: z.boolean() });
export const importDocumentIdSchema = z.string().min(1).max(128);
// A scan is bound to one document, not just a tab, so a navigated or replaced page cannot continue it.
export const importPagesSchema = z.array(z.strictObject({
  tabId: z.int(), documentId: importDocumentIdSchema,
})).max(IMPORT_LIMIT.tabs).refine(pages => new Set(pages.map(page => page.documentId)).size === pages.length);
export type ImportPage = z.infer<typeof importPagesSchema>[number];
export const importScanRequestSchema = z.strictObject({
  type: z.literal(IMPORT_MESSAGE.scan), sessionId: z.uuid(),
  offset: importInventorySchema, limit: z.int().positive().max(IMPORT_LIMIT.problems),
  // A continuation names the list its offset was counted against; a new pass leaves the choice open.
  source: importSourceSchema.nullable(),
});
export type ImportScanRequest = z.infer<typeof importScanRequestSchema>;
export const importStopRequestSchema = z.strictObject({
  type: z.literal(IMPORT_MESSAGE.stop), sessionId: z.uuid(),
});
export const importScanReplySchema = z.discriminatedUnion('ok', [
  z.strictObject({
    ok: z.literal(true), scanned: z.int().nonnegative().max(IMPORT_LIMIT.problems),
    inventory: importInventorySchema, stopped: z.boolean(), source: importSourceSchema,
  }),
  z.strictObject({ ok: z.literal(false), error: z.string() }),
]);
export const importProgressSchema = z.strictObject({
  type: z.literal(IMPORT_MESSAGE.progress),
  sessionId: z.uuid(),
  problemId: problemIdSchema,
  inventory: z.int().positive().max(IMPORT_LIMIT.inventory),
  source: importSourceSchema,
  total: z.int().positive().max(IMPORT_LIMIT.problems),
  scanned: z.int().positive().max(IMPORT_LIMIT.problems),
  result: z.discriminatedUnion('found', [
    z.strictObject({
      found: z.literal(true), submissionId: importSubmissionIdSchema, providerLabel: importLabelSchema,
      providerStatus: z.int(), source: submittedSourceSchema,
    }),
    z.strictObject({ found: z.literal(false), reason: z.enum(IMPORT_FAILURE) }),
  ]),
});
export type ImportProgress = z.infer<typeof importProgressSchema>;
export const importProgressReplySchema = z.strictObject({ ok: z.boolean(), proceed: z.boolean() });

export class ImportFault extends Error {
  constructor(message: string) { super(message); }
}
export function parseImport<T>(value: unknown, schema: z.ZodType<T>, error: string = IMPORT_TEXT.invalidData): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new ImportFault(error);
  return parsed.data;
}

// Deterministic identity keeps a repeated import of the same bytes from becoming a second record.
async function derivedUuid(parts: readonly string[]): Promise<string> {
  const digest = await crypto.subtle.digest(SOURCE_HASH_ALGORITHM, new TextEncoder().encode(parts.join('\0')));
  const hex = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
  const variant = ((parseInt(hex.slice(16, 17), 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
export function importRecordId(
  identity: { provider: string; problemId: string; submissionId: string; sourceHash: string },
): Promise<string> {
  return derivedUuid([
    IMPORT_SNAPSHOT_KIND, identity.provider, identity.problemId, identity.submissionId, identity.sourceHash,
  ]);
}
export function importJobId(recordId: string, target: DestinationTarget): Promise<string> {
  return derivedUuid([
    IMPORT_SNAPSHOT_KIND, recordId, target.clientId, String(target.userId), String(target.repositoryId), target.branch,
  ]);
}
