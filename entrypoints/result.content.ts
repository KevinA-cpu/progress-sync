import {
  GRADING_URL, GRADING_VERDICT, HDL_STATUS_HEADING, PROGRESS_MESSAGE, PROGRESS_TEXT, type GradingVerdict,
} from '../lib/constants/progress';
import {
  ARTIFACT_CAPTURE_BUDGET_MS, ARTIFACT_DEADLINE_MS, ARTIFACT_MINIMUM_MS, ARTIFACT_SETTLE_MS, ARTIFACT_STATE,
  DIAGRAM_REJECTION, MAX_REPORT_STATUS, RESULT_SELECTOR, type ArtifactState,
} from '../lib/constants/report';
import { CONTENT_SCRIPT_RUN_AT, DOCUMENT_READY } from '../lib/constants/browser';
import { browser } from 'wxt/browser';
import { defineContentScript } from 'wxt/utils/define-content-script';
import { capturedReportSchema, sanitizeReportText, type CapturedReport } from '../lib/report';
import { captureDiagrams, collectDiagrams, collectMessages } from '../lib/diagram-capture';
import { progressReplySchema, type ArtifactObservation, type ResultObservation } from '../lib/progress';

const POLL_MS = 250;

function statedVerdict(heading: string | undefined): GradingVerdict {
  const stated: Record<string, GradingVerdict> = HDL_STATUS_HEADING;
  return (heading === undefined ? undefined : stated[heading]) ?? GRADING_VERDICT.unknown;
}

// The verdict report states the status line this result contract defines and nothing else yet: its diagrams and
// messages are still being observed, and the report says so.
function statedReport(heading: string | undefined): CapturedReport | null {
  const status = sanitizeReportText(heading, MAX_REPORT_STATUS);
  if (status === null) return null;
  const parsed = capturedReportSchema.safeParse({
    schemaVersion: 1, status, messages: [],
    coverage: {
      statusLine: true, diagnosticMessages: false, timingDiagram: false, artifacts: ARTIFACT_STATE.pending,
    },
  });
  return parsed.success ? parsed.data : null;
}

function send(observation: ResultObservation | ArtifactObservation, undelivered: string): void {
  void browser.runtime.sendMessage(observation).then((reply: unknown) => {
    const parsed = progressReplySchema.safeParse(reply);
    if (!parsed.success || !parsed.data.ok) console.warn(PROGRESS_TEXT.resultUnrecorded);
  }, () => {
    console.error(undelivered);
  });
}

function touchesArtifacts(node: Node): boolean {
  const element = node instanceof Element ? node : node.parentElement;
  if (!element) return false;
  const selector = `${RESULT_SELECTOR.diagram}, ${RESULT_SELECTOR.diagramContainer}, ${RESULT_SELECTOR.messages}`;
  return element.closest(selector) !== null || element.querySelector(selector) !== null;
}

function relevant(records: MutationRecord[]): boolean {
  return records.some(record => touchesArtifacts(record.target)
    || [...record.addedNodes, ...record.removedNodes].some(touchesArtifacts));
}

// Diagrams and late messages are observed independently of the verdict: the result is watched until it stops
// changing, and every relevant change restarts that window. All bounds are fixed, so nothing waits forever.
function observeArtifacts(problemId: string): void {
  const started = Date.now();
  let lastChange = started;
  let finished = false;
  const observer = new MutationObserver(records => {
    if (relevant(records)) lastChange = Date.now();
  });
  observer.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });

  async function finalize(timedOut: boolean): Promise<void> {
    observer.disconnect();
    clearInterval(poll);
    const elements = collectDiagrams(document);
    const stated = collectMessages(document);
    const captured = timedOut
      ? { diagrams: [], images: [], rejected: elements.length > 0 ? [DIAGRAM_REJECTION.deadline] : [] }
      : await captureDiagrams(elements, Date.now() + ARTIFACT_CAPTURE_BUDGET_MS);
    let state: ArtifactState = ARTIFACT_STATE.none;
    if (captured.diagrams.length > 0) {
      state = captured.rejected.length > 0 ? ARTIFACT_STATE.partial : ARTIFACT_STATE.complete;
    } else if (captured.rejected.length > 0) {
      state = timedOut ? ARTIFACT_STATE.deadline : ARTIFACT_STATE.rejected;
    } else if (timedOut && elements.length === 0) {
      state = ARTIFACT_STATE.deadline;
    }
    send({
      type: PROGRESS_MESSAGE.artifacts, problemId, state,
      messages: stated.messages, partialMessages: stated.partial,
      diagrams: captured.diagrams, images: captured.images, rejected: captured.rejected,
    }, PROGRESS_TEXT.artifactsUndelivered);
  }

  function settle(timedOut: boolean): void {
    if (finished) return;
    finished = true;
    void finalize(timedOut);
  }

  const poll = setInterval(() => {
    const now = Date.now();
    if (now - started >= ARTIFACT_DEADLINE_MS) {
      settle(true);
      return;
    }
    // The only completion this provider actually states is that the result document finished loading; an
    // existing container states nothing, because the message box is there from the first paint even when it is
    // empty. So the phase waits out the minimum window as well, and any relevant change inside it restarts the
    // settle window. A chart or a warning that arrives late is captured; a short quiet gap is not taken for the
    // end of the result.
    const loaded = document.readyState === DOCUMENT_READY.complete;
    if (loaded && now - started >= ARTIFACT_MINIMUM_MS && now - lastChange >= ARTIFACT_SETTLE_MS) settle(false);
  }, POLL_MS);
}

export default defineContentScript({
  matches: [GRADING_URL],
  allFrames: true,
  runAt: CONTENT_SCRIPT_RUN_AT,
  main() {
    const headings = [...document.querySelectorAll('h2')].map(node => node.textContent?.trim());
    const problemId = headings[0]?.match(/^([a-z0-9][a-z0-9_]{0,127}) — Compile and simulate$/)?.[1] ?? null;
    const knownLayout = headings.length === 2 && problemId !== null
      && document.title === PROGRESS_TEXT.resultTitle(problemId);
    const verdict = knownLayout ? statedVerdict(headings[1]) : GRADING_VERDICT.unknown;
    const report = verdict === GRADING_VERDICT.unknown ? null : statedReport(headings[1]);
    send({ type: PROGRESS_MESSAGE.result, problemId, verdict, report }, PROGRESS_TEXT.resultUndelivered);
    if (report && problemId !== null) observeArtifacts(problemId);
  },
});
