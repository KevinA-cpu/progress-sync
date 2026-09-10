import { DOM_EVENT, STORAGE_AREA, UI_ROLE } from '../../lib/constants/browser';
import { CAPTURE_STATE, PROGRESS_KEY, PROGRESS_MESSAGE, PROGRESS_TEXT } from '../../lib/constants/progress';
import { browser } from 'wxt/browser';
import { progressReplySchema, type Attempt } from '../../lib/progress';
import {
  DELIVERY_FAILURE, DELIVERY_KEY, DELIVERY_MESSAGE, DELIVERY_RETRY, DELIVERY_SCHEDULE_KEY, DELIVERY_STATE,
  DELIVERY_TEXT, DELIVERY_THROTTLE_KEY, deliveryCommitUrl,
} from '../../lib/constants/delivery';
import { retryExhausted } from '../../lib/delivery/retry';
import { AUTH_SESSION_KEY } from '../../lib/constants/github';
import { DESTINATION_STORAGE_PREFIX } from '../../lib/constants/destination';
import { LIFECYCLE_TEXT } from '../../lib/constants/lifecycle';
import {
  deliveryReplySchema, type DeliveryJob, type DiscardRequest, type PublishRequest, type RetryRequest,
} from '../../lib/delivery/schemas';
import { sameDestination, type DestinationTarget } from '../../lib/destination/schemas';
import { initializeRecovery } from './recovery';
import { renderMetadata, renderSource } from './fields';
import './style.css';

const status = document.querySelector<HTMLParagraphElement>('#status');
const attempts = document.querySelector<HTMLElement>('#attempts');
const refresh = document.querySelector<HTMLButtonElement>('#refresh');
if (!status || !attempts || !refresh) throw new Error(PROGRESS_TEXT.interfaceIncomplete);
let loadGeneration = 0;

async function deliveryAction(
  button: HTMLButtonElement, state: HTMLElement, request: PublishRequest | RetryRequest | DiscardRequest,
  generation: number,
): Promise<void> {
  if (generation !== loadGeneration || !button.isConnected || button.disabled) return;
  const controls = [...button.parentElement?.querySelectorAll('button') ?? []].filter(control => !control.disabled);
  controls.forEach(control => { control.disabled = true; });
  try {
    const reply = deliveryReplySchema.parse(await browser.runtime.sendMessage(request));
    if (generation !== loadGeneration || !button.isConnected) return;
    if (!reply.ok) throw new Error(reply.error);
    await load();
  } catch (error) {
    if (generation !== loadGeneration || !button.isConnected) return;
    state.textContent = error instanceof Error ? error.message : DELIVERY_TEXT.operationFailed;
    state.setAttribute('role', UI_ROLE.alert);
    controls.forEach(control => { control.disabled = false; });
  }
}

