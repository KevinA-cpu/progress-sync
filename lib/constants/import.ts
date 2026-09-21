import { DELIVERY_PATH } from './delivery';
import { HDL_ORIGIN, HDL_PROBLEM_PREFIX, MAX_SOURCE_BYTES, PROGRESS_PROVIDER } from './progress';

export const IMPORT_DISCOVERY_KEY = 'import-discovery-v1';
export const IMPORT_TABS_KEY = 'import-pages-v1';
export const IMPORT_MESSAGE_PREFIX = 'import:';
export const IMPORT_MESSAGE = {
  list: 'import:list', discover: 'import:discover', cancel: 'import:cancel', publish: 'import:publish',
  ready: 'import:ready', scan: 'import:scan', stop: 'import:stop', progress: 'import:progress',
} as const;
export const IMPORT_STATUS = {
  running: 'running', complete: 'complete', cancelled: 'cancelled', failed: 'failed',
} as const;
export const IMPORT_STOP = { budget: 'budget' } as const;
export const IMPORT_SNAPSHOT_KIND = 'imported';
export const IMPORT_PROVENANCE = 'site-load';
export const IMPORT_CLAIM = 'provider-last-success';
export const IMPORT_LOAD_URL = `${HDL_ORIGIN}/load.php`;
export const IMPORT_PROBLEM_URL = (problemId: string) => `${HDL_PROBLEM_PREFIX}${problemId}`;
export const IMPORT_SELECT_SELECTOR = '#uiload_select';
export const IMPORT_SOLVED_SELECTOR = '.hdlbits-stat-done';
export const IMPORT_SUCCESS_LABEL = 'Last success';
// The problem page serves the load control empty and fills it from an inline literal of the form
// var d = [ ['<submission>','Last success',<epoch seconds>], ... ]; a null id or time means none is stored.
// The literal is read as text, never executed.
export const IMPORT_SCRIPT_SELECTOR = 'script';
export const IMPORT_SUCCESS_ENTRY =
  /\[\s*(?:'([^'\\\n]{0,64})'|null)\s*,\s*'Last success'\s*,\s*(?:(\d{1,12})|null)\s*\]/;
export const IMPORT_SECONDS = 1000;
export const IMPORT_FIELD = { problem: 'tc', submission: 'name' } as const;
// The site's own load handler treats status 2 as the stored submission and every other status as a failure
// carrying an error string, so only 2 may be read as source.
export const IMPORT_LOAD_SUCCESS = 2;
export const IMPORT_MEDIA_TYPE = { html: 'text/html', json: 'application/json' } as const;
export const IMPORT_FETCH = {
  credentials: 'same-origin', mode: 'same-origin', redirect: 'error', cache: 'no-store',
} as const;
// HDLBits canonicalizes the case of a wiki path with a redirect, so a problem page read has to survive
// redirects. Same-origin mode makes any hop off this origin a network error, and the final URL is then
// checked against the problem that was asked for; anything else is treated as unreadable.
export const IMPORT_PAGE_FETCH = {
  credentials: 'same-origin', mode: 'same-origin', redirect: 'follow', cache: 'no-store',
} as const;
export const IMPORT_LIMIT = {
  problems: 100, inventory: 2000, totalBytes: 2 * 1024 * 1024, sourceBytes: MAX_SOURCE_BYTES,
  pageBytes: 2 * 1024 * 1024, loadBytes: MAX_SOURCE_BYTES + 64 * 1024, labelCharacters: 200, tabs: 16,
  requestMs: 20_000,
} as const;
export const IMPORT_HASH_PREFIX = 12;
export const IMPORT_PATH = { root: 'imports', source: DELIVERY_PATH.source, metadata: 'import.json' } as const;
export const importRoot = (provider: string, problem: string, submissionId: string, sourceHash: string) =>
  `${IMPORT_PATH.root}/${provider}/${problem}/${submissionId}/${sourceHash.slice(0, IMPORT_HASH_PREFIX)}`;
