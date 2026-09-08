export const PROGRESS_KEY = 'attempts-v1';
export const HDL_HOST = 'hdlbits.01xz.net';
export const HDL_ORIGIN = `https://${HDL_HOST}`;
export const HDL_HOST_MATCH = `${HDL_ORIGIN}/*`;
export const HDL_PROBLEM_PREFIX = `${HDL_ORIGIN}/wiki/`;
export const GRADING_URL = `${HDL_ORIGIN}/runsim.php`;
export const MAX_SOURCE_BYTES = 256 * 1024;
export const RESULT_TIMEOUT_MS = 120_000;
export const SOURCE_HASH_ALGORITHM = 'SHA-256';
export const PROGRESS_PROVIDER = 'hdlbits';
export const CAPTURE_PROVENANCE = 'browser-post';
export const CAPTURE_STATE = { pending: 'pending', accepted: 'accepted', unverified: 'unverified' } as const;
export const GRADING_VERDICT = { success: 'success', failure: 'failure', unknown: 'unknown' } as const;
export const PROGRESS_MESSAGE = { result: 'hdlbits:result', list: 'progress:list' } as const;
export const HDL_SUCCESS_HEADING = 'Status: Success!';

export const PROGRESS_TEXT = {
  recordingFailed: 'Progress recording failed.',
  failureBadge: '!',
  interrupted: 'Observation was interrupted. Reload the problem and resubmit.',
  invalidSave: 'Local progress could not be saved because the attempt record is invalid.',
  timeout: 'Result timed out. Reload the problem and resubmit.',
  unmatchedResult: 'The result could not be tied to this submission. Reload and resubmit.',
  accepted: 'Accepted locally - not saved to GitHub',
  failed: 'HDLBits did not accept this submission.',
  ambiguousResult: 'The grading result is unsupported or ambiguous. Reload and resubmit.',
  navigationReplaced: 'A different navigation replaced the submission result.',
  waiting: 'Waiting for the result - not saved to GitHub',
  unsupported: 'Unsupported submission. Use the in-page text editor; source limit is 256 KiB.',
  unverifiedOrigin: 'The originating problem document could not be verified.',
  quarantined: 'This page has an ambiguous observation. Reload the problem and resubmit.',
  predatesObserver: 'The problem document predates this observer. Reload the problem and resubmit.',
  overlapping: 'Overlapping submissions to the same result frame are ambiguous. Reload the problem and resubmit separately.',
  problemNavigated: 'The problem navigated before its result was observed.',
  unexpectedNavigation: 'An unexpected result navigation made this attempt unverified.',
  unsuccessfulResponse: 'The grading request did not return a fresh successful response.',
  requestInterrupted: 'The grading request failed or redirected. Reload and resubmit.',
  rejectedMessage: 'Progress Sync rejected an unsupported message or sender.',
  unsupportedMessage: 'Unsupported message or sender.',
  unobservedSubmission: 'No matching observed submission. This result is unverified.',
  multipleDocuments: 'Multiple result documents made this attempt ambiguous.',
  sourceTooLarge: 'Submitted source exceeds the byte limit.',
  incompleteAcceptance: 'Accepted attempts require complete source and result provenance.',
  invalidStoredData: 'Local progress is invalid or unsupported. It has not been overwritten.',
  interfaceIncomplete: 'Progress interface is incomplete.',
  readFailed: 'Local progress could not be read.',
  empty: 'No captured attempts yet. Submit using the in-page HDLBits editor.',
  resultUnrecorded: 'Progress Sync: this result was not recorded as an accepted attempt.',
  resultUndelivered: 'Progress Sync: result observation could not be delivered.',
  notYet: 'Not yet',
  unavailable: 'Unavailable',
  submittedSource: 'Submitted source',
  captureDescription: 'Browser-observed POST; extension observation, not a signed grading certificate',
  attemptLabel: 'Attempt',
  submittedLabel: 'Submitted',
  observedLabel: 'Observed',
  hashLabel: 'SHA-256 (submitted bytes)',
  captureLabel: 'Capture',
  problemHeading: (problemId: string | null) => `${PROGRESS_PROVIDER}:${problemId ?? 'unknown'}`,
  unverified: (reason: string) => `Unverified: ${reason}`,
  attemptCount: (count: number) => `${count} captured attempt${count === 1 ? '' : 's'}.`,
  resultTitle: (problemId: string) => `${problemId}: Simulation - HDLBits`,
} as const;
