import {
  DESTINATION_FAULT_NAME, DESTINATION_ISSUE, DESTINATION_MESSAGE, DESTINATION_MESSAGES,
  DESTINATION_MESSAGE_PREFIX, DESTINATION_PHASE, MARKER_KIND,
} from '../constants/destination';
import { GITHUB_PERMISSION, REPOSITORY_SELECTION } from '../constants/github';
import { PUBLICATION_LAYOUT } from '../constants/delivery';
import { PROGRESS_PROVIDER } from '../constants/progress';
import { z } from '../schema';
import { clientIdSchema, githubUserSchema } from '../github/schemas';

export const repositoryNameSchema = z.string().regex(/^[A-Za-z0-9_.-]{1,100}$/)
  .refine(name => name !== '.' && name !== '..');
export const branchNameSchema = z.string().min(1).max(255).refine(branch =>
  !/[\x00-\x20\x7f~^:?*\\[\]]/.test(branch) && !branch.includes('..') && !branch.includes('@{')
  && !branch.startsWith('/') && !branch.endsWith('/') && !branch.endsWith('.')
  && branch !== '@' && branch.split('/').every(part =>
    part !== '' && !part.startsWith('.') && !part.endsWith('.lock')));
export const layoutProviderSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/);
export const markerSchema = z.strictObject({
  kind: z.literal(MARKER_KIND), schemaVersion: z.literal(1), initializationId: z.uuid(),
});
export const installationSchema = z.object({
  id: z.int().positive(), app_id: z.int().positive(), client_id: z.string().optional(),
  account: z.object({ id: z.int().positive(), login: z.string(), type: z.string() }).nullable(),
  repository_selection: z.enum(REPOSITORY_SELECTION), suspended_at: z.string().nullable(),
  permissions: z.object({
    contents: z.enum(GITHUB_PERMISSION).optional(), administration: z.enum(GITHUB_PERMISSION).optional(),
  }),
});
export type Installation = z.infer<typeof installationSchema>;
export const repositorySchema = z.object({
  id: z.int().positive(), name: repositoryNameSchema,
  owner: z.object({ id: z.int().positive(), login: z.string(), type: z.string() }),
  private: z.boolean(), archived: z.boolean(), disabled: z.boolean(),
  default_branch: branchNameSchema,
  permissions: z.object({ push: z.boolean(), admin: z.boolean().optional() }),
});
export type Repository = z.infer<typeof repositorySchema>;
export const branchSchema = z.object({
  name: branchNameSchema, commit: z.object({ sha: z.string().regex(/^[a-f0-9]{40,64}$/) }),
  protected: z.boolean(),
});
export const journalSchema = z.strictObject({
  schemaVersion: z.literal(1), operationId: z.uuid(), userId: z.int().positive(),
  owner: z.string(), name: repositoryNameSchema, clientId: z.string(),
  installationId: z.int().positive(), appId: z.int().positive(),
  repositoryId: z.int().positive().nullable(),
  phase: z.enum(DESTINATION_PHASE),
  initializationAuthorized: z.boolean(),
  branch: branchNameSchema.nullable(), verifiedAt: z.iso.datetime().nullable(),
  selectedAt: z.iso.datetime().optional(),
  accessPaused: z.boolean().optional(),
  // Absent in every destination saved before layouts were selectable, and read as the legacy layout.
  // The scope names the provider the problem-first choice was made for; another provider is refused, not renamed.
  layout: z.enum(PUBLICATION_LAYOUT).optional(),
  layoutProvider: layoutProviderSchema.optional(),
  layoutChosenAt: z.iso.datetime().optional(),
  // Absent in every destination saved before failed attempts could be published, and read as off. The
  // timestamp bounds the setting to attempts captured after it: enabling never reaches back over local history.
  publishFailed: z.boolean().optional(),
  publishFailedSince: z.iso.datetime().optional(),
  connectionId: z.uuid(), commitSha: z.string().nullable(),
});
export type DestinationJournal = z.infer<typeof journalSchema>;
export const destinationTargetSchema = journalSchema.pick({
  operationId: true, userId: true, owner: true, name: true, clientId: true, installationId: true,
  appId: true, repositoryId: true, branch: true, connectionId: true,
}).extend({
  owner: githubUserSchema.shape.login, clientId: clientIdSchema,
  repositoryId: z.int().positive(), branch: branchNameSchema, selectedAt: z.iso.datetime(),
});
export type DestinationTarget = z.infer<typeof destinationTargetSchema>;
export function sameDestination(left: DestinationTarget, right: DestinationTarget): boolean {
  return left.userId === right.userId && left.clientId === right.clientId
    && left.installationId === right.installationId && left.appId === right.appId
    && left.repositoryId === right.repositoryId && left.branch === right.branch
    && left.owner.toLowerCase() === right.owner.toLowerCase() && left.name.toLowerCase() === right.name.toLowerCase();
}
export const destinationIssueSchema = z.enum(DESTINATION_ISSUE);
export type DestinationIssue = z.infer<typeof destinationIssueSchema>;
export const destinationMessages = DESTINATION_MESSAGES;
export class DestinationFault extends Error {
  constructor(readonly issue: DestinationIssue) {
    super(destinationMessages[issue]);
    this.name = DESTINATION_FAULT_NAME;
  }
}
export const destinationEnvelopeSchema = z.object({ type: z.string().startsWith(DESTINATION_MESSAGE_PREFIX) });
export const destinationRequestSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal(DESTINATION_MESSAGE.load) }),
  z.strictObject({
    type: z.literal(DESTINATION_MESSAGE.create), name: repositoryNameSchema,
    installationId: z.int().positive(), publicConfirmed: z.literal(true), expectedConnectionId: z.uuid(),
  }),
  z.strictObject({
    type: z.literal(DESTINATION_MESSAGE.connect), name: repositoryNameSchema,
    installationId: z.int().positive(), branch: branchNameSchema.optional(), initialize: z.boolean(),
    expectedConnectionId: z.uuid(),
  }),
  z.strictObject({
    type: z.literal(DESTINATION_MESSAGE.layout), layout: z.enum(PUBLICATION_LAYOUT),
    provider: z.literal(PROGRESS_PROVIDER), layoutConfirmed: z.literal(true), expectedConnectionId: z.uuid(),
  }),
  z.strictObject({
    type: z.literal(DESTINATION_MESSAGE.failed), publishFailed: z.boolean(),
    publicConfirmed: z.boolean(), failedConfirmed: z.literal(true), expectedConnectionId: z.uuid(),
  }),
  z.strictObject({ type: z.literal(DESTINATION_MESSAGE.verify), expectedConnectionId: z.uuid() }),
  z.strictObject({ type: z.literal(DESTINATION_MESSAGE.discard), confirmed: z.literal(true), expectedConnectionId: z.uuid() }),
]);
export type DestinationRequest = z.infer<typeof destinationRequestSchema>;
export const destinationViewSchema = z.strictObject({
  user: githubUserSchema,
  connectionId: z.uuid(),
  installations: z.array(z.strictObject({ id: z.int().positive(), appId: z.int().positive(), selection: z.enum(REPOSITORY_SELECTION) })),
  journal: journalSchema.nullable(),
  verified: z.boolean(),
});
export type DestinationView = z.infer<typeof destinationViewSchema>;
export const destinationReplySchema = z.discriminatedUnion('ok', [
  z.strictObject({ ok: z.literal(true), view: destinationViewSchema }),
  z.strictObject({ ok: z.literal(false), error: destinationIssueSchema }),
]);
export type DestinationReply = z.infer<typeof destinationReplySchema>;
