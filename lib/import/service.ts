import { browser, type Browser } from 'wxt/browser';
import { EXTENSION_PAGE, STORAGE_ACCESS } from '../constants/browser';
import {
  IMPORT_CLAIM, IMPORT_DISCOVERY_KEY, IMPORT_FAILURE, IMPORT_LIMIT, IMPORT_MESSAGE, IMPORT_SOURCE, IMPORT_STATUS,
  IMPORT_STOP, IMPORT_TABS_KEY, IMPORT_TEXT,
} from '../constants/import';
import { HDL_ORIGIN, HDL_PROBLEM_PREFIX, PROGRESS_PROVIDER } from '../constants/progress';
import { hashSource, problemIdSchema, sourceByteLength } from '../progress';
import { AuthFault } from '../github/schemas';
import { DestinationFault } from '../destination/schemas';
import { DeliveryFault } from '../delivery/schemas';
import {
  ImportFault, importCandidateSchema, importDiscoverySchema, importProgressSchema, importReadySchema, importRecordId,
  importRequestSchema, importScanReplySchema, importPagesSchema, parseImport, type ImportCandidate,
  type ImportDiscovery, type ImportedSnapshot, type ImportPage, type ImportProgress, type ImportPublishRequest,
  type ImportReply, type ImportSource,
} from './schemas';

interface ScanSession {
  id: string;
  tabId: number | null;
  documentId: string | null;
  offset: number;
  source: ImportSource | null;
  cancelled: boolean;
  bytes: number;
}
type ProgressReply = { ok: boolean; proceed: boolean };

