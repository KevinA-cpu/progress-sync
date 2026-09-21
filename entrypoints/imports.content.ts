import { browser } from 'wxt/browser';
import { defineContentScript } from 'wxt/utils/define-content-script';
import { CONTENT_SCRIPT_RUN_AT, HTTP_METHOD } from '../lib/constants/browser';
import {
  IMPORT_FAILURE, IMPORT_FETCH, IMPORT_FIELD, IMPORT_LIMIT, IMPORT_LOAD_SUCCESS, IMPORT_MEDIA_TYPE, IMPORT_MESSAGE,
  IMPORT_PAGE_FETCH, IMPORT_PROBLEM_URL, IMPORT_SCRIPT_SELECTOR, IMPORT_SECONDS, IMPORT_SELECT_SELECTOR,
  IMPORT_SOLVED_SELECTOR, IMPORT_SUCCESS_ENTRY, IMPORT_SUCCESS_LABEL, IMPORT_TEXT, IMPORT_LOAD_URL,
} from '../lib/constants/import';
import { HDL_ORIGIN, HDL_PROBLEM_MATCH, HDL_PROBLEM_PATH } from '../lib/constants/progress';
import { sameProblemPage } from '../lib/import/page';
import { problemIdSchema, submittedSourceSchema } from '../lib/progress';
import {
  importProgressReplySchema, importReadyReplySchema, importScanRequestSchema, importStopRequestSchema,
  importSubmissionIdSchema, providerLoadSchema, type ImportProgress, type ImportScanRequest,
} from '../lib/import/schemas';

type Reason = (typeof IMPORT_FAILURE)[keyof typeof IMPORT_FAILURE];
type Stored = { submissionId: string; providerLabel: string };
type Loaded = { source: string; providerStatus: number };

let running: { sessionId: string; controller: AbortController } | null = null;

function stop(sessionId: string | null): void {
  if (!running || (sessionId !== null && running.sessionId !== sessionId)) return;
  running.controller.abort();
  running = null;
}

// Every provider read is bounded: the scan's own cancellation plus a per-request deadline.
function deadline(scope: AbortSignal): AbortSignal {
  return AbortSignal.any([scope, AbortSignal.timeout(IMPORT_LIMIT.requestMs)]);
}

// The body is read in chunks so an oversized or stalled response is dropped instead of buffered whole.
async function boundedText(response: Response, limit: number): Promise<string | null> {
  if (!response.body) return null;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let bytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) return text + decoder.decode();
      bytes += chunk.value.length;
      if (bytes > limit) {
        void reader.cancel().catch(() => undefined);
        return null;
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
  } catch {
    return null;
  }
}

function solvedProblems(): string[] {
  const found: string[] = [];
  for (const marked of document.querySelectorAll(IMPORT_SOLVED_SELECTOR)) {
    const anchor = marked.closest('a[href]') ?? marked.parentElement?.querySelector('a[href]');
    const href = anchor?.getAttribute('href');
    if (!href) continue;
    let url: URL;
    try {
      url = new URL(href, document.baseURI);
    } catch {
      continue;
    }
    if (url.origin !== HDL_ORIGIN || !url.pathname.startsWith(HDL_PROBLEM_PATH)) continue;
    let problemId: string;
    try {
      problemId = decodeURIComponent(url.pathname.slice(HDL_PROBLEM_PATH.length)).toLowerCase();
    } catch {
      continue;
    }
    if (problemIdSchema.safeParse(problemId).success && !found.includes(problemId)) found.push(problemId);
  }
  return found;
}

function mediaType(response: Response): string {
  return (response.headers.get('content-type') ?? '').trim().toLowerCase();
}

// Fetched markup is parsed detached from the page, so nothing in it runs or reaches the learner's editor.
async function storedSubmission(problemId: string, scope: AbortSignal): Promise<Stored | Reason> {
  // Same-origin mode makes a hop off this origin a network error; what a chain ended on still has to be
  // the problem that was asked for.
  const response = await fetch(IMPORT_PROBLEM_URL(problemId), { ...IMPORT_PAGE_FETCH, signal: deadline(scope) })
    .catch(() => null);
  if (!response || !response.ok || !sameProblemPage(response.url, problemId)) return IMPORT_FAILURE.pageUnavailable;
  if (!mediaType(response).startsWith(IMPORT_MEDIA_TYPE.html)) return IMPORT_FAILURE.pageUnavailable;
  const markup = await boundedText(response, IMPORT_LIMIT.pageBytes);
  if (markup === null) return IMPORT_FAILURE.pageUnavailable;
  const parsed = new DOMParser().parseFromString(markup, IMPORT_MEDIA_TYPE.html);
  if (!(parsed.querySelector(IMPORT_SELECT_SELECTOR) instanceof HTMLSelectElement)) {
    return IMPORT_FAILURE.pageUnavailable;
  }
  // The page ships its stored submissions as an inline literal and builds the control from it at runtime,
  // so the entry is read out of the script text. Nothing fetched is executed.
  for (const script of parsed.querySelectorAll(IMPORT_SCRIPT_SELECTOR)) {
    const text = script.textContent ?? '';
    if (!text.includes(IMPORT_SUCCESS_LABEL)) continue;
    const entry = IMPORT_SUCCESS_ENTRY.exec(text);
    if (!entry) continue;
    const [, submissionId, recordedAt] = entry;
    if (submissionId === undefined || recordedAt === undefined) return IMPORT_FAILURE.noStoredSuccess;
    // The site posts this value verbatim; an unaddressable one is reported rather than sent.
    if (!importSubmissionIdSchema.safeParse(submissionId).success) return IMPORT_FAILURE.submissionInvalid;
    const recorded = new Date(Number(recordedAt) * IMPORT_SECONDS);
    if (Number.isNaN(recorded.getTime())) return IMPORT_FAILURE.pageUnavailable;
    // The site's own timestamp, stated in UTC rather than re-rendered in this browser's locale.
    return { submissionId, providerLabel: `${IMPORT_SUCCESS_LABEL}: ${recorded.toISOString()}` };
  }
  return IMPORT_FAILURE.pageUnavailable;
}

