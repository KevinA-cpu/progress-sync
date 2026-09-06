import {
  DOCUMENT_LIFECYCLE, EXTENSION_PAGE, HTTP_METHOD, LOG_PREFIX, NAVIGATION_QUALIFIER, RESOURCE_TYPE,
  STORAGE_ACCESS,
} from './constants/browser';
import {
  CAPTURE_PROVENANCE, CAPTURE_STATE, GRADING_URL, GRADING_VERDICT, HDL_ORIGIN, HDL_PROBLEM_PREFIX,
  PROGRESS_KEY, PROGRESS_PROVIDER, PROGRESS_TEXT, RESULT_TIMEOUT_MS,
} from './constants/progress';
import { browser, type Browser } from 'wxt/browser';
import {
  attemptListSchema, hashSource, problemIdFieldSchema, progressRequestSchema, readAttempts,
  resultObservationSchema, submittedSourceFieldSchema, type Attempt, type ProgressReply,
  type ResultObservation,
} from './progress';

interface Operation {
  attempt: Attempt;
  completed: boolean;
  documentId: string | null;
  result: { documentId: string; observation: ResultObservation } | null;
}

export function createCaptureService(onAccepted: (attemptId: string) => Promise<string | null>) {
  let attempts: Attempt[] = [];
  const operations = new Map<string, Operation>();
  const quarantinedParents = new Set<string>();
  const observedParents = new Set<string>();
  let failure: string | null = null;

  function reportFailure(error: unknown): void {
    failure = error instanceof Error ? error.message : PROGRESS_TEXT.recordingFailed;
    console.error(LOG_PREFIX, failure);
    void browser.action.setBadgeText({ text: PROGRESS_TEXT.failureBadge }).catch(console.error);
  }

  const ready = browser.storage.local.setAccessLevel({ accessLevel: STORAGE_ACCESS.trustedContexts })
    .then(readAttempts)
    .then(async stored => {
      attempts = stored;
      let changed = false;
      for (const attempt of attempts) {
        if (attempt.state === CAPTURE_STATE.pending) {
          attempt.state = CAPTURE_STATE.unverified;
          attempt.reason = PROGRESS_TEXT.interrupted;
          attempt.requiresReload = true;
          changed = true;
        }
        if (attempt.requiresReload && attempt.provenance.parentDocumentId) {
          quarantinedParents.add(attempt.provenance.parentDocumentId);
        }
      }
      if (changed) await save();
    });
  let queue: Promise<void> = ready.catch(reportFailure);

  function run<T>(action: () => Promise<T>): Promise<T> {
    const result = queue.then(async () => {
      if (failure) throw new Error(failure);
      return action();
    });
    queue = result.then(() => undefined, reportFailure);
    return result;
  }

  function save(): Promise<void> {
    const parsed = attemptListSchema.safeParse(attempts);
    if (!parsed.success) {
      throw new Error(PROGRESS_TEXT.invalidSave);
    }
    return browser.storage.local.set({ [PROGRESS_KEY]: parsed.data });
  }

  function unverify(operation: Operation, reason: string, ambiguous = true): void {
    if (operation.attempt.state !== CAPTURE_STATE.pending) return;
    operation.attempt.state = CAPTURE_STATE.unverified;
    operation.attempt.reason = reason;
    operation.attempt.requiresReload = ambiguous;
    operation.attempt.observedAt = new Date().toISOString();
    const parent = operation.attempt.provenance.parentDocumentId;
    if (parent && ambiguous) quarantinedParents.add(parent);
  }

  async function expire(): Promise<void> {
    let changed = false;
    for (const operation of operations.values()) {
      if (operation.attempt.state === CAPTURE_STATE.pending
        && Date.now() - Date.parse(operation.attempt.submittedAt) >= RESULT_TIMEOUT_MS) {
        unverify(operation, PROGRESS_TEXT.timeout);
        changed = true;
      }
    }
    if (changed) await save();
  }

  // Request completion can precede navigation commit; neither alone proves which document was graded.
  async function finish(operation: Operation): Promise<void> {
    const { attempt, result, documentId } = operation;
    if (attempt.state !== CAPTURE_STATE.pending || !operation.completed || !result || !documentId) return;
    await expire();
    if (attempt.state !== CAPTURE_STATE.pending) return;
    const frame = await browser.webNavigation.getFrame({
      tabId: attempt.provenance.tabId, frameId: attempt.provenance.frameId,
    });
    if (result.documentId !== documentId || frame?.documentId !== documentId
      || frame.url !== GRADING_URL || frame.documentLifecycle !== DOCUMENT_LIFECYCLE.active
      || frame.parentDocumentId !== attempt.provenance.parentDocumentId
      || result.observation.problemId !== attempt.problemId) {
      unverify(operation, PROGRESS_TEXT.unmatchedResult);
    } else {
      switch (result.observation.verdict) {
        case GRADING_VERDICT.success:
          attempt.state = CAPTURE_STATE.accepted;
          attempt.reason = PROGRESS_TEXT.accepted;
          attempt.observedAt = new Date().toISOString();
          attempt.provenance.resultDocumentId = documentId;
          break;
        case GRADING_VERDICT.failure:
          unverify(operation, PROGRESS_TEXT.failed, false);
          break;
        case GRADING_VERDICT.unknown:
          unverify(operation, PROGRESS_TEXT.ambiguousResult, true);
          break;
      }
    }
    await save();
    operations.delete(attempt.provenance.requestId);
    if (attempt.state === CAPTURE_STATE.accepted) {
      const deliveryIssue = await onAccepted(attempt.id);
      if (deliveryIssue) {
        attempt.reason = deliveryIssue;
        await save();
      }
    }
  }

  function request(details: Browser.webRequest.OnBeforeRequestDetails): undefined {
    void run(async () => {
      await expire();
      if (details.method !== HTTP_METHOD.post) {
        if (details.parentDocumentId) quarantinedParents.add(details.parentDocumentId);
        for (const operation of operations.values()) {
          if (operation.attempt.provenance.tabId === details.tabId
            && operation.attempt.provenance.frameId === details.frameId) {
            unverify(operation, PROGRESS_TEXT.navigationReplaced);
          }
        }
        await save();
        return;
      }
      const form = details.requestBody?.formData;
      const parsedSource = submittedSourceFieldSchema.safeParse(form?.vlgcode_box);
      const parsedProblem = problemIdFieldSchema.safeParse(form?.tc);
      const source = parsedSource.success ? parsedSource.data[0] : null;
      const problemId = parsedProblem.success ? parsedProblem.data[0] : null;
      const parentDocumentId = details.parentDocumentId ?? null;
      const attempt: Attempt = {
        schemaVersion: 1, id: crypto.randomUUID(), provider: PROGRESS_PROVIDER,
        problemId, source, sourceHash: source === null ? null : await hashSource(source),
        submittedAt: new Date(details.timeStamp).toISOString(), observedAt: null,
        state: CAPTURE_STATE.pending, reason: PROGRESS_TEXT.waiting,
        requiresReload: false,
        provenance: {
          capture: CAPTURE_PROVENANCE, requestId: details.requestId,
          tabId: details.tabId, frameId: details.frameId, parentDocumentId,
          resultDocumentId: null,
        },
      };
      const operation: Operation = { attempt, completed: false, documentId: null, result: null };
      const overlapping = [...operations.values()].filter(item => item.attempt.state === CAPTURE_STATE.pending);
      attempts.push(attempt);
      operations.set(details.requestId, operation);
      if (!source || !problemId || !parentDocumentId || details.type !== RESOURCE_TYPE.subFrame
        || details.parentFrameId !== 0 || details.initiator !== HDL_ORIGIN
        || details.url !== GRADING_URL || details.requestBody?.error || form?.vlgcode) {
        unverify(operation, PROGRESS_TEXT.unsupported);
      } else {
        const parent = await browser.webNavigation.getFrame({ tabId: details.tabId, frameId: 0 });
        if (!parent || parent.documentId !== parentDocumentId
          || parent.documentLifecycle !== DOCUMENT_LIFECYCLE.active
          || parent.url.split('?')[0]?.split('#')[0]?.toLowerCase()
            !== `${HDL_PROBLEM_PREFIX}${problemId}`) {
          unverify(operation, PROGRESS_TEXT.unverifiedOrigin);
        } else if (quarantinedParents.has(parentDocumentId)) {
          unverify(operation, PROGRESS_TEXT.quarantined);
        } else if (!observedParents.has(parentDocumentId)) {
          unverify(operation, PROGRESS_TEXT.predatesObserver);
        }
      }
      if (overlapping.length) {
        for (const item of [...overlapping, operation]) {
          unverify(item, PROGRESS_TEXT.overlapping);
        }
      }
      await save();
      setTimeout(() => { void run(expire).catch(reportFailure); }, RESULT_TIMEOUT_MS);
    }).catch(reportFailure);
    return undefined;
  }

  function committed(details: Browser.webNavigation.WebNavigationTransitionCallbackDetails): void {
    void run(async () => {
      if (details.frameId === 0) {
        if (details.url.startsWith(HDL_PROBLEM_PREFIX) && details.documentLifecycle === DOCUMENT_LIFECYCLE.active) {
          observedParents.add(details.documentId);
        }
        let changed = false;
        for (const operation of operations.values()) {
          if (operation.attempt.state === CAPTURE_STATE.pending
            && operation.attempt.provenance.tabId === details.tabId
            && operation.attempt.provenance.parentDocumentId !== details.documentId) {
            unverify(operation, PROGRESS_TEXT.problemNavigated);
            changed = true;
          }
        }
        if (changed) await save();
        return;
      }
      for (const operation of operations.values()) {
        const provenance = operation.attempt.provenance;
        if (provenance.tabId !== details.tabId || provenance.frameId !== details.frameId) continue;
        if (details.url !== GRADING_URL
          || details.parentDocumentId !== provenance.parentDocumentId
          || details.transitionQualifiers.includes(NAVIGATION_QUALIFIER.forwardBack)
          || (operation.documentId && operation.documentId !== details.documentId)) {
          unverify(operation, PROGRESS_TEXT.unexpectedNavigation);
          await save();
        } else {
          operation.documentId = details.documentId;
          await finish(operation);
        }
      }
    }).catch(reportFailure);
  }

  function completed(details: Browser.webRequest.OnCompletedDetails): void {
    void run(async () => {
      const operation = operations.get(details.requestId);
      if (!operation) return;
      if (details.statusCode !== 200 || details.url !== GRADING_URL || details.fromCache) {
        unverify(operation, PROGRESS_TEXT.unsuccessfulResponse);
        await save();
      } else {
        operation.completed = true;
        await finish(operation);
      }
    }).catch(reportFailure);
  }

  function interrupted(details: Browser.webRequest.WebRequestDetails): void {
    void run(async () => {
      const operation = operations.get(details.requestId);
      if (!operation) return;
      unverify(operation, PROGRESS_TEXT.requestInterrupted);
      await save();
    }).catch(reportFailure);
  }

  function message(value: unknown, sender: Browser.runtime.MessageSender): Promise<ProgressReply> {
    return run(async () => {
      await expire();
      if (sender.id === browser.runtime.id
        && sender.url === browser.runtime.getURL(EXTENSION_PAGE.options)
        && progressRequestSchema.safeParse(value).success) {
        return { ok: true, attempts };
      }
      const parsed = resultObservationSchema.safeParse(value);
      if (sender.id !== browser.runtime.id || sender.url !== GRADING_URL
        || !sender.documentId || sender.tab?.id === undefined || !sender.frameId
        || !parsed.success) {
        console.warn(PROGRESS_TEXT.rejectedMessage);
        return { ok: false, error: PROGRESS_TEXT.unsupportedMessage };
      }
      const operation = [...operations.values()].find(item =>
        item.attempt.state === CAPTURE_STATE.pending
        && item.attempt.provenance.tabId === sender.tab?.id
        && item.attempt.provenance.frameId === sender.frameId);
      if (!operation) {
        return { ok: false, error: PROGRESS_TEXT.unobservedSubmission };
      }
      if (operation.result && operation.result.documentId !== sender.documentId) {
        unverify(operation, PROGRESS_TEXT.multipleDocuments);
        await save();
      } else {
        operation.result = { documentId: sender.documentId, observation: parsed.data };
        await finish(operation);
      }
      return { ok: true, attempts: [] };
    });
  }

  function discardAccepted(id: string, persist: (remaining: Attempt[]) => Promise<void>): Promise<void> {
    const result = queue.then(async () => {
      if (failure) throw new Error(failure);
      const remaining = attempts.filter(attempt => attempt.id !== id);
      await persist(remaining);
      attempts = remaining;
    });
    // A rejected discard must not disable later capture.
    queue = result.then(() => undefined, () => undefined);
    return result;
  }

  return { request, committed, completed, interrupted, message, reportFailure, discardAccepted };
}
