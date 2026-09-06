import { z } from '../schema';
import {
  DELIVERY_MESSAGE, DELIVERY_STATE, DELIVERY_TEXT, GIT_MODE, GIT_OBJECT, MAX_TREE_ENTRIES,
} from '../constants/delivery';
import { CAPTURE_PROVENANCE, CAPTURE_STATE, GRADING_VERDICT, PROGRESS_PROVIDER } from '../constants/progress';
import { attemptSchema, problemIdSchema, submittedSourceSchema } from '../progress';
import { destinationTargetSchema } from '../destination/schemas';

export const gitShaSchema = z.string().regex(/^[a-f0-9]{40}$/);
export const gitObjectSchema = z.object({ sha: gitShaSchema });
export const sourceHashSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const acceptedSnapshotSchema = attemptSchema.safeExtend({
  state: z.literal(CAPTURE_STATE.accepted), problemId: problemIdSchema, source: submittedSourceSchema,
  sourceHash: sourceHashSchema, observedAt: z.iso.datetime(),
});
export const deliveryTargetSchema = destinationTargetSchema;
export type DeliveryTarget = z.infer<typeof deliveryTargetSchema>;
export const acceptanceRecordSchema = z.strictObject({
  schemaVersion: z.literal(1), provider: z.literal(PROGRESS_PROVIDER), problemId: problemIdSchema,
  attemptId: z.uuid(), sourceHash: sourceHashSchema,
  submittedAt: z.iso.datetime(), observedAt: z.iso.datetime(),
  provenance: z.strictObject({ capture: z.literal(CAPTURE_PROVENANCE), verdict: z.literal(GRADING_VERDICT.success) }),
});
export const deliveryReceiptSchema = z.strictObject({
  commitSha: gitShaSchema, treeSha: gitShaSchema, confirmedAt: z.iso.datetime(),
});
export const deliveryJobSchema = z.strictObject({
  schemaVersion: z.literal(1), id: z.uuid(), snapshot: acceptedSnapshotSchema, target: deliveryTargetSchema,
  createdAt: z.iso.datetime(), state: z.enum(DELIVERY_STATE), detail: z.string().nullable(),
  receipt: deliveryReceiptSchema.nullable(),
}).refine(job => job.id === job.snapshot.id
  && (job.state === DELIVERY_STATE.saved) === (job.receipt !== null)
  && ((job.state === DELIVERY_STATE.blocked || job.state === DELIVERY_STATE.uncertain) === (job.detail !== null)));
export const deliveryJobsSchema = z.array(deliveryJobSchema)
  .refine(jobs => new Set(jobs.map(job => job.id)).size === jobs.length);
export type DeliveryJob = z.infer<typeof deliveryJobSchema>;
export const publishRequestSchema = z.strictObject({
  type: z.literal(DELIVERY_MESSAGE.publish), attemptId: z.uuid(), expectedConnectionId: z.uuid(),
  expectedSelectionId: z.uuid(), publicConfirmed: z.literal(true),
});
export type PublishRequest = z.infer<typeof publishRequestSchema>;
export const deliveryRequestSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal(DELIVERY_MESSAGE.list) }), publishRequestSchema,
]);
export const deliveryReplySchema = z.discriminatedUnion('ok', [
  z.strictObject({ ok: z.literal(true), jobs: deliveryJobsSchema, selection: deliveryTargetSchema.nullable() }),
  z.strictObject({ ok: z.literal(false), error: z.string() }),
]);
export type DeliveryReply = z.infer<typeof deliveryReplySchema>;
export const gitCommitSchema = z.object({
  sha: gitShaSchema, tree: z.object({ sha: gitShaSchema }), parents: z.array(z.object({ sha: gitShaSchema })),
});
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
export function parseDelivery<T>(value: unknown, schema: z.ZodType<T>, error: string = DELIVERY_TEXT.invalidResponse): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new DeliveryFault(error);
  return result.data;
}
