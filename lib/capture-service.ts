import {
  DOCUMENT_LIFECYCLE, EXTENSION_PAGE, HTTP_METHOD, LOG_PREFIX, NAVIGATION_QUALIFIER, RESOURCE_TYPE,
  STORAGE_ACCESS,
} from './constants/browser';
import {
  CAPTURE_PROVENANCE, CAPTURE_STATE, GRADING_URL, GRADING_VERDICT, HDL_ORIGIN, HDL_PROBLEM_PREFIX,
  isFailedVerdict, PROGRESS_KEY, PROGRESS_PROVIDER, PROGRESS_TEXT, RESULT_TIMEOUT_MS, VERDICT_LABEL,
} from './constants/progress';
import {
  ARTIFACT_HOLD_MS, ARTIFACT_STATE, DIAGRAM_NAME, DIAGRAM_REJECTION, MAX_REPORT_BYTES, REPORT_PROVIDER_NAME,
  REPORT_TEXT, type ArtifactState, type DiagramRejection,
} from './constants/report';
import { browser, type Browser } from 'wxt/browser';
import {
  artifactObservationSchema, attemptListSchema, hashSource, problemIdFieldSchema, progressRequestSchema,
  readAttempts, resultObservationSchema, sourceByteLength, submittedSourceFieldSchema,
  type ArtifactObservation, type Attempt, type ProgressReply, type ResultObservation,
} from './progress';
import {
  capturedReportSchema, isPendingReport, type CapturedReport, type Diagram, type DiagramImage,
} from './report';
import { dropDiagramImages, saveDiagramImages } from './diagram-store';
import { decodeBase64, hashBytes, problemUrl, readPng } from './diagram';
import { reportRecordContent } from './delivery/schemas';

interface Operation {
  attempt: Attempt;
  completed: boolean;
  documentId: string | null;
  result: { documentId: string; observation: ResultObservation } | null;
}

// The report is published with the attempt, so it is trimmed against the exact file it will be published as,
// measured in bytes rather than in characters: a result that states its diagnostics in a non-ASCII language is
// bounded by the same limit as any other, and nothing that fits is dropped. What was dropped is stated in the
// report itself.
function fitMessages(
  messages: CapturedReport['messages'], published: (messages: CapturedReport['messages']) => number,
): { messages: CapturedReport['messages']; trimmed: boolean } {
  let kept = messages;
  let trimmed = false;
  while (kept.length > 0 && published(kept) > MAX_REPORT_BYTES) {
    kept = kept.slice(0, -1);
    trimmed = true;
  }
  return { messages: kept, trimmed };
}

// A stored image and the metadata describing it have to agree before either is accepted: the exact bytes, a
// header a decoder will actually draw, the stated dimensions, and the stated hash. A chart that fails here is
// reported as not stored rather than as one the result never drew.
async function verifyDiagrams(diagrams: Diagram[], images: DiagramImage[]): Promise<{
  diagrams: Diagram[]; images: DiagramImage[]; invalid: number;
}> {
  const kept: { diagram: Diagram; image: DiagramImage }[] = [];
  let invalid = 0;
  for (const [index, diagram] of diagrams.entries()) {
    const image = images[index];
    const bytes = image === undefined ? null : decodeBase64(image.data);
    const header = bytes === null ? null : readPng(bytes);
    if (image === undefined || bytes === null || header === null || bytes.length !== diagram.byteLength
      || header.width !== diagram.width || header.height !== diagram.height
      || await hashBytes(bytes) !== diagram.hash) {
      invalid++;
      continue;
    }
    kept.push({ diagram, image });
  }
  // Names are positional, so what survives is renumbered instead of leaving a gap that would read as a
  // published file that is missing.
  return {
    diagrams: kept.map(({ diagram }, index) => ({ ...diagram, name: DIAGRAM_NAME(index + 1) })),
    images: kept.map(({ image }, index) => ({ ...image, name: DIAGRAM_NAME(index + 1) })),
    invalid,
  };
}

