import { GITHUB_ORIGIN } from './github';

export const DELIVERY_KEY = 'delivery-jobs-v1';
export const DELIVERY_MESSAGE_PREFIX = 'delivery:';
export const DELIVERY_MESSAGE = { list: 'delivery:list', publish: 'delivery:publish' } as const;
export const DELIVERY_STATE = {
  pending: 'pending', publishing: 'publishing', blocked: 'blocked', uncertain: 'uncertain', saved: 'saved',
} as const;
export const GIT_OBJECT = { blob: 'blob', tree: 'tree', commit: 'commit' } as const;
export const GIT_MODE = {
  file: '100644', executable: '100755', tree: '040000', symlink: '120000', submodule: '160000',
} as const;
export const GIT_BLOB_HASH_ALGORITHM = 'SHA-1';
export const GIT_RECURSIVE = '1';
export const MAX_TREE_ENTRIES = 100_000;
export const DELIVERY_TEXT = {
  awaiting: 'Accepted - awaiting GitHub delivery',
  saved: 'Saved to GitHub',
  invalidInput: 'Unsupported delivery operation or sender.',
  invalidData: 'Saved delivery data is invalid. It has not been overwritten.',
  invalidAttempt: 'Only a complete, validated accepted snapshot can be published.',
  noDestination: 'Select and verify a public progress repository before publishing this attempt.',
  sessionChanged: 'The account or selected destination changed. This job has not been redirected.',
  invalidResponse: 'GitHub returned an unsupported publication response.',
  existingPath: 'An attempt path already exists on GitHub. Complete-record reconciliation is required; nothing was overwritten.',
  headChanged: 'The branch changed during publication. No remote work was overwritten.',
  rejected: 'GitHub rejected publication. Check repository permissions, rate limits, branch rules, or concurrent branch changes. The accepted attempt is retained.',
  requestFailed: 'GitHub could not complete publication checks. Review access, rate limits, and service availability.',
  networkError: 'GitHub could not be reached. The accepted attempt is retained.',
  uncertain: 'Publication outcome is uncertain. Inspect GitHub; this job will not be retried automatically.',
  interrupted: 'Publication was interrupted. Its outcome is uncertain; no automatic retry was made.',
  operationFailed: 'Progress Sync: delivery operation did not complete.',
  intakeFailed: 'Accepted locally - delivery assignment blocked. No upload was started. Refresh the connection and destination, then explicitly select this attempt again.',
  blocked: (detail: string) => `Delivery blocked: ${detail}`,
  target: (owner: string, name: string, branch: string) => `Destination: ${owner}/${name} @ ${branch}`,
  select: (owner: string, name: string, branch: string) =>
    `Publish accepted attempt to ${owner}/${name} @ ${branch} (public)`,
  commit: (sha: string) => `Commit ${sha}`,
  commitMessage: (provider: string, problem: string, attemptId: string) =>
    `Record accepted ${provider}:${problem} attempt ${attemptId}`,
} as const;
export const DELIVERY_PATH = { root: 'progress', source: 'solution.v', metadata: 'acceptance.json' } as const;
export const deliveryRoot = (provider: string, problem: string, attemptId: string) =>
  `${DELIVERY_PATH.root}/${provider}/${problem}/${attemptId}`;
export const deliveryPaths = (root: string) => ({
  source: `${root}/${DELIVERY_PATH.source}`, metadata: `${root}/${DELIVERY_PATH.metadata}`,
});
export const deliveryRef = (branch: string) => `heads/${branch}`;
export const deliveryCommitUrl = (owner: string, name: string, sha: string) =>
  `${GITHUB_ORIGIN}/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/commit/${sha}`;