async function loadSource(problemId: string, submissionId: string, scope: AbortSignal): Promise<Loaded | Reason> {
  const body = new URLSearchParams({
    [IMPORT_FIELD.problem]: problemId, [IMPORT_FIELD.submission]: submissionId,
  });
  const response = await fetch(IMPORT_LOAD_URL, {
    ...IMPORT_FETCH, method: HTTP_METHOD.post, body, signal: deadline(scope),
  }).catch(() => null);
  if (!response || !response.ok || response.redirected) return IMPORT_FAILURE.loadFailed;
  const type = mediaType(response);
  if (type.startsWith(IMPORT_MEDIA_TYPE.html)) return IMPORT_FAILURE.sessionRequired;
  if (!type.startsWith(IMPORT_MEDIA_TYPE.json)) return IMPORT_FAILURE.loadInvalid;
  const text = await boundedText(response, IMPORT_LIMIT.loadBytes);
  if (text === null) return IMPORT_FAILURE.loadInvalid;
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    return IMPORT_FAILURE.loadInvalid;
  }
  const parsed = providerLoadSchema.safeParse(payload);
  if (!parsed.success) return IMPORT_FAILURE.loadInvalid;
  // The site reads data only for this status; any other status is its own failure, whatever else it carries.
  if (parsed.data.status !== IMPORT_LOAD_SUCCESS) return IMPORT_FAILURE.loadRejected;
  const source = submittedSourceSchema.safeParse(parsed.data.data);
  if (!source.success) return IMPORT_FAILURE.loadInvalid;
  return { source: source.data, providerStatus: parsed.data.status };
}

async function scan(request: ImportScanRequest) {
  stop(null);
  const controller = new AbortController();
  running = { sessionId: request.sessionId, controller };
  const scope = controller.signal;
  try {
    const all = solvedProblems();
    if (all.length > IMPORT_LIMIT.inventory) return { ok: false as const, error: IMPORT_TEXT.tooManyProblems };
    const inventory = all.length;
    const window = all.slice(request.offset, request.offset + request.limit);
    let scanned = 0;
    for (const problemId of window) {
      if (scope.aborted) return { ok: true as const, scanned, inventory, stopped: true };
      const stored = await storedSubmission(problemId, scope);
      const loaded = typeof stored === 'string' ? stored : await loadSource(problemId, stored.submissionId, scope);
      if (scope.aborted) return { ok: true as const, scanned, inventory, stopped: true };
      scanned++;
      const progress: ImportProgress = {
        type: IMPORT_MESSAGE.progress, sessionId: request.sessionId, problemId,
        inventory, total: window.length, scanned,
        result: typeof stored === 'string' ? { found: false, reason: stored }
          : typeof loaded === 'string' ? { found: false, reason: loaded }
            : {
              found: true, submissionId: stored.submissionId, providerLabel: stored.providerLabel,
              providerStatus: loaded.providerStatus, source: loaded.source,
            },
      };
      const reply = importProgressReplySchema.safeParse(await browser.runtime.sendMessage(progress));
      if (!reply.success || !reply.data.ok) return { ok: false as const, error: IMPORT_TEXT.progressFailed };
      if (!reply.data.proceed) return { ok: true as const, scanned, inventory, stopped: true };
    }
    return { ok: true as const, scanned, inventory, stopped: false };
  } finally {
    if (running?.controller === controller) running = null;
  }
}

export default defineContentScript({
  matches: [HDL_PROBLEM_MATCH],
  allFrames: false,
  runAt: CONTENT_SCRIPT_RUN_AT,
  main() {
    browser.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
      if (sender.id !== browser.runtime.id || sender.tab !== undefined) return;
      const halt = importStopRequestSchema.safeParse(message);
      if (halt.success) {
        stop(halt.data.sessionId);
        sendResponse({ ok: true });
        return;
      }
      const parsed = importScanRequestSchema.safeParse(message);
      if (!parsed.success) return;
      void scan(parsed.data).then(sendResponse, () => {
        sendResponse({ ok: false, error: IMPORT_TEXT.scanFailed });
      });
      return true;
    });
    // A page that is not listed cannot be scanned, so a refused or undelivered announcement is reported.
    void browser.runtime.sendMessage({ type: IMPORT_MESSAGE.ready }).then((reply: unknown) => {
      const parsed = importReadyReplySchema.safeParse(reply);
      if (!parsed.success || !parsed.data.ok) console.warn(IMPORT_TEXT.pageUnregistered);
    }, () => {
      console.error(IMPORT_TEXT.pageUnannounced);
    });
  },
});