function resultKey(tabId: number | undefined, frameId: number, documentId: string): string {
  return `${tabId}\0${frameId}\0${documentId}`;
}

export function createCaptureService(onRecorded: (attemptId: string) => Promise<string | null>) {
  let attempts: Attempt[] = [];
  const operations = new Map<string, Operation>();
  const quarantinedParents = new Set<string>();
  const observedParents = new Set<string>();
  // Discarding an attempt must not forget which result documents already resolved.
  const resolvedResults = new Set<string>();
  // A recorded outcome whose result document is still drawing its diagrams. The outcome is already saved; only
  // the handover to delivery waits, and only until this hold expires.
  const holds = new Map<string, { attemptId: string; timer: ReturnType<typeof setTimeout> }>();
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
      // An artifact phase cannot survive the document that was drawing. What was recorded stays recorded, its
      // report states that its diagrams were not captured, and the outcome is handed to delivery now.
      const abandoned: string[] = [];
      for (const attempt of attempts) {
        if (isPendingReport(attempt.report)) {
          attempt.report = concluded(attempt.report, ARTIFACT_STATE.deadline);
          abandoned.push(attempt.id);
          changed = true;
        }
        if (attempt.state === CAPTURE_STATE.pending) {
          attempt.state = CAPTURE_STATE.unverified;
          attempt.reason = PROGRESS_TEXT.interrupted;
          attempt.requiresReload = true;
          changed = true;
        }
        if (attempt.requiresReload && attempt.provenance.parentDocumentId) {
          quarantinedParents.add(attempt.provenance.parentDocumentId);
        }
        if (attempt.provenance.resultDocumentId) {
          resolvedResults.add(resultKey(
            attempt.provenance.tabId, attempt.provenance.frameId, attempt.provenance.resultDocumentId,
          ));
        }
      }
      if (changed) await save();
      for (const id of abandoned) await release(id);
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

  // Ends the artifact phase of a report that has none to add: the status line it already stated, with the
  // conclusion the phase reached.
  function concluded(report: CapturedReport | undefined, state: ArtifactState): CapturedReport | undefined {
    if (!report) return report;
    return { ...report, coverage: { ...report.coverage, artifacts: state } };
  }

  // Delivery is offered a recorded outcome exactly once, and only after its report is final.
  async function release(attemptId: string): Promise<void> {
    const attempt = attempts.find(item => item.id === attemptId);
    if (!attempt || (attempt.state !== CAPTURE_STATE.accepted && attempt.state !== CAPTURE_STATE.failed)) return;
    const deliveryIssue = await onRecorded(attempt.id);
    if (deliveryIssue) {
      attempt.reason = deliveryIssue;
      await save();
    }
  }

  function hold(attempt: Attempt, key: string): void {
    holds.set(key, {
      attemptId: attempt.id,
      timer: setTimeout(() => {
        void run(() => concludeHold(key, ARTIFACT_STATE.deadline)).catch(reportFailure);
      }, ARTIFACT_HOLD_MS),
    });
  }

  async function concludeHold(key: string, state: ArtifactState): Promise<void> {
    const held = holds.get(key);
    if (!held) return;
    holds.delete(key);
    clearTimeout(held.timer);
    const attempt = attempts.find(item => item.id === held.attemptId);
    if (attempt && isPendingReport(attempt.report)) {
      attempt.report = concluded(attempt.report, state);
      await save();
    }
    await release(held.attemptId);
  }

  // The second half of one observation. It adds what the same result document drew and stated, and can only
  // conclude the artifact phase: the status line, the outcome, and the correlated evidence are already fixed.
  async function finalizeArtifacts(key: string, observation: ArtifactObservation): Promise<boolean> {
    const held = holds.get(key);
    const attempt = held ? attempts.find(item => item.id === held.attemptId) : undefined;
    if (!held || !attempt || !attempt.report || !isPendingReport(attempt.report)
      || attempt.problemId !== observation.problemId) return false;
    const stating = attempt.report;
    holds.delete(key);
    clearTimeout(held.timer);
    // The images are checked against what the observation says they are before anything is stored, so a
    // malformed or mismatched chart is refused here rather than being published or shown as a broken picture.
    const verified = await verifyDiagrams(observation.diagrams, observation.images);
    let diagrams: Diagram[] = verified.diagrams;
    let rejected: DiagramRejection[] = [
      ...observation.rejected, ...Array.from({ length: verified.invalid }, () => DIAGRAM_REJECTION.invalid),
    ];
    const link = problemUrl(attempt.problemId);
    if (diagrams.length > 0 && (link === null || !await saveDiagramImages(attempt.id, verified.images))) {
      diagrams = [];
      rejected = [...rejected, DIAGRAM_REJECTION.limit];
      await dropDiagramImages(attempt.id);
    }
    // The stated conclusion is recomputed from what was actually kept, so a report never overstates itself.
    const state = diagrams.length > 0
      ? (rejected.length > 0 ? ARTIFACT_STATE.partial : ARTIFACT_STATE.complete)
      : (observation.state === ARTIFACT_STATE.deadline
        ? ARTIFACT_STATE.deadline
        : (rejected.length > 0 ? ARTIFACT_STATE.rejected : ARTIFACT_STATE.none));
    const fields = (messages: CapturedReport['messages'], trimmed: boolean) => ({
      schemaVersion: 1 as const, status: stating.status, messages,
      ...diagrams.length > 0 && link !== null
        ? {
          diagrams,
          attribution: {
            provider: REPORT_PROVIDER_NAME, problemUrl: link, notice: REPORT_TEXT.attributionNotice,
          } as const,
        }
        : {},
      coverage: {
        statusLine: true as const, diagnosticMessages: messages.length > 0,
        ...observation.partialMessages || trimmed ? { partialMessages: true } : {},
        ...trimmed ? { trimmedMessages: true } : {},
        timingDiagram: diagrams.length > 0, artifacts: state,
        ...rejected.length > 0 ? { rejected } : {},
      },
    });
    // Measured as the report.json this attempt would publish, envelope included. A report that cannot be
    // serialized at all is left to the consistency check below.
    const published = (messages: CapturedReport['messages']): number => {
      try {
        return sourceByteLength(reportRecordContent({
          provider: attempt.provider, problemId: observation.problemId, attemptId: attempt.id,
          outcome: attempt.outcome ?? GRADING_VERDICT.success,
          observedAt: attempt.observedAt ?? new Date().toISOString(),
          capture: attempt.provenance.capture, report: fields(messages, true),
        }));
      } catch {
        return Number.POSITIVE_INFINITY;
      }
    };
    const stated = fitMessages(observation.messages, published);
    const parsed = capturedReportSchema.safeParse(fields(stated.messages, stated.trimmed));
    if (parsed.success) {
      attempt.report = parsed.data;
    } else {
      // Nothing observed here can weaken what was already recorded: the stated status survives, and the report
      // says its diagrams were not stored rather than claiming there were none.
      await dropDiagramImages(attempt.id);
      attempt.report = observation.diagrams.length > 0
        ? {
          ...stating,
          coverage: {
            ...stating.coverage, artifacts: ARTIFACT_STATE.rejected, rejected: [DIAGRAM_REJECTION.invalid],
          },
        }
        : concluded(stating, ARTIFACT_STATE.none);
    }
    await save();
    await release(attempt.id);
    return true;
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
      attempt.provenance.resultDocumentId = documentId;
      resolvedResults.add(resultKey(attempt.provenance.tabId, attempt.provenance.frameId, documentId));
      const { verdict, report } = result.observation;
      // A stated outcome is recorded with the report observed alongside it; anything else stays unverified
      // rather than becoming an invented pass or failure.
      if (verdict === GRADING_VERDICT.success) {
        attempt.state = CAPTURE_STATE.accepted;
        attempt.reason = PROGRESS_TEXT.accepted;
        attempt.observedAt = new Date().toISOString();
        attempt.outcome = verdict;
        if (report) attempt.report = report;
      } else if (isFailedVerdict(verdict) && report && attempt.problemId !== null && attempt.source !== null
        && attempt.sourceHash !== null && attempt.provenance.parentDocumentId !== null && !attempt.requiresReload) {
        attempt.state = CAPTURE_STATE.failed;
        attempt.reason = PROGRESS_TEXT.failedLocally(VERDICT_LABEL[verdict]);
        attempt.observedAt = new Date().toISOString();
        attempt.outcome = verdict;
        attempt.report = report;
      } else if (isFailedVerdict(verdict)) {
        unverify(operation, PROGRESS_TEXT.failed, false);
      } else {
        unverify(operation, PROGRESS_TEXT.ambiguousResult, true);
      }
    }
    await save();
    operations.delete(attempt.provenance.requestId);
    if (attempt.state !== CAPTURE_STATE.accepted && attempt.state !== CAPTURE_STATE.failed) return;
    // Nothing is published until the report is final, so one immutable report and its images are delivered
    // with the attempt. The recorded outcome itself is already durable either way.
    if (isPendingReport(attempt.report) && documentId) {
      hold(attempt, resultKey(attempt.provenance.tabId, attempt.provenance.frameId, documentId));
    } else {
      await release(attempt.id);
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
      // Navigation commits have no request ID: only a shared result frame is ambiguous.
      const overlapping = [...operations.values()].filter(item =>
        item.attempt.state === CAPTURE_STATE.pending
        && item.attempt.provenance.tabId === details.tabId
        && item.attempt.provenance.frameId === details.frameId);
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
        && sender.frameId === 0 && sender.documentId && sender.tab?.id !== undefined
        && progressRequestSchema.safeParse(value).success) {
        return { ok: true, attempts };
      }
      const parsed = resultObservationSchema.safeParse(value);
      const artifacts = artifactObservationSchema.safeParse(value);
      if (sender.id !== browser.runtime.id || sender.url !== GRADING_URL
        || !sender.documentId || sender.tab?.id === undefined || !sender.frameId
        || sender.documentLifecycle !== DOCUMENT_LIFECYCLE.active
        || !(parsed.success || artifacts.success)) {
        console.warn(PROGRESS_TEXT.rejectedMessage);
        return { ok: false, error: PROGRESS_TEXT.unsupportedMessage };
      }
      // The artifact phase reports on a document whose outcome is already resolved, and only on the one this
      // service is still holding for.
      if (artifacts.success) {
        const key = resultKey(sender.tab.id, sender.frameId, sender.documentId);
        return await finalizeArtifacts(key, artifacts.data)
          ? { ok: true, attempts: [] }
          : { ok: false, error: PROGRESS_TEXT.unobservedSubmission };
      }
      if (!parsed.success) return { ok: false, error: PROGRESS_TEXT.unsupportedMessage };
      // A finished document can report again while its frame awaits a newer result.
      if (resolvedResults.has(resultKey(sender.tab?.id, sender.frameId, sender.documentId))) {
        return { ok: false, error: PROGRESS_TEXT.unobservedSubmission };
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

  function discardRecorded(id: string, persist: (remaining: Attempt[]) => Promise<void>): Promise<void> {
    const result = queue.then(async () => {
      if (failure) throw new Error(failure);
      const remaining = attempts.filter(attempt => attempt.id !== id);
      await persist(remaining);
      attempts = remaining;
      // Images live under their own key, so a discarded attempt drops exactly its own and nothing else.
      await dropDiagramImages(id);
    });
    // A rejected discard must not disable later capture.
    queue = result.then(() => undefined, () => undefined);
    return result;
  }

  return { request, committed, completed, interrupted, message, reportFailure, discardRecorded };
}
