export const RECOVERY_STORAGE_PREFIX = 'recovery-v1:';
export const RECOVERY_DATABASE = 'progress-sync-recovery';
export const RECOVERY_DATABASE_VERSION = 1;
export const RECOVERY_STORE = 'states';
export const RECOVERY_SOURCE_SUFFIX = '.v';
export const RECOVERY_MESSAGE_PREFIX = 'recovery:';
export const RECOVERY_MESSAGE = { list: 'recovery:list', refresh: 'recovery:refresh', changed: 'recovery:changed' } as const;
export const RECOVERY_STATUS = { loading: 'loading', ready: 'ready', failed: 'failed' } as const;
export const RECOVERY_ENTRY = { recorded: 'recorded', unverified: 'unverified' } as const;
export const MAX_REMOTE_PATH_LENGTH = 4096;
export const MAX_METADATA_BYTES = 16 * 1024;
// Allow base64 line wrapping without relaxing the decoded source byte limit.
export const MAX_ENCODED_BLOB_CHARACTERS = 8 * Math.ceil(MAX_SOURCE_BYTES / 3);
export const RECOVERY_ENCODING = 'utf-8';
export const RECOVERY_ISSUE = {
  metadataMissing: 'metadata-missing', metadataInvalid: 'metadata-invalid', sourceMissing: 'source-missing',
  sourceInvalid: 'source-invalid', identityMismatch: 'identity-mismatch', hashMismatch: 'hash-mismatch',
} as const;
export const RECOVERY_MESSAGES = {
  [RECOVERY_ISSUE.metadataMissing]: 'Acceptance metadata is missing or is not in a supported record path.',
  [RECOVERY_ISSUE.metadataInvalid]: 'Acceptance metadata is malformed or unsupported.',
  [RECOVERY_ISSUE.sourceMissing]: 'The acceptance record has no matching source file.',
  [RECOVERY_ISSUE.sourceInvalid]: 'The source or metadata file is oversized, incorrectly encoded, or not a regular file.',
  [RECOVERY_ISSUE.identityMismatch]: 'The record identity or observation timestamps do not match its saved attempt.',
  [RECOVERY_ISSUE.hashMismatch]: 'The saved source hash does not match the acceptance record.',
} satisfies Record<(typeof RECOVERY_ISSUE)[keyof typeof RECOVERY_ISSUE], string>;
export const RECOVERY_TEXT = {
  invalidInput: 'Unsupported recovery operation or sender.',
  noSelection: 'Connect GitHub and explicitly select an existing progress repository to recover saved work.',
  waiting: 'Saved progress has not been recovered for this destination yet.',
  loading: 'Reading saved progress from GitHub...',
  interrupted: 'Recovery was interrupted. Refresh saved progress to try again.',
  incomplete: 'GitHub returned an incomplete or unsupported repository tree. Recovery did not finish.',
  readFailed: 'Saved progress could not be recovered. Check access and connection, then refresh saved progress.',
  storedInvalid: 'Saved recovery data is invalid. It has not been overwritten.',
  sessionChanged: 'The connection or destination changed during recovery. No recovered records were assigned to the new destination.',
  operationFailed: 'Progress Sync: recovery did not complete.',
  notificationFailed: 'Progress Sync: saved-progress change notification was not delivered.',
  interfaceIncomplete: 'Saved-progress interface is incomplete.',
  cached: 'Showing the previously recovered snapshot, not a completed refresh.',
  recorded: 'Recorded acceptance from GitHub',
  sourceLabel: 'Recovered source (read-only)',
  refresh: 'Refresh saved progress',
  unverified: (reason: string) => `Unverified saved file: ${reason}`,
  summary: (recorded: number, unverified: number) => `${recorded} recorded accepted; ${unverified} unverified saved entries.`,
  snapshot: (sha: string) => `Repository snapshot ${sha}`,
  readAt: (timestamp: string) => `Recovered at ${timestamp}`,
} as const;
import { MAX_SOURCE_BYTES } from './progress';
