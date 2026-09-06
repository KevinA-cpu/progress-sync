import { z } from '../schema';
import {
  MAX_ENCODED_BLOB_CHARACTERS, MAX_REMOTE_PATH_LENGTH, RECOVERY_ENTRY, RECOVERY_ISSUE, RECOVERY_MESSAGE, RECOVERY_STATUS, RECOVERY_TEXT,
} from '../constants/recovery';
import { MAX_TREE_ENTRIES } from '../constants/delivery';
import { GITHUB_CONTENT } from '../constants/github';
import { acceptanceRecordSchema, gitShaSchema, gitTreeSchema } from '../delivery/schemas';
import { destinationTargetSchema } from '../destination/schemas';
import { submittedSourceSchema } from '../progress';

export const remotePathSchema = z.string().min(1).max(MAX_REMOTE_PATH_LENGTH).refine(path =>
  !path.includes('\\') && !path.includes('\0')
  && path.split('/').every(part => part !== '' && part !== '.' && part !== '..'));
export const remoteTreeEntrySchema = gitTreeSchema.shape.tree.element.extend({
  path: remotePathSchema, size: z.int().nonnegative().optional(),
});
export type RemoteTreeEntry = z.infer<typeof remoteTreeEntrySchema>;
export const remoteTreeSchema = gitTreeSchema.extend({
  truncated: z.boolean(),
  tree: z.array(remoteTreeEntrySchema).max(MAX_TREE_ENTRIES)
    .refine(entries => new Set(entries.map(entry => entry.path)).size === entries.length),
});
export const remoteBlobSchema = z.object({
  sha: gitShaSchema, size: z.int().nonnegative(), encoding: z.literal(GITHUB_CONTENT.base64),
  content: z.string().max(MAX_ENCODED_BLOB_CHARACTERS),
});
const recoveryIssueSchema = z.enum(RECOVERY_ISSUE);
export type RecoveryIssue = z.infer<typeof recoveryIssueSchema>;
export const recoveredEntrySchema = z.discriminatedUnion('state', [
  z.strictObject({
    state: z.literal(RECOVERY_ENTRY.recorded), path: remotePathSchema,
    source: submittedSourceSchema, metadata: acceptanceRecordSchema,
  }),
  z.strictObject({
    state: z.literal(RECOVERY_ENTRY.unverified), path: remotePathSchema,
    source: submittedSourceSchema.nullable(), issue: recoveryIssueSchema,
  }),
]);
export type RecoveredEntry = z.infer<typeof recoveredEntrySchema>;
export const recoverySnapshotSchema = z.strictObject({
  commitSha: gitShaSchema, recoveredAt: z.iso.datetime(),
  entries: z.array(recoveredEntrySchema).refine(entries => new Set(entries.map(entry => entry.path)).size === entries.length),
});
const recoveryStateBase = z.strictObject({ schemaVersion: z.literal(1), target: destinationTargetSchema });
export const recoveryStateSchema = z.discriminatedUnion('status', [
  recoveryStateBase.extend({
    status: z.literal(RECOVERY_STATUS.ready), snapshot: recoverySnapshotSchema, error: z.null(),
  }),
  recoveryStateBase.extend({
    status: z.literal(RECOVERY_STATUS.loading), snapshot: recoverySnapshotSchema.nullable(), error: z.null(),
  }),
  recoveryStateBase.extend({
    status: z.literal(RECOVERY_STATUS.failed), snapshot: recoverySnapshotSchema.nullable(), error: z.string().min(1),
  }),
]);
export type RecoveryState = z.infer<typeof recoveryStateSchema>;
export const recoveryRequestSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal(RECOVERY_MESSAGE.list) }),
  z.strictObject({
    type: z.literal(RECOVERY_MESSAGE.refresh), expectedConnectionId: z.uuid(), expectedSelectionId: z.uuid(),
  }),
]);
export const recoveryReplySchema = z.discriminatedUnion('ok', [
  z.strictObject({
    ok: z.literal(true), selection: destinationTargetSchema.nullable(), active: z.boolean(),
  }),
  z.strictObject({ ok: z.literal(false), error: z.string() }),
]);
export const recoveryNotificationSchema = z.strictObject({ type: z.literal(RECOVERY_MESSAGE.changed) });
export type RecoveryReply = z.infer<typeof recoveryReplySchema>;
export class RecoveryFault extends Error {
  constructor(message: string) { super(message); }
}
export function parseRecovery<T>(value: unknown, schema: z.ZodType<T>, message: string = RECOVERY_TEXT.incomplete): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new RecoveryFault(message);
  return parsed.data;
}
