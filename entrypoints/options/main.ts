import { DOM_EVENT, STORAGE_AREA, UI_ROLE } from '../../lib/constants/browser';
import {
  CAPTURE_STATE, GRADING_VERDICT, PROGRESS_KEY, PROGRESS_MESSAGE, PROGRESS_TEXT, VERDICT_LABEL,
} from '../../lib/constants/progress';
import { browser } from 'wxt/browser';
import { progressReplySchema, type Attempt } from '../../lib/progress';
import {
  DELIVERY_KEY, DELIVERY_MESSAGE, DELIVERY_SCHEDULE_KEY, DELIVERY_TEXT, DELIVERY_THROTTLE_KEY,
} from '../../lib/constants/delivery';
import { AUTH_SESSION_KEY } from '../../lib/constants/github';
import { DESTINATION_STORAGE_PREFIX } from '../../lib/constants/destination';
import { LIFECYCLE_TEXT } from '../../lib/constants/lifecycle';
import { capturedJobSnapshot, type DeliveryJob } from '../../lib/delivery/schemas';
import { initializeRecovery } from './recovery';
import { initializeImports } from './import';
import {
  deliveryAction, deliveryView, invalidateDeliveryView, jobStateText, renderJob, type JobContext,
} from './job';
import { renderMetadata, renderReport, renderSource } from './fields';
import { readDiagramImages } from '../../lib/diagram-store';
import { isPendingReport, type DiagramImage } from '../../lib/report';
import './style.css';

const status = document.querySelector<HTMLParagraphElement>('#status');
const attempts = document.querySelector<HTMLElement>('#attempts');
const refresh = document.querySelector<HTMLButtonElement>('#refresh');
if (!status || !attempts || !refresh) throw new Error(PROGRESS_TEXT.interfaceIncomplete);
let loadGeneration = 0;

function renderAttempt(
  attempt: Attempt, context: JobContext, images: DiagramImage[] | null, job?: DeliveryJob,
): HTMLElement {
  const article = document.createElement('article');
  const heading = document.createElement('h2');
  heading.textContent = PROGRESS_TEXT.problemHeading(attempt.problemId);
  const state = document.createElement('p');
  state.className = attempt.state;
  state.textContent = attempt.state === CAPTURE_STATE.unverified ? PROGRESS_TEXT.unverified(attempt.reason) : attempt.reason;
  if (job) state.textContent = jobStateText(job) ?? state.textContent;
  const selection = context.selection;
  const values = {
    [PROGRESS_TEXT.attemptLabel]: attempt.id,
    [PROGRESS_TEXT.outcomeLabel]: attempt.outcome === undefined
      ? VERDICT_LABEL[GRADING_VERDICT.unknown] : VERDICT_LABEL[attempt.outcome],
    [PROGRESS_TEXT.submittedLabel]: attempt.submittedAt,
    [PROGRESS_TEXT.observedLabel]: attempt.observedAt ?? PROGRESS_TEXT.notYet,
    [PROGRESS_TEXT.hashLabel]: attempt.sourceHash ?? PROGRESS_TEXT.unavailable,
    [PROGRESS_TEXT.captureLabel]: PROGRESS_TEXT.captureDescription,
  };
  article.append(heading, state, renderMetadata(values));
  if (job) article.append(...renderJob(job, state, context));
  if (attempt.source !== null) {
    article.append(renderSource(LIFECYCLE_TEXT.submittedSource, attempt.source));
  }
  if (attempt.report) {
    article.append(renderReport(attempt.report, { problemId: attempt.problemId, images }));
  }
  const failed = attempt.state === CAPTURE_STATE.failed;
  // Only a report whose artifact phase has concluded can be published, so an attempt still being observed
  // offers no publication control instead of an action that would be refused.
  if ((attempt.state === CAPTURE_STATE.accepted || failed) && !job && !isPendingReport(attempt.report)) {
    if (selection) {
      const publish = document.createElement('button');
      publish.type = 'button';
      publish.textContent = failed
        ? DELIVERY_TEXT.selectFailed(selection.owner, selection.name, selection.branch)
        : DELIVERY_TEXT.select(selection.owner, selection.name, selection.branch);
      publish.addEventListener(DOM_EVENT.click, async () => {
        // A failed attempt is published one record at a time, each confirmed on its own.
        if (failed && !window.confirm(DELIVERY_TEXT.failedConfirmation(
          PROGRESS_TEXT.problemHeading(attempt.problemId),
          attempt.outcome === undefined ? VERDICT_LABEL[GRADING_VERDICT.unknown] : VERDICT_LABEL[attempt.outcome],
        ))) return;
        await deliveryAction(publish, state, failed
          ? {
            type: DELIVERY_MESSAGE.publishFailed, attemptId: attempt.id,
            expectedConnectionId: selection.connectionId, expectedSelectionId: selection.operationId,
            publicConfirmed: true, failedConfirmed: true,
          }
          : {
            type: DELIVERY_MESSAGE.publish, attemptId: attempt.id, expectedConnectionId: selection.connectionId,
            expectedSelectionId: selection.operationId, publicConfirmed: true,
          }, context);
      });
      article.append(publish);
    } else {
      const guidance = document.createElement('p');
      guidance.textContent = DELIVERY_TEXT.noDestination;
      article.append(guidance);
    }
  }
  return article;
}