function problemPage(url: string | undefined): boolean {
  if (!url?.startsWith(HDL_PROBLEM_PREFIX)) return false;
  try {
    return problemIdSchema.safeParse(
      decodeURIComponent(url.slice(HDL_PROBLEM_PREFIX.length).split(/[?#]/)[0] ?? '').toLowerCase(),
    ).success;
  } catch {
    return false;
  }
}

export function createImportService(
  publishImport: (candidate: ImportCandidate, request: ImportPublishRequest) => Promise<void>,
  publishedImport: (recordId: string) => Promise<ImportedSnapshot | null>,
) {
  const ready = browser.storage.local.setAccessLevel({ accessLevel: STORAGE_ACCESS.trustedContexts });
  let queue: Promise<unknown> = ready;
  let session: ScanSession | null = null;

  function run<T>(operation: () => Promise<T>): Promise<T> {
    const result = queue.then(operation);
    queue = result.then(() => undefined, () => undefined);
    return result;
  }
  async function stored(): Promise<ImportDiscovery | null> {
    await ready;
    const value: unknown = (await browser.storage.local.get(IMPORT_DISCOVERY_KEY))[IMPORT_DISCOVERY_KEY];
    return value === undefined ? null : parseImport(value, importDiscoverySchema);
  }
  async function put(state: ImportDiscovery): Promise<void> {
    await browser.storage.local.set({ [IMPORT_DISCOVERY_KEY]: parseImport(state, importDiscoverySchema) });
  }
  async function pages(): Promise<ImportPage[]> {
    const value: unknown = (await browser.storage.session.get(IMPORT_TABS_KEY))[IMPORT_TABS_KEY];
    return value === undefined ? [] : parseImport(value, importPagesSchema);
  }
  // Registry updates share the service queue so two pages announcing themselves cannot overwrite each other.
  function remember(page: ImportPage): Promise<void> {
    return run(async () => {
      const current = await pages();
      const next = [page, ...current.filter(item => item.documentId !== page.documentId)]
        .slice(0, IMPORT_LIMIT.tabs);
      await browser.storage.session.set({ [IMPORT_TABS_KEY]: parseImport(next, importPagesSchema) });
    });
  }
  function forget(match: (page: ImportPage) => boolean): Promise<void> {
    return run(async () => {
      const current = await pages();
      const next = current.filter(page => !match(page));
      if (next.length === current.length) return;
      await browser.storage.session.set({ [IMPORT_TABS_KEY]: parseImport(next, importPagesSchema) });
    });
  }
  // A superseded or cancelled scan is told to stop reading, not just ignored.
  async function halt(active: ScanSession): Promise<void> {
    if (active.tabId === null || active.documentId === null) return;
    await browser.tabs.sendMessage(
      active.tabId, { type: IMPORT_MESSAGE.stop, sessionId: active.id }, { documentId: active.documentId },
    ).catch(() => undefined);
  }
  function finish(
    sessionId: string, error: string | null, inventory: number | null, source: ImportSource | null,
  ): Promise<void> {
    return run(async () => {
      const active = session;
      if (!active || active.id !== sessionId) return;
      const cancelled = active.cancelled;
      session = null;
      const state = await stored();
      if (state?.status !== IMPORT_STATUS.running) return;
      const failed = !cancelled && error !== null;
      const counted = inventory ?? state.inventory;
      await put({
        ...state, updatedAt: new Date().toISOString(), error: failed ? error : null,
        inventory: counted, offset: Math.min(state.offset, counted), source: source ?? state.source ?? null,
        status: failed ? IMPORT_STATUS.failed : cancelled ? IMPORT_STATUS.cancelled : IMPORT_STATUS.complete,
      });
    });
  }
  // Discovery only ever reads through a problem page the learner already has open; it never opens or navigates one.
  async function scan(
    sessionId: string, candidates: ImportPage[], offset: number, source: ImportSource | null,
  ): Promise<void> {
    let error: string | null = IMPORT_TEXT.noPage;
    let inventory: number | null = null;
    let read: ImportSource | null = null;
    for (const page of candidates) {
      const active = session;
      if (!active || active.id !== sessionId) return;
      active.tabId = page.tabId;
      active.documentId = page.documentId;
      let reply: unknown;
      try {
        reply = await browser.tabs.sendMessage(page.tabId, {
          type: IMPORT_MESSAGE.scan, sessionId, offset, limit: IMPORT_LIMIT.problems, source,
        }, { documentId: page.documentId });
      } catch {
        await forget(item => item.documentId === page.documentId)
          .catch(() => console.error(IMPORT_TEXT.operationFailed));
        continue;
      }
      const parsed = importScanReplySchema.safeParse(reply);
      error = !parsed.success ? IMPORT_TEXT.scanFailed : parsed.data.ok ? null : parsed.data.error;
      if (parsed.success && parsed.data.ok) {
        inventory = parsed.data.inventory;
        read = parsed.data.source;
      }
      break;
    }
    await finish(sessionId, error, inventory, read);
  }
  async function discover(): Promise<ImportDiscovery> {
    const previous = await stored();
    const superseded = session;
    if (superseded) {
      superseded.cancelled = true;
      session = null;
      await halt(superseded);
    }
    const candidates = await pages();
    if (candidates.length === 0) throw new ImportFault(IMPORT_TEXT.noPage);
    // A pass that did not reach the end of the list continues from where it stopped.
    const stopped = previous?.stopped === IMPORT_STOP.budget;
    const carry = previous && previous.status !== IMPORT_STATUS.running
      && (stopped || previous.offset + previous.scanned < previous.inventory) ? previous : null;
    // A full preview list restarts at the first problem it could not hold, so nothing is passed over unread.
    const full = carry !== null && (stopped || carry.candidates.length >= IMPORT_LIMIT.problems);
    const offset = carry ? Math.min(carry.offset + carry.scanned - (stopped ? 1 : 0), carry.inventory) : 0;
    // A continuation has to read the same list its offset counts against. State saved before the statistics page
    // could be read names no list, so a pass that already read something is continued as the navigation list it
    // must have come from; a pass that read nothing leaves the choice open.
    const source = carry
      ? carry.source ?? (carry.offset + carry.scanned > 0 ? IMPORT_SOURCE.navigation : null)
      : null;
    const now = new Date().toISOString();
    const state: ImportDiscovery = {
      schemaVersion: 1, status: IMPORT_STATUS.running, origin: HDL_ORIGIN, startedAt: now, updatedAt: now,
      offset, inventory: carry?.inventory ?? 0, source, scanned: 0, total: 0, stopped: null,
      candidates: full ? [] : carry?.candidates ?? [],
      // Skipped problems survive a restarted preview list; the one the byte budget stopped is read again instead.
      failures: (carry?.failures ?? []).filter(item => item.reason !== IMPORT_FAILURE.budgetExhausted), error: null,
    };
    await put(state);
    session = {
      id: crypto.randomUUID(), tabId: null, documentId: null, offset, source, cancelled: false,
      bytes: state.candidates.reduce((total, candidate) => total + candidate.sourceBytes, 0),
    };
    void scan(session.id, candidates, offset, source).catch(() => console.error(IMPORT_TEXT.operationFailed));
    return state;
  }
  async function cancel(): Promise<ImportDiscovery | null> {
    const active = session;
    if (active) {
      active.cancelled = true;
      void halt(active).catch(() => undefined);
    }
    const state = await stored();
    if (state?.status !== IMPORT_STATUS.running) return state;
    const cancelled = { ...state, status: IMPORT_STATUS.cancelled, updatedAt: new Date().toISOString() };
    await put(cancelled);
    return cancelled;
  }
  async function record(input: ImportProgress, page: ImportPage): Promise<ProgressReply> {
    const active = session;
    if (!active || active.id !== input.sessionId || active.tabId !== page.tabId
      || active.documentId !== page.documentId) return { ok: false, proceed: false };
    // A continuation that answered from a different list than it was asked for is not recorded against this offset.
    if (active.source !== null && active.source !== input.source) return { ok: false, proceed: false };
    if (active.cancelled) return { ok: true, proceed: false };
    const state = await stored();
    if (state?.status !== IMPORT_STATUS.running) return { ok: false, proceed: false };
    const now = new Date().toISOString();
    const base = {
      ...state, updatedAt: now, scanned: input.scanned, total: input.total, inventory: input.inventory,
      source: input.source,
    };
    // One entry per problem, kept for the whole continuation: no skipped problem is dropped to make room.
    function skip(reason: ImportDiscovery['failures'][number]['reason']) {
      return {
        ...base,
        failures: [
          ...base.failures.filter(item => item.problemId !== input.problemId), { problemId: input.problemId, reason },
        ],
      };
    }
    if (!input.result.found) {
      await put(skip(input.result.reason));
      return { ok: true, proceed: true };
    }
    const sourceBytes = sourceByteLength(input.result.source);
    if (state.candidates.length >= IMPORT_LIMIT.problems || active.bytes + sourceBytes > IMPORT_LIMIT.totalBytes) {
      await put({ ...skip(IMPORT_FAILURE.budgetExhausted), stopped: IMPORT_STOP.budget });
      return { ok: true, proceed: false };
    }
    const sourceHash = await hashSource(input.result.source);
    const identity = {
      provider: PROGRESS_PROVIDER, problemId: input.problemId, submissionId: input.result.submissionId, sourceHash,
    };
    const candidate = parseImport({
      schemaVersion: 1, recordId: await importRecordId(identity), ...identity, claim: IMPORT_CLAIM, verified: false,
      providerLabel: input.result.providerLabel, providerStatus: input.result.providerStatus,
      source: input.result.source, sourceBytes, discoveredAt: now,
    }, importCandidateSchema, IMPORT_TEXT.invalidImport);
    active.bytes += sourceBytes;
    await put({
      ...base,
      candidates: [...state.candidates.filter(item => item.recordId !== candidate.recordId), candidate],
    });
    return { ok: true, proceed: true };
  }
  // A record already published to one destination stays publishable to another after a new preview batch replaces
  // the candidate list. Its stored snapshot is immutable, and delivery revalidates it before anything is written.
  function cached(snapshot: ImportedSnapshot): ImportCandidate {
    const { kind, id, ...candidate } = snapshot;
    return parseImport(candidate, importCandidateSchema, IMPORT_TEXT.invalidImport);
  }
  async function publish(request: ImportPublishRequest): Promise<void> {
    const state = await run(stored);
    const previewed = state?.candidates.find(item => item.recordId === request.recordId);
    const published = previewed ? null : await publishedImport(request.recordId);
    const candidate = previewed ?? (published ? cached(published) : null);
    if (!candidate || candidate.sourceHash !== request.expectedSourceHash) {
      throw new ImportFault(IMPORT_TEXT.staleSelection);
    }
    await publishImport(candidate, request);
  }
  async function view(): Promise<ImportReply> {
    return { ok: true, state: await run(stored) };
  }
  function closed(tabId: number): void {
    void forget(page => page.tabId === tabId).catch(() => console.error(IMPORT_TEXT.operationFailed));
  }
  // A discovery still marked running at worker start cannot be resumed; nothing was imported or published.
  // Saved state that cannot be read or parsed is reported and left exactly as it is, never rewritten.
  function resume(): void {
    void run(async () => {
      if (session) return;
      const state = await stored();
      if (state?.status !== IMPORT_STATUS.running) return;
      await put({
        ...state, status: IMPORT_STATUS.failed, error: IMPORT_TEXT.interrupted, updatedAt: new Date().toISOString(),
      });
    }).catch(() => console.error(IMPORT_TEXT.interruptionUnrecorded));
  }
  async function message(value: unknown, sender: Browser.runtime.MessageSender): Promise<unknown> {
    const tabId = sender.tab?.id;
    const documentId = sender.documentId;
    const fromExtension = sender.id === browser.runtime.id && sender.frameId === 0 && tabId !== undefined;
    const fromProblemPage = fromExtension && sender.origin === HDL_ORIGIN && !!documentId && problemPage(sender.url);
    const fromOptions = fromExtension && !!documentId
      && sender.url === browser.runtime.getURL(EXTENSION_PAGE.options);
    if (fromProblemPage && importReadySchema.safeParse(value).success) {
      return await remember({ tabId, documentId })
        .then(() => ({ ok: true }), () => ({ ok: false, error: IMPORT_TEXT.readFailed }));
    }
    const progress = importProgressSchema.safeParse(value);
    if (progress.success) {
      if (!fromProblemPage) return { ok: false, proceed: false };
      return await run(() => record(progress.data, { tabId, documentId }))
        .catch(() => ({ ok: false, proceed: false }));
    }
    const parsed = importRequestSchema.safeParse(value);
    if (!fromOptions || !parsed.success) return { ok: false, error: IMPORT_TEXT.invalidInput } satisfies ImportReply;
    try {
      const input = parsed.data;
      switch (input.type) {
        case IMPORT_MESSAGE.list:
          return await view();
        case IMPORT_MESSAGE.discover:
          return { ok: true, state: await run(discover) } satisfies ImportReply;
        case IMPORT_MESSAGE.cancel:
          return { ok: true, state: await run(cancel) } satisfies ImportReply;
        case IMPORT_MESSAGE.publish:
          await publish(input);
          return await view();
      }
    } catch (error) {
      return {
        ok: false,
        error: error instanceof ImportFault || error instanceof DeliveryFault || error instanceof DestinationFault
          ? error.message
          : error instanceof AuthFault ? IMPORT_TEXT.noDestination : IMPORT_TEXT.operationFailed,
      } satisfies ImportReply;
    }
  }
  return { message, closed, resume };
}