export const importPaths = (root: string) => ({
  source: `${root}/${IMPORT_PATH.source}`, metadata: `${root}/${IMPORT_PATH.metadata}`,
});
export const IMPORT_FAILURE = {
  pageUnavailable: 'page-unavailable', noStoredSuccess: 'no-stored-success', submissionInvalid: 'submission-invalid',
  loadFailed: 'load-failed', loadRejected: 'load-rejected', loadInvalid: 'load-invalid',
  sessionRequired: 'session-required', budgetExhausted: 'budget-exhausted',
} as const;
export const IMPORT_MESSAGES = {
  [IMPORT_FAILURE.pageUnavailable]: 'The problem page could not be read from HDLBits.',
  [IMPORT_FAILURE.noStoredSuccess]: 'HDLBits offers no stored successful submission for this problem.',
  [IMPORT_FAILURE.submissionInvalid]: 'HDLBits offered a stored submission Progress Sync cannot address.',
  [IMPORT_FAILURE.loadFailed]: 'HDLBits did not return the stored submission.',
  [IMPORT_FAILURE.loadRejected]: `HDLBits reported a failed load instead of a stored submission (status other than ${IMPORT_LOAD_SUCCESS}).`,
  [IMPORT_FAILURE.loadInvalid]: 'The stored submission was empty, oversized, or not in a supported shape.',
  [IMPORT_FAILURE.sessionRequired]: 'HDLBits answered as a signed-out visitor. Sign in to HDLBits in this browser, then find earlier solutions again.',
  [IMPORT_FAILURE.budgetExhausted]: 'Discovery reached its size limit before reading this problem.',
} satisfies Record<(typeof IMPORT_FAILURE)[keyof typeof IMPORT_FAILURE], string>;
export const IMPORT_TEXT = {
  invalidInput: 'Unsupported import operation or sender.',
  invalidData: 'Saved import data is invalid. It has not been overwritten.',
  interfaceIncomplete: 'Import interface is incomplete.',
  noPage: 'Open an HDLBits problem page in this browser, then find earlier solutions again. Progress Sync never opens or changes pages for you.',
  interrupted: 'Discovery stopped when the extension worker restarted. Nothing was imported or published. Find earlier solutions again.',
  interruptionUnrecorded: 'Progress Sync: an interrupted discovery could not be marked as stopped. Saved import data was left unchanged.',
  pageUnregistered: 'Progress Sync: this page was not listed for importing earlier solutions.',
  pageUnannounced: 'Progress Sync: this page could not announce itself for importing earlier solutions.',
  scanFailed: 'HDLBits could not be read. Nothing was imported.',
  progressFailed: 'What discovery read could not be saved, so it stopped. Nothing was imported or published.',
  tooManyProblems: 'This page lists more solved problems than Progress Sync can enumerate. Nothing was imported.',
  readFailed: 'Import state could not be read.',
  operationFailed: 'Progress Sync: import operation did not complete.',
  unverified: 'Imported - unverified',
  awaiting: 'Imported - unverified, awaiting GitHub delivery',
  saved: 'Imported - unverified, saved to GitHub',
  loading: 'Loading imports...',
  empty: 'No earlier solutions have been discovered in this browser profile yet.',
  discover: 'Find earlier solutions',
  cancel: 'Cancel discovery',
  sourceLabel: 'Imported source (read-only)',
  claimLabel: 'Provider claim',
  claimValue: 'HDLBits stored last successful submission; a site claim, not an acceptance Progress Sync observed',
  submissionLabel: 'Provider submission',
  statusLabel: 'Provider status field',
  labelLabel: 'Provider timestamp text',
  bytesLabel: 'Imported bytes',
  hashLabel: 'SHA-256 (imported bytes)',
  discoveredLabel: 'Discovered',
  recordLabel: 'Import record',
  scanning: (scanned: number, total: number) => `Reading stored submissions: ${scanned} of ${total} problems.`,
  cancelled: (found: number, scanned: number) => `Discovery cancelled after ${scanned} problems. ${found} available to import.`,
  complete: (found: number, skipped: number) =>
    `${found} earlier solution${found === 1 ? '' : 's'} available to import; ${skipped} problem${skipped === 1 ? '' : 's'} skipped.`,
  remaining: (read: number, inventory: number) =>
    ` Read ${read} of ${inventory} solved problems; find earlier solutions again to continue with the rest.`,
  budgetStopped: (read: number, inventory: number) =>
    ` Stopped at the preview limit after ${read} of ${inventory} solved problems. Publish what you want to keep; finding earlier solutions again starts a new preview list from where this one stopped.`,
  discardedRecord: 'This import was discarded in this browser profile. It cannot be published to this destination again from here; nothing was deleted from GitHub.',
  skipped: (problemId: string, reason: string) => `${PROGRESS_PROVIDER}:${problemId} - ${reason}`,
  publish: (owner: string, name: string, branch: string) =>
    `Publish imported solution to ${owner}/${name} @ ${branch} (public, unverified)`,
  publishConfirmation: (problemId: string) =>
    `Publish the imported ${problemId} solution to your public progress repository? It is recorded as imported and unverified: HDLBits' stored copy, not an acceptance Progress Sync observed. Publication cannot be undone from here.`,
  duplicate: 'This exact import already has a delivery job for this destination. Nothing was published again.',
  staleSelection: 'This preview is out of date. Find earlier solutions again before publishing.',
  noDestination: 'Select and verify a public progress repository before publishing an import.',
  invalidImport: 'Only a complete, validated import record can be published.',
  commitMessage: (provider: string, problem: string, submissionId: string) =>
    `Record imported ${provider}:${problem} submission ${submissionId} (unverified)`,
} as const;