async function load(): Promise<void> {
  const generation = ++loadGeneration;
  if (!status || !attempts) throw new Error(PROGRESS_TEXT.interfaceIncomplete);
  attempts.querySelectorAll('button').forEach(button => { button.disabled = true; });
  try {
    const parsed = progressReplySchema.safeParse(
      await browser.runtime.sendMessage({ type: PROGRESS_MESSAGE.list }),
    );
    if (!parsed.success) throw new Error(PROGRESS_TEXT.readFailed);
    const reply = parsed.data;
    if (!reply.ok) throw new Error(reply.error);
    const delivery = await deliveryView();
    if (generation !== loadGeneration) return;
    // Imported records have their own section; only capture jobs belong to the attempt history.
    const jobs = new Map<string, DeliveryJob>();
    const snapshots = new Map<string, Attempt>(reply.attempts.map(attempt => [attempt.id, attempt]));
    for (const job of delivery.jobs) {
      const snapshot = capturedJobSnapshot(job);
      if (!snapshot) continue;
      jobs.set(job.id, job);
      snapshots.set(job.id, snapshot);
    }
    const ordered = [...snapshots.values()].sort((left, right) => right.submittedAt.localeCompare(left.submittedAt));
    const unscheduled = delivery.scheduling;
    const context: JobContext = {
      selection: delivery.selection, scheduled: unscheduled === null,
      current: () => generation === loadGeneration, reload: load,
    };
    // Image bytes are held per attempt outside the attempt list, so they are read only for the reports that
    // name one.
    const images = new Map<string, DiagramImage[] | null>();
    for (const attempt of ordered) {
      if ((attempt.report?.diagrams ?? []).length === 0) continue;
      images.set(attempt.id, await readDiagramImages(attempt.id));
    }
    if (generation !== loadGeneration) return;
    attempts.replaceChildren(...ordered.map(attempt =>
      renderAttempt(attempt, context, images.get(attempt.id) ?? null, jobs.get(attempt.id))));
    if (unscheduled) {
      const failure = document.createElement('p');
      failure.textContent = unscheduled.detail;
      failure.setAttribute('role', UI_ROLE.alert);
      attempts.prepend(failure);
    }
    status.textContent = snapshots.size === 0
      ? PROGRESS_TEXT.empty
      : PROGRESS_TEXT.attemptCount(snapshots.size);
    status.setAttribute('role', UI_ROLE.status);
  } catch (error) {
    if (generation !== loadGeneration) return;
    status.textContent = error instanceof Error ? error.message : PROGRESS_TEXT.readFailed;
    status.setAttribute('role', UI_ROLE.alert);
  }
}

// An explicit refresh asks for current state, so the shared delivery read is taken again rather than reused.
refresh.addEventListener(DOM_EVENT.click, () => {
  invalidateDeliveryView();
  void load();
});
browser.storage.onChanged.addListener((changes, area) => {
  if ((area === STORAGE_AREA.local && (PROGRESS_KEY in changes || DELIVERY_KEY in changes
    || DELIVERY_SCHEDULE_KEY in changes || DELIVERY_THROTTLE_KEY in changes
    || Object.keys(changes).some(key => key.startsWith(DESTINATION_STORAGE_PREFIX))))
    || (area === STORAGE_AREA.session && AUTH_SESSION_KEY in changes)) void load();
});
void load();
initializeImports();
initializeRecovery();