function renderAttempt(
  attempt: Attempt, selection: DestinationTarget | null, generation: number, scheduled: boolean, job?: DeliveryJob,
): HTMLElement {
  const article = document.createElement('article');
  const heading = document.createElement('h2');
  heading.textContent = PROGRESS_TEXT.problemHeading(attempt.problemId);
  const state = document.createElement('p');
  state.className = attempt.state;
  state.textContent = attempt.state === CAPTURE_STATE.unverified ? PROGRESS_TEXT.unverified(attempt.reason) : attempt.reason;
  if (job) {
    switch (job.state) {
      case DELIVERY_STATE.pending:
      case DELIVERY_STATE.publishing:
        state.textContent = DELIVERY_TEXT.awaiting;
        break;
      case DELIVERY_STATE.saved:
        state.textContent = DELIVERY_TEXT.saved;
        break;
      case DELIVERY_STATE.reconciling:
        state.textContent = DELIVERY_TEXT.reconciling;
        break;
      case DELIVERY_STATE.blocked:
        state.textContent = DELIVERY_TEXT.blocked(job.detail ?? DELIVERY_TEXT.operationFailed);
        break;
      case DELIVERY_STATE.uncertain:
        state.textContent = job.detail;
        break;
    }
  }
  const values = {
    [PROGRESS_TEXT.attemptLabel]: attempt.id,
    [PROGRESS_TEXT.submittedLabel]: attempt.submittedAt,
    [PROGRESS_TEXT.observedLabel]: attempt.observedAt ?? PROGRESS_TEXT.notYet,
    [PROGRESS_TEXT.hashLabel]: attempt.sourceHash ?? PROGRESS_TEXT.unavailable,
    [PROGRESS_TEXT.captureLabel]: PROGRESS_TEXT.captureDescription,
  };
  article.append(heading, state, renderMetadata(values));
  if (job) {
    const account = document.createElement('p');
    account.textContent = LIFECYCLE_TEXT.originalAccount(job.target.owner, job.target.userId);
    const destination = document.createElement('p');
    destination.textContent = DELIVERY_TEXT.target(job.target.owner, job.target.name, job.target.branch);
    article.append(account, destination, renderMetadata({
      [LIFECYCLE_TEXT.appLabel]: String(job.target.appId),
      [LIFECYCLE_TEXT.clientLabel]: job.target.clientId,
      [LIFECYCLE_TEXT.installationLabel]: String(job.target.installationId),
      [LIFECYCLE_TEXT.repositoryLabel]: String(job.target.repositoryId),
    }));
    if (job.receipt) {
      const receipt = document.createElement('a');
      receipt.textContent = DELIVERY_TEXT.commit(job.receipt.commitSha);
      receipt.href = deliveryCommitUrl(job.target.owner, job.target.name, job.receipt.commitSha);
      receipt.target = '_blank';
      receipt.rel = 'noopener noreferrer';
      article.append(receipt);
    }
    if (job.state !== DELIVERY_STATE.saved) {
      const operationActive = job.state === DELIVERY_STATE.publishing || job.state === DELIVERY_STATE.reconciling;
      const compatible = selection !== null && sameDestination(selection, job.target);
      const retrySchedule = job.retry ?? null;
      if (retrySchedule?.nextAttemptAt) {
        const queued = document.createElement('p');
        const attempt = retrySchedule.attempts + 1;
        queued.textContent = !scheduled
          ? DELIVERY_TEXT.retryUnscheduled(attempt, DELIVERY_RETRY.maxAttempts, retrySchedule.nextAttemptAt)
          : retrySchedule.failure === DELIVERY_FAILURE.rateLimited
            ? DELIVERY_TEXT.retryThrottled(attempt, DELIVERY_RETRY.maxAttempts, retrySchedule.nextAttemptAt)
            : DELIVERY_TEXT.retryScheduled(attempt, DELIVERY_RETRY.maxAttempts, retrySchedule.nextAttemptAt);
        if (!scheduled) queued.setAttribute('role', UI_ROLE.alert);
        article.append(queued);
      } else if (retryExhausted(retrySchedule)) {
        const exhausted = document.createElement('p');
        exhausted.textContent = DELIVERY_TEXT.retryExhausted;
        article.append(exhausted);
      }
      if (!compatible) {
        const guidance = document.createElement('p');
        guidance.textContent = selection ? LIFECYCLE_TEXT.destinationChanged : LIFECYCLE_TEXT.reconnect;
        article.append(guidance);
      }
      if (operationActive) {
        const guidance = document.createElement('p');
        guidance.textContent = LIFECYCLE_TEXT.operationActive;
        article.append(guidance);
      }
      const retry = document.createElement('button');
      retry.type = 'button';
      retry.textContent = DELIVERY_TEXT.retry;
      retry.disabled = !compatible || operationActive;
      retry.addEventListener(DOM_EVENT.click, async () => {
        if (!selection || !compatible || operationActive) return;
        await deliveryAction(retry, state, {
          type: DELIVERY_MESSAGE.retry, jobId: job.id,
          expectedConnectionId: selection.connectionId, expectedSelectionId: selection.operationId,
        }, generation);
      });
      const discard = document.createElement('button');
      discard.type = 'button';
      discard.textContent = LIFECYCLE_TEXT.discard;
      discard.disabled = operationActive;
      discard.addEventListener(DOM_EVENT.click, async () => {
        if (generation !== loadGeneration || !discard.isConnected || discard.disabled) return;
        if (!window.confirm(LIFECYCLE_TEXT.discardConfirmation(job.id))) return;
        await deliveryAction(discard, state, {
          type: DELIVERY_MESSAGE.discard, jobId: job.id, localConfirmed: true,
        }, generation);
      });
      article.append(retry, discard);
    }
  }
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
        }, generation);
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
    const delivery = deliveryReplySchema.parse(await browser.runtime.sendMessage({ type: DELIVERY_MESSAGE.list }));
    if (!delivery.ok) throw new Error(delivery.error);
    if (generation !== loadGeneration) return;
    const jobs = new Map(delivery.jobs.map(job => [job.id, job]));
    const snapshots = new Map(reply.attempts.map(attempt => [attempt.id, attempt]));
    for (const job of delivery.jobs) snapshots.set(job.id, job.snapshot);
    const ordered = [...snapshots.values()].sort((left, right) => right.submittedAt.localeCompare(left.submittedAt));
    const unscheduled = delivery.scheduling;
    attempts.replaceChildren(...ordered.map(attempt =>
      renderAttempt(attempt, delivery.selection, generation, unscheduled === null, jobs.get(attempt.id))));
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

refresh.addEventListener(DOM_EVENT.click, () => { void load(); });
browser.storage.onChanged.addListener((changes, area) => {
  if ((area === STORAGE_AREA.local && (PROGRESS_KEY in changes || DELIVERY_KEY in changes
    || DELIVERY_SCHEDULE_KEY in changes || DELIVERY_THROTTLE_KEY in changes
    || Object.keys(changes).some(key => key.startsWith(DESTINATION_STORAGE_PREFIX))))
    || (area === STORAGE_AREA.session && AUTH_SESSION_KEY in changes)) void load();
});
void load();
initializeRecovery();
