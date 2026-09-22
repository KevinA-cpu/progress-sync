export const PROGRESS_KEY = 'attempts-v1';
export const HDL_HOST = 'hdlbits.01xz.net';
export const HDL_ORIGIN = `https://${HDL_HOST}`;
export const HDL_HOST_MATCH = `${HDL_ORIGIN}/*`;
export const HDL_PROBLEM_PREFIX = `${HDL_ORIGIN}/wiki/`;
export const HDL_PROBLEM_PATH = '/wiki/';
export const HDL_PROBLEM_MATCH = `${HDL_PROBLEM_PREFIX}*`;
export const GRADING_URL = `${HDL_ORIGIN}/runsim.php`;
export const MAX_SOURCE_BYTES = 256 * 1024;
export const RESULT_TIMEOUT_MS = 120_000;
export const SOURCE_HASH_ALGORITHM = 'SHA-256';
export const PROGRESS_PROVIDER = 'hdlbits';
export const CAPTURE_PROVENANCE = 'browser-post';
export const CAPTURE_STATE = {
  pending: 'pending', accepted: 'accepted', failed: 'failed', unverified: 'unverified',
} as const;
// Every outcome the current result contract states. Anything else stays unknown and is never recorded as a
// graded outcome.
export const GRADING_VERDICT = {
  success: 'success', incorrect: 'incorrect', compileError: 'compile-error',
  simulationError: 'simulation-error', unknown: 'unknown',
} as const;
export const FAILED_VERDICT = [
  GRADING_VERDICT.incorrect, GRADING_VERDICT.compileError, GRADING_VERDICT.simulationError,
] as const;
export type FailedVerdict = (typeof FAILED_VERDICT)[number];
export type GradingVerdict = (typeof GRADING_VERDICT)[keyof typeof GRADING_VERDICT];
export function isFailedVerdict(verdict: string): verdict is FailedVerdict {
  return (FAILED_VERDICT as readonly string[]).includes(verdict);
}
// The verdict is reported as soon as the result document states it. Diagrams and late messages are reported
// separately once the result stops changing, so a slow chart never delays or alters the recorded outcome.
export const PROGRESS_MESSAGE = {
  result: 'hdlbits:result', artifacts: 'hdlbits:artifacts', list: 'progress:list',
} as const;
export const HDL_SUCCESS_HEADING = 'Status: Success!';
// The status line the provider prints is the whole of its stated verdict contract; nothing else on the result
// page is read as a verdict.
export const HDL_STATUS_HEADING = {
  [HDL_SUCCESS_HEADING]: GRADING_VERDICT.success,
  'Status: Incorrect': GRADING_VERDICT.incorrect,
  'Status: Compile Error': GRADING_VERDICT.compileError,
  'Status: Simulation Error': GRADING_VERDICT.simulationError,
} as const satisfies Record<string, GradingVerdict>;
export const VERDICT_LABEL = {
  [GRADING_VERDICT.success]: 'Accepted',
  [GRADING_VERDICT.incorrect]: 'Incorrect',
  [GRADING_VERDICT.compileError]: 'Compile error',
  [GRADING_VERDICT.simulationError]: 'Simulation error',
  [GRADING_VERDICT.unknown]: 'Unknown',
} as const satisfies Record<GradingVerdict, string>;

export const PROGRESS_TEXT = {
  recordingFailed: 'Progress recording failed.',
  failureBadge: '!',
  interrupted: 'Observation was interrupted. Reload the problem and resubmit.',
  invalidSave: 'Local progress could not be saved because the attempt record is invalid.',
  timeout: 'Result timed out. Reload the problem and resubmit.',
  unmatchedResult: 'The result could not be tied to this submission. Reload and resubmit.',
  accepted: 'Accepted locally - not saved to GitHub',
  failed: 'HDLBits did not accept this submission.',
  incompleteFailure: 'Failed attempts require complete source, result provenance, and a submission report.',
  inconsistentReport: 'A submission report must state the status line its outcome was read from and attribute its diagrams to the same problem.',
  outcomeLabel: 'Outcome',
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
  artifactsUndelivered: 'Progress Sync: diagram and message observation could not be delivered.',
  artifactsPending: 'Reading the result diagrams and messages',
  artifactsTimedOut: 'The result kept changing past the observation window. Its diagrams were not captured.',
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
  failedLocally: (label: string) => `${label} - not saved to GitHub`,
  unverified: (reason: string) => `Unverified: ${reason}`,
  attemptCount: (count: number) => `${count} captured attempt${count === 1 ? '' : 's'}.`,
  resultTitle: (problemId: string) => `${problemId}: Simulation - HDLBits`,
} as const;
