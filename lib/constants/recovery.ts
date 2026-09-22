import { MAX_SOURCE_BYTES } from './progress';
import { githubBase64CharacterLimit } from './github';

export const RECOVERY_STORAGE_PREFIX = 'recovery-v1:';
export const RECOVERY_DATABASE = 'progress-sync-recovery';
export const RECOVERY_DATABASE_VERSION = 1;
export const RECOVERY_STORE = 'states';
export const RECOVERY_SOURCE_SUFFIX = '.v';
export const RECOVERY_MESSAGE_PREFIX = 'recovery:';
export const RECOVERY_MESSAGE = {
  list: 'recovery:list', refresh: 'recovery:refresh', changed: 'recovery:changed', image: 'recovery:image',
} as const;
export const RECOVERY_STATUS = { loading: 'loading', ready: 'ready', failed: 'failed' } as const;
export const RECOVERY_ENTRY = {
  recorded: 'recorded', failed: 'failed', imported: 'imported', unverified: 'unverified',
} as const;
export const MAX_REMOTE_PATH_LENGTH = 4096;
export const MAX_ENCODED_BLOB_CHARACTERS = githubBase64CharacterLimit(MAX_SOURCE_BYTES);
export const RECOVERY_ISSUE = {
  metadataMissing: 'metadata-missing', metadataInvalid: 'metadata-invalid', sourceMissing: 'source-missing',
  sourceInvalid: 'source-invalid', identityMismatch: 'identity-mismatch', hashMismatch: 'hash-mismatch',
  recordMismatch: 'record-mismatch', reportMissing: 'report-missing', reportInvalid: 'report-invalid',
  diagramMissing: 'diagram-missing', diagramInvalid: 'diagram-invalid',
} as const;
export const RECOVERY_MESSAGES = {
  [RECOVERY_ISSUE.metadataMissing]: 'Acceptance metadata is missing or is not in a supported record path.',
  [RECOVERY_ISSUE.metadataInvalid]: 'Acceptance metadata is malformed or unsupported.',
  [RECOVERY_ISSUE.sourceMissing]: 'The acceptance record has no matching source file.',
  [RECOVERY_ISSUE.sourceInvalid]: 'The source or metadata file is oversized, incorrectly encoded, or not a regular file.',
  [RECOVERY_ISSUE.identityMismatch]: 'The record identity or observation timestamps do not match its saved attempt.',
  [RECOVERY_ISSUE.hashMismatch]: 'The saved source hash does not match the acceptance record.',
  [RECOVERY_ISSUE.recordMismatch]: 'The record identity derived from the saved source does not match the stored metadata.',
  [RECOVERY_ISSUE.reportMissing]: 'The failed record has no matching submission report file.',
  [RECOVERY_ISSUE.reportInvalid]: 'The submission report is malformed, oversized, or does not match the record that names it.',
  [RECOVERY_ISSUE.diagramMissing]: 'The submission report names a timing diagram image that is not stored with it.',
  [RECOVERY_ISSUE.diagramInvalid]: 'A stored timing diagram image does not match the byte count, path, or file type the report states.',
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
  failed: 'Recorded failed attempt from GitHub - not accepted',
  imported: 'Imported from HDLBits - unverified, no acceptance was observed',
  sourceLabel: 'Recovered source (read-only)',
  // Images are read from GitHub only when asked for, and only after their published bytes match the report.
  imageUnavailable: 'The published image could not be read, or its bytes do not match the report that names it. Nothing was rendered.',
  imageEntryUnknown: 'This record is not in the current saved-progress snapshot. Refresh saved progress and try again.',
  refresh: 'Refresh saved progress',
  unverified: (reason: string) => `Unverified saved file: ${reason}`,
  summary: (recorded: number, failed: number, imported: number, unverified: number) =>
    `${recorded} recorded accepted; ${failed} recorded failed; ${imported} imported unverified; `
    + `${unverified} unverified saved entries.`,
  snapshot: (sha: string) => `Repository snapshot ${sha}`,
  readAt: (timestamp: string) => `Recovered at ${timestamp}`,
} as const;
