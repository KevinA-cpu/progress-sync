import { z } from '../schema';
import { githubUserSchema } from '../github/schemas';

export const repositoryNameSchema = z.string().regex(/^[A-Za-z0-9_.-]{1,100}$/)
  .refine(name => name !== '.' && name !== '..');
export const branchNameSchema = z.string().min(1).max(255).refine(branch =>
  !/[\x00-\x20\x7f~^:?*\\[\]]/.test(branch) && !branch.includes('..') && !branch.includes('@{')
  && !branch.startsWith('/') && !branch.endsWith('/') && !branch.endsWith('.')
  && branch !== '@' && branch.split('/').every(part =>
    part !== '' && !part.startsWith('.') && !part.endsWith('.lock')));
export const MARKER_PATH = '.progress-sync.json';
export const markerSchema = z.strictObject({
  kind: z.literal('progress-sync'), schemaVersion: z.literal(1), initializationId: z.uuid(),
});
export const installationSchema = z.object({
  id: z.int().positive(), app_id: z.int().positive(), client_id: z.string().optional(),
  account: z.object({ id: z.int().positive(), login: z.string(), type: z.string() }).nullable(),
  repository_selection: z.enum(['all', 'selected']), suspended_at: z.string().nullable(),
  permissions: z.object({
    contents: z.enum(['read', 'write']).optional(), administration: z.enum(['read', 'write']).optional(),
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
  phase: z.enum(['creating', 'created', 'initializing', 'initialization-rejected', 'ready']),
  initializationAuthorized: z.boolean(),
  branch: branchNameSchema.nullable(), verifiedAt: z.iso.datetime().nullable(),
  connectionId: z.uuid(), commitSha: z.string().nullable(),
});
export type DestinationJournal = z.infer<typeof journalSchema>;
export const destinationIssueSchema = z.enum([
  'not-connected', 'session-changed', 'invalid-input', 'permission-denied', 'installation-required',
  'repository-not-included', 'name-collision', 'creation-uncertain', 'incompatible-repository',
  'initialization-required', 'initialization-uncertain', 'initialization-rejected', 'branch-unavailable', 'repository-changed',
  'invalid-response', 'network-error', 'stored-data-invalid', 'pending-operation',
]);
export type DestinationIssue = z.infer<typeof destinationIssueSchema>;
export const destinationMessages: Record<DestinationIssue, string> = {
  'not-connected': 'Connect GitHub before setting up a repository.',
  'session-changed': 'The GitHub session changed or expired. Reconnect and verify the destination again.',
  'invalid-input': 'Check the repository name, branch, installation, and confirmation.',
  'permission-denied': 'Repository writing or creation permission is missing or denied. Review App and account permissions.',
  'installation-required': 'Install this GitHub App on your personal account, then refresh installations.',
  'repository-not-included': 'The repository is not accessible to the selected App installation. Select it on GitHub, then verify again.',
  'name-collision': 'That repository already exists. Explicitly connect it or choose another name.',
  'creation-uncertain': 'Creation may have completed. Inspect GitHub and explicitly connect the repository; it will not be created again automatically.',
  'incompatible-repository': 'This is not a compatible public Progress Sync repository. No existing files were changed.',
  'initialization-required': 'This repository is empty. Confirm initialization before connecting it.',
  'initialization-uncertain': 'Initialization may have completed. Verify the pending repository before any further writes.',
  'initialization-rejected': 'Initialization was rejected. Fix permissions or branch policy, then verify again.',
  'branch-unavailable': 'The selected branch is unavailable or the repository has not finished initializing. Verify again.',
  'repository-changed': 'The repository identity, owner, or visibility changed. Select the destination explicitly again.',
  'invalid-response': 'GitHub returned an unsupported response. The destination is not verified.',
  'network-error': 'GitHub could not be reached. The destination is not verified; try verification again.',
  'stored-data-invalid': 'Saved destination data is invalid. It has not been overwritten.',
  'pending-operation': 'A repository operation is unresolved. Verify it or explicitly discard its local setup record first.',
};
export class DestinationFault extends Error {
  constructor(readonly issue: DestinationIssue) {
    super(destinationMessages[issue]);
    this.name = 'DestinationFault';
  }
}
export const destinationEnvelopeSchema = z.object({ type: z.string().startsWith('destination:') });
export const destinationRequestSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('destination:load') }),
  z.strictObject({
    type: z.literal('destination:create'), name: repositoryNameSchema,
    installationId: z.int().positive(), publicConfirmed: z.literal(true), expectedConnectionId: z.uuid(),
  }),
  z.strictObject({
    type: z.literal('destination:connect'), name: repositoryNameSchema,
    installationId: z.int().positive(), branch: branchNameSchema.optional(), initialize: z.boolean(),
    expectedConnectionId: z.uuid(),
  }),
  z.strictObject({ type: z.literal('destination:verify'), expectedConnectionId: z.uuid() }),
  z.strictObject({ type: z.literal('destination:discard'), confirmed: z.literal(true), expectedConnectionId: z.uuid() }),
]);
export type DestinationRequest = z.infer<typeof destinationRequestSchema>;
export const destinationViewSchema = z.strictObject({
  user: githubUserSchema,
  connectionId: z.uuid(),
  installations: z.array(z.strictObject({ id: z.int().positive(), appId: z.int().positive(), selection: z.enum(['all', 'selected']) })),
  journal: journalSchema.nullable(),
  verified: z.boolean(),
});
export type DestinationView = z.infer<typeof destinationViewSchema>;
export const destinationReplySchema = z.discriminatedUnion('ok', [
  z.strictObject({ ok: z.literal(true), view: destinationViewSchema }),
  z.strictObject({ ok: z.literal(false), error: destinationIssueSchema }),
]);
export type DestinationReply = z.infer<typeof destinationReplySchema>;
export const httpStatusSchema = z.object({ status: z.number() });
