import { DOM_EVENT, STORAGE_AREA, UI_ROLE } from '../../lib/constants/browser';
import { CAPTURE_STATE, PROGRESS_KEY, PROGRESS_MESSAGE, PROGRESS_TEXT } from '../../lib/constants/progress';
import { browser } from 'wxt/browser';
import { progressReplySchema, type Attempt } from '../../lib/progress';
import {
  DELIVERY_KEY, DELIVERY_MESSAGE, DELIVERY_SCHEDULE_KEY, DELIVERY_TEXT, DELIVERY_THROTTLE_KEY,
} from '../../lib/constants/delivery';
import { AUTH_SESSION_KEY } from '../../lib/constants/github';
import { DESTINATION_STORAGE_PREFIX } from '../../lib/constants/destination';
import { LIFECYCLE_TEXT } from '../../lib/constants/lifecycle';
import { acceptedJobSnapshot, type DeliveryJob } from '../../lib/delivery/schemas';
import { initializeRecovery } from './recovery';
import { initializeImports } from './import';
import {
  deliveryAction, deliveryView, invalidateDeliveryView, jobStateText, renderJob, type JobContext,
} from './job';
import { renderMetadata, renderSource } from './fields';
import './style.css';

const status = document.querySelector<HTMLParagraphElement>('#status');
const attempts = document.querySelector<HTMLElement>('#attempts');
const refresh = document.querySelector<HTMLButtonElement>('#refresh');
if (!status || !attempts || !refresh) throw new Error(PROGRESS_TEXT.interfaceIncomplete);
let loadGeneration = 0;

function renderAttempt(attempt: Attempt, context: JobContext, job?: DeliveryJob): HTMLElement {
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
  if (attempt.state === CAPTURE_STATE.accepted && !job) {
    if (selection) {
      const publish = document.createElement('button');
      publish.textContent = DELIVERY_TEXT.select(selection.owner, selection.name, selection.branch);
      publish.addEventListener(DOM_EVENT.click, async () => {
        await deliveryAction(publish, state, {
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
      const snapshot = acceptedJobSnapshot(job);
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
    attempts.replaceChildren(...ordered.map(attempt => renderAttempt(attempt, context, jobs.get(attempt.id))));
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
