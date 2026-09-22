import { GITHUB_ORIGIN } from './github';
import { REPORT_FILE } from './report';

export const DELIVERY_KEY = 'delivery-jobs-v1';
export const DISCARDED_DELIVERY_KEY = 'discarded-deliveries-v1';
export const DELIVERY_RETRY_ALARM = 'delivery-retry-v1';
export const DELIVERY_THROTTLE_KEY = 'delivery-throttle-v1';
export const DELIVERY_SCHEDULE_KEY = 'delivery-schedule-v1';
export const DELIVERY_MESSAGE_PREFIX = 'delivery:';
export const DELIVERY_MESSAGE = {
  list: 'delivery:list', publish: 'delivery:publish', publishFailed: 'delivery:publish-failed',
  retry: 'delivery:retry', discard: 'delivery:discard',
} as const;
export const DELIVERY_STATE = {
  pending: 'pending', publishing: 'publishing', reconciling: 'reconciling', blocked: 'blocked', uncertain: 'uncertain', saved: 'saved',
} as const;
export const DELIVERY_FAILURE = {
  transient: 'transient', rateLimited: 'rate-limited', unsupportedDelay: 'unsupported-delay',
  authorization: 'authorization', permanent: 'permanent',
} as const;
export const DELIVERY_RETRY = {
  maxAttempts: 5,
  initialDelayMs: 60_000,
  factor: 4,
  maxDelayMs: 2 * 60 * 60 * 1000,
  recordedAttemptLimit: 1_000,
} as const;
export const GIT_OBJECT = { blob: 'blob', tree: 'tree', commit: 'commit' } as const;
export const GIT_MODE = {
  file: '100644', executable: '100755', tree: '040000', symlink: '120000', submodule: '160000',
} as const;
export const GIT_BLOB_HASH_ALGORITHM = 'SHA-1';
export const GIT_RECURSIVE = '1';
export const MAX_TREE_ENTRIES = 100_000;
export const MAX_METADATA_BYTES = 16 * 1024;
export const MAX_PUBLICATION_REBASES = 2;
export const DELIVERY_TEXT = {
  awaiting: 'Accepted - awaiting GitHub delivery',
  saved: 'Saved to GitHub',
  awaitingFailed: 'Failed attempt - awaiting GitHub delivery',
  savedFailed: 'Failed attempt saved to GitHub',
  retry: 'Check GitHub and retry delivery',
  reconciling: 'Checking the complete publication on GitHub...',
  reconciliationFailed: 'Publication outcome is uncertain. GitHub inspection failed or was interrupted. The job is retained; retry the check when access is restored.',
  receiptUnavailable: 'The original complete publication could not be confirmed. The job is retained; no files were overwritten.',
  legacyUncertain: 'Remote history does not establish a safe retry for this older job. Its result remains unresolved; no files were overwritten.',
  invalidInput: 'Unsupported delivery operation or sender.',
  invalidData: 'Saved delivery data is invalid. It has not been overwritten.',
  invalidAttempt: 'Only a complete, validated accepted snapshot can be published.',
  diagramsUnavailable: 'The timing diagram images this report names are no longer stored in this browser profile. Nothing was sent; the attempt and its report are retained.',
  diagramsInvalid: 'The stored timing diagram images do not match the report that names them. Nothing was sent; no files were overwritten.',
  pendingReport: 'This attempt is still being observed. Its report is not final, so nothing was sent.',
  invalidFailedAttempt: 'Only a complete, validated failed snapshot with its submission report can be published.',
  failedNotEnabled: 'Automatic publication of failed attempts is off for this destination. Publish this attempt explicitly, or turn the setting on for attempts from now on.',
  discarded: 'This local attempt was discarded and cannot be delivered again.',
  discardActive: 'Delivery is still active. Wait for it to settle, or disconnect GitHub before discarding local work. Already-issued requests may complete.',
  discardSaved: 'Only pending or unresolved local delivery work can be discarded here.',
  noDestination: 'Select and verify a public progress repository before publishing this attempt.',
  sessionChanged: 'The account or selected destination changed. This job has not been redirected.',
  providerMismatch: 'This repository uses the problem-first layout for a different provider. Nothing was sent; choose a destination for this provider instead.',
  invalidResponse: 'GitHub returned an unsupported publication response.',
  existingPath: 'An attempt path already exists on GitHub but its source or metadata is incomplete or inconsistent. No files were overwritten.',
  headChanged: 'The branch changed during publication. No remote work was overwritten.',
  conflictLimit: 'The branch kept advancing. The attempt is retained; check GitHub and retry after other writers finish. No remote work was overwritten.',
  historyChanged: 'The branch history was replaced or the attempt was removed remotely. Review GitHub before retrying; no files were recreated or overwritten.',
  rejected: 'GitHub rejected publication. Check repository permissions, rate limits, branch rules, or concurrent branch changes. The accepted attempt is retained.',
  requestFailed: 'GitHub could not complete publication checks. Review access, rate limits, and service availability.',
  networkError: 'GitHub could not be reached. The accepted attempt is retained.',
  uncertain: 'Publication outcome is uncertain. Inspect GitHub; the complete remote record is proven before any further write.',
  interrupted: 'Publication was interrupted. Its outcome is uncertain; GitHub is rechecked before any further write.',
  operationFailed: 'Progress Sync: delivery operation did not complete.',
  scheduleFailed: 'Progress Sync: automatic delivery scheduling did not complete.',
  retryScheduled: (attempt: number, total: number, at: string) =>
    `Queued for automatic delivery: attempt ${attempt} of ${total} no earlier than ${at}. No action is needed while it is queued.`,
  retryThrottled: (attempt: number, total: number, at: string) =>
    `GitHub asked this client to wait. Automatic attempt ${attempt} of ${total} no earlier than ${at}.`,
  retryExhausted: 'Automatic delivery attempts are exhausted. The accepted attempt and its job are retained; check GitHub and retry when you are ready.',
  retryUnscheduled: (attempt: number, total: number, at: string) =>
    `Attempt ${attempt} of ${total} is due no earlier than ${at}, but no automatic wakeup could be registered. Check GitHub and retry delivery yourself.`,
  cooldown: (at: string) =>
    `GitHub asked this client to wait until ${at} before sending again. This attempt was not sent; the accepted attempt is retained.`,
  unsupportedDelay: (at: string) =>
    `GitHub asked this client to wait until ${at}, which is longer than automatic delivery supports. Nothing was sent and no attempt was scheduled; check GitHub and retry after that time.`,
  unreadableDelay: 'GitHub asked this client to wait but did not state a usable time. Nothing was sent and no attempt was scheduled; check GitHub and retry later.',
  scheduleUnavailable: 'Automatic delivery could not be scheduled in this browser. Queued jobs are retained with their deadlines, but they may not resume on their own until scheduling recovers; check GitHub and retry delivery when you need the work saved.',
  outcomeUnrecorded: 'The result of a delivery attempt, including the wait GitHub asked for, could not be saved in this browser. Nothing further is sent to that destination while this browser is running; the accepted attempt is retained. Check GitHub before retrying.',
  durability: 'Undelivered work is stored only in this browser profile. Clearing extension storage, removing the extension, or losing this device loses attempts that were never saved to GitHub.',
  intakeFailed: 'Accepted locally - delivery assignment blocked. No upload was started. Refresh the connection and destination, then explicitly select this attempt again.',
  blocked: (detail: string) => `Delivery blocked: ${detail}`,
  target: (owner: string, name: string, branch: string) => `Destination: ${owner}/${name} @ ${branch}`,
  select: (owner: string, name: string, branch: string) =>
    `Publish accepted attempt to ${owner}/${name} @ ${branch} (public)`,
  selectFailed: (owner: string, name: string, branch: string) =>
    `Publish failed attempt and its report to ${owner}/${name} @ ${branch} (public)`,
  failedConfirmation: (problem: string, outcome: string) =>
    `Publish this failed ${problem} attempt (${outcome}) and its submission report to your public repository?`,
  commit: (sha: string) => `Commit ${sha}`,
  commitMessage: (provider: string, problem: string, attemptId: string) =>
    `Record accepted ${provider}:${problem} attempt ${attemptId}`,
  failedCommitMessage: (provider: string, problem: string, attemptId: string, outcome: string) =>
    `Record failed ${provider}:${problem} attempt ${attemptId} (${outcome})`,
} as const;
export const DELIVERY_PATH = { root: 'progress', source: 'solution.v', metadata: 'acceptance.json' } as const;
// A failed attempt keeps its own folder prefix and its own metadata file name, so no reader and no schema can
// mistake it for an accepted record.
export const FAILED_PATH = { prefix: 'failed-', metadata: 'attempt.json' } as const;
// Where a destination puts new records. Legacy keeps the provider-first roots every existing repository already
// uses; problem-first is opted into per destination and dedicates that repository to one provider.
export const PUBLICATION_LAYOUT = { legacy: 'legacy', problemFirst: 'problem-first' } as const;
export const RECORD_KIND = { passed: 'passed', failed: 'failed', imported: 'imported' } as const;
// The identity is the full attempt or record id, so two records of the same kind can never share a folder.
export const problemRecordRoot = (problem: string, kind: string, identity: string) =>
  `${problem}/${kind}-${identity}`;
export const deliveryRoot = (provider: string, problem: string, attemptId: string) =>
  `${DELIVERY_PATH.root}/${provider}/${problem}/${attemptId}`;
export const failedRoot = (provider: string, problem: string, attemptId: string) =>
  `${DELIVERY_PATH.root}/${provider}/${problem}/${FAILED_PATH.prefix}${attemptId}`;
export const deliveryPaths = (root: string) => ({
  source: `${root}/${DELIVERY_PATH.source}`, metadata: `${root}/${DELIVERY_PATH.metadata}`,
});
export const failedPaths = (root: string) => ({
  source: `${root}/${DELIVERY_PATH.source}`, metadata: `${root}/${FAILED_PATH.metadata}`,
  report: `${root}/${REPORT_FILE}`,
});
// Diagram images live beside the report that names them, in the same per-attempt folder and the same commit.
export const diagramPath = (root: string, name: string) => `${root}/${name}`;
export const deliveryRef = (branch: string) => `heads/${branch}`;
export const deliveryCommitUrl = (owner: string, name: string, sha: string) =>
  `${GITHUB_ORIGIN}/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/commit/${sha}`;
