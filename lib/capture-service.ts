import { browser, type Browser } from 'wxt/browser';
import {
  GRADING_URL, HDL_ORIGIN, PROGRESS_KEY, RESULT_TIMEOUT_MS,
  attemptListSchema, hashSource, problemIdFieldSchema, progressRequestSchema, readAttempts,
  resultObservationSchema, submittedSourceFieldSchema,
  type Attempt, type ProgressReply, type ResultObservation,
} from './progress';

interface Operation {
  attempt: Attempt;
  completed: boolean;
  documentId: string | null;
  result: { documentId: string; observation: ResultObservation } | null;
}

export function createCaptureService() {
  let attempts: Attempt[] = [];
  const operations = new Map<string, Operation>();
  const quarantinedParents = new Set<string>();
  const observedParents = new Set<string>();
  let failure: string | null = null;

  function reportFailure(error: unknown): void {
    failure = error instanceof Error ? error.message : 'Progress recording failed.';
    console.error('Progress Sync:', failure);
    void browser.action.setBadgeText({ text: '!' }).catch(console.error);
  }

  const ready = browser.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' })
    .then(readAttempts)
    .then(async stored => {
      attempts = stored;
      let changed = false;
      for (const attempt of attempts) {
        if (attempt.state === 'pending') {
          attempt.state = 'unverified';
          attempt.reason = 'Observation was interrupted. Reload the problem and resubmit.';
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
      throw new Error('Local progress could not be saved because the attempt record is invalid.');
    }
    return browser.storage.local.set({ [PROGRESS_KEY]: parsed.data });
  }

  function unverify(operation: Operation, reason: string, ambiguous = true): void {
    if (operation.attempt.state !== 'pending') return;
    operation.attempt.state = 'unverified';
    operation.attempt.reason = reason;
    operation.attempt.requiresReload = ambiguous;
    operation.attempt.observedAt = new Date().toISOString();
    const parent = operation.attempt.provenance.parentDocumentId;
    if (parent && ambiguous) quarantinedParents.add(parent);
  }

  async function expire(): Promise<void> {
    let changed = false;
    for (const operation of operations.values()) {
      if (operation.attempt.state === 'pending'
        && Date.now() - Date.parse(operation.attempt.submittedAt) >= RESULT_TIMEOUT_MS) {
        unverify(operation, 'Result timed out. Reload the problem and resubmit.');
        changed = true;
      }
    }
    if (changed) await save();
  }

  // Request completion can precede navigation commit; neither alone proves which document was graded.
  async function finish(operation: Operation): Promise<void> {
    const { attempt, result, documentId } = operation;
    if (attempt.state !== 'pending' || !operation.completed || !result || !documentId) return;
    await expire();
    if (attempt.state !== 'pending') return;
    const frame = await browser.webNavigation.getFrame({
      tabId: attempt.provenance.tabId, frameId: attempt.provenance.frameId,
    });
    if (result.documentId !== documentId || frame?.documentId !== documentId
      || frame.url !== GRADING_URL || frame.documentLifecycle !== 'active'
      || frame.parentDocumentId !== attempt.provenance.parentDocumentId
      || result.observation.problemId !== attempt.problemId) {
      unverify(operation, 'The result could not be tied to this submission. Reload and resubmit.');
    } else {
      switch (result.observation.verdict) {
        case 'success':
          attempt.state = 'accepted';
          attempt.reason = 'Accepted locally - not saved to GitHub';
          attempt.observedAt = new Date().toISOString();
          attempt.provenance.resultDocumentId = documentId;
          break;
        case 'failure':
          unverify(operation, 'HDLBits did not accept this submission.', false);
          break;
        case 'unknown':
          unverify(operation, 'The grading result is unsupported or ambiguous. Reload and resubmit.', true);
          break;
      }
    }
    await save();
    operations.delete(attempt.provenance.requestId);
  }

  function request(details: Browser.webRequest.OnBeforeRequestDetails): undefined {
    void run(async () => {
      await expire();
      if (details.method !== 'POST') {
        if (details.parentDocumentId) quarantinedParents.add(details.parentDocumentId);
        for (const operation of operations.values()) {
          if (operation.attempt.provenance.tabId === details.tabId
            && operation.attempt.provenance.frameId === details.frameId) {
            unverify(operation, 'A different navigation replaced the submission result.');
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
        schemaVersion: 1, id: crypto.randomUUID(), provider: 'hdlbits',
        problemId, source, sourceHash: source === null ? null : await hashSource(source),
        submittedAt: new Date(details.timeStamp).toISOString(), observedAt: null,
        state: 'pending', reason: 'Waiting for the result - not saved to GitHub',
        requiresReload: false,
        provenance: {
          capture: 'browser-post', requestId: details.requestId,
          tabId: details.tabId, frameId: details.frameId, parentDocumentId,
          resultDocumentId: null,
        },
      };
      const operation: Operation = { attempt, completed: false, documentId: null, result: null };
      const overlapping = [...operations.values()].filter(item => item.attempt.state === 'pending');
      attempts.push(attempt);
      operations.set(details.requestId, operation);
      if (!source || !problemId || !parentDocumentId || details.type !== 'sub_frame'
        || details.parentFrameId !== 0 || details.initiator !== HDL_ORIGIN
        || details.url !== GRADING_URL || details.requestBody?.error || form?.vlgcode) {
        unverify(operation, 'Unsupported submission. Use the in-page text editor; source limit is 256 KiB.');
      } else {
        const parent = await browser.webNavigation.getFrame({ tabId: details.tabId, frameId: 0 });
        if (!parent || parent.documentId !== parentDocumentId
          || parent.documentLifecycle !== 'active'
          || parent.url.split('?')[0]?.split('#')[0]?.toLowerCase()
            !== `${HDL_ORIGIN}/wiki/${problemId}`) {
          unverify(operation, 'The originating problem document could not be verified.');
        } else if (quarantinedParents.has(parentDocumentId)) {
          unverify(operation, 'This page has an ambiguous observation. Reload the problem and resubmit.');
        } else if (!observedParents.has(parentDocumentId)) {
          unverify(operation, 'The problem document predates this observer. Reload the problem and resubmit.');
        }
      }
      if (overlapping.length) {
        for (const item of [...overlapping, operation]) {
          unverify(item, 'Overlapping simulations are not supported yet. Reload the problems and resubmit separately.');
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
        if (details.url.startsWith(`${HDL_ORIGIN}/wiki/`) && details.documentLifecycle === 'active') {
          observedParents.add(details.documentId);
        }
        let changed = false;
        for (const operation of operations.values()) {
          if (operation.attempt.state === 'pending'
            && operation.attempt.provenance.tabId === details.tabId
            && operation.attempt.provenance.parentDocumentId !== details.documentId) {
            unverify(operation, 'The problem navigated before its result was observed.');
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
          || details.transitionQualifiers.includes('forward_back')
          || (operation.documentId && operation.documentId !== details.documentId)) {
          unverify(operation, 'An unexpected result navigation made this attempt unverified.');
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
        unverify(operation, 'The grading request did not return a fresh successful response.');
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
      unverify(operation, 'The grading request failed or redirected. Reload and resubmit.');
      await save();
    }).catch(reportFailure);
  }

  function message(value: unknown, sender: Browser.runtime.MessageSender): Promise<ProgressReply> {
    return run(async () => {
      await expire();
      if (sender.id === browser.runtime.id
        && sender.url === browser.runtime.getURL('/options.html')
        && progressRequestSchema.safeParse(value).success) {
        return { ok: true, attempts };
      }
      const parsed = resultObservationSchema.safeParse(value);
      if (sender.id !== browser.runtime.id || sender.url !== GRADING_URL
        || !sender.documentId || sender.tab?.id === undefined || !sender.frameId
        || !parsed.success) {
        console.warn('Progress Sync rejected an unsupported message or sender.');
        return { ok: false, error: 'Unsupported message or sender.' };
      }
      const operation = [...operations.values()].find(item =>
        item.attempt.state === 'pending'
        && item.attempt.provenance.tabId === sender.tab?.id
        && item.attempt.provenance.frameId === sender.frameId);
      if (!operation) {
        return { ok: false, error: 'No matching observed submission. This result is unverified.' };
      }
      if (operation.result && operation.result.documentId !== sender.documentId) {
        unverify(operation, 'Multiple result documents made this attempt ambiguous.');
        await save();
      } else {
        operation.result = { documentId: sender.documentId, observation: parsed.data };
        await finish(operation);
      }
      return { ok: true, attempts: [] };
    });
  }

  return { request, committed, completed, interrupted, message, reportFailure };
}
