import { browser } from 'wxt/browser';
import { DOM_EVENT, STORAGE_AREA, UI_ROLE } from '../../lib/constants/browser';
import {
  DELIVERY_FAILURE, DELIVERY_KEY, DELIVERY_MESSAGE, DELIVERY_RETRY, DELIVERY_SCHEDULE_KEY, DELIVERY_STATE,
  DELIVERY_TEXT, DELIVERY_THROTTLE_KEY, DISCARDED_DELIVERY_KEY, deliveryCommitUrl,
} from '../../lib/constants/delivery';
import { DESTINATION_STORAGE_PREFIX } from '../../lib/constants/destination';
import { AUTH_SESSION_KEY } from '../../lib/constants/github';
import { LIFECYCLE_TEXT } from '../../lib/constants/lifecycle';
import { retryExhausted } from '../../lib/delivery/retry';
import {
  deliveryReplySchema, type DeliveryJob, type DeliveryReply, type DiscardRequest, type PublishRequest,
  type RetryRequest,
} from '../../lib/delivery/schemas';
import { sameDestination, type DestinationTarget } from '../../lib/destination/schemas';
import { renderMetadata } from './fields';

export interface JobContext {
  selection: DestinationTarget | null;
  scheduled: boolean;
  current: () => boolean;
  reload: () => Promise<void>;
}

type DeliveryView = Extract<DeliveryReply, { ok: true }>;
let pending: Promise<DeliveryView> | null = null;

// Both sections read the same delivery state, so one change means one read, not one per section.
export function deliveryView(): Promise<DeliveryView> {
  pending ??= (async () => {
    const reply = deliveryReplySchema.parse(await browser.runtime.sendMessage({ type: DELIVERY_MESSAGE.list }));
    if (!reply.ok) throw new Error(reply.error);
    return reply;
  })().catch((error: unknown) => {
    pending = null;
    throw error;
  });
  return pending;
}
export function invalidateDeliveryView(): void {
  pending = null;
}
// Registered before either section's listener, so their reloads share the refreshed read.
browser.storage.onChanged.addListener((changes, area) => {
  if ((area === STORAGE_AREA.local && (DELIVERY_KEY in changes || DISCARDED_DELIVERY_KEY in changes
    || DELIVERY_SCHEDULE_KEY in changes || DELIVERY_THROTTLE_KEY in changes
    || Object.keys(changes).some(key => key.startsWith(DESTINATION_STORAGE_PREFIX))))
    || (area === STORAGE_AREA.session && AUTH_SESSION_KEY in changes)) invalidateDeliveryView();
});

export async function deliveryAction(
  button: HTMLButtonElement, state: HTMLElement, request: PublishRequest | RetryRequest | DiscardRequest,
  context: JobContext,
): Promise<void> {
  if (!context.current() || !button.isConnected || button.disabled) return;
  const controls = [...button.parentElement?.querySelectorAll('button') ?? []].filter(control => !control.disabled);
  controls.forEach(control => { control.disabled = true; });
  try {
    const reply = deliveryReplySchema.parse(await browser.runtime.sendMessage(request));
    invalidateDeliveryView();
    if (!context.current() || !button.isConnected) return;
    if (!reply.ok) throw new Error(reply.error);
    await context.reload();
  } catch (error) {
    if (!context.current() || !button.isConnected) return;
    state.textContent = error instanceof Error ? error.message : DELIVERY_TEXT.operationFailed;
    state.setAttribute('role', UI_ROLE.alert);
    controls.forEach(control => { control.disabled = false; });
  }
}

export function jobStateText(job: DeliveryJob): string | null {
  switch (job.state) {
    case DELIVERY_STATE.pending:
    case DELIVERY_STATE.publishing:
      return DELIVERY_TEXT.awaiting;
    case DELIVERY_STATE.saved:
      return DELIVERY_TEXT.saved;
    case DELIVERY_STATE.reconciling:
      return DELIVERY_TEXT.reconciling;
    case DELIVERY_STATE.blocked:
      return DELIVERY_TEXT.blocked(job.detail ?? DELIVERY_TEXT.operationFailed);
    case DELIVERY_STATE.uncertain:
      return job.detail;
  }
  return null;
}

export function renderJob(job: DeliveryJob, state: HTMLElement, context: JobContext): HTMLElement[] {
  const nodes: HTMLElement[] = [];
  const account = document.createElement('p');
  account.textContent = LIFECYCLE_TEXT.originalAccount(job.target.owner, job.target.userId);
  const destination = document.createElement('p');
  destination.textContent = DELIVERY_TEXT.target(job.target.owner, job.target.name, job.target.branch);
  nodes.push(account, destination, renderMetadata({
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
    nodes.push(receipt);
  }
  if (job.state === DELIVERY_STATE.saved) return nodes;
  const selection = context.selection;
  const operationActive = job.state === DELIVERY_STATE.publishing || job.state === DELIVERY_STATE.reconciling;
  const compatible = selection !== null && sameDestination(selection, job.target);
  const retrySchedule = job.retry ?? null;
  if (retrySchedule?.nextAttemptAt) {
    const queued = document.createElement('p');
    const attempt = retrySchedule.attempts + 1;
    queued.textContent = !context.scheduled
      ? DELIVERY_TEXT.retryUnscheduled(attempt, DELIVERY_RETRY.maxAttempts, retrySchedule.nextAttemptAt)
      : retrySchedule.failure === DELIVERY_FAILURE.rateLimited
        ? DELIVERY_TEXT.retryThrottled(attempt, DELIVERY_RETRY.maxAttempts, retrySchedule.nextAttemptAt)
        : DELIVERY_TEXT.retryScheduled(attempt, DELIVERY_RETRY.maxAttempts, retrySchedule.nextAttemptAt);
    if (!context.scheduled) queued.setAttribute('role', UI_ROLE.alert);
    nodes.push(queued);
  } else if (retryExhausted(retrySchedule)) {
    const exhausted = document.createElement('p');
    exhausted.textContent = DELIVERY_TEXT.retryExhausted;
    nodes.push(exhausted);
  }
  if (!compatible) {
    const guidance = document.createElement('p');
    guidance.textContent = selection ? LIFECYCLE_TEXT.destinationChanged : LIFECYCLE_TEXT.reconnect;
    nodes.push(guidance);
  }
  if (operationActive) {
    const guidance = document.createElement('p');
    guidance.textContent = LIFECYCLE_TEXT.operationActive;
    nodes.push(guidance);
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
    }, context);
  });
  const discard = document.createElement('button');
  discard.type = 'button';
  discard.textContent = LIFECYCLE_TEXT.discard;
  discard.disabled = operationActive;
  discard.addEventListener(DOM_EVENT.click, async () => {
    if (!context.current() || !discard.isConnected || discard.disabled) return;
    if (!window.confirm(LIFECYCLE_TEXT.discardConfirmation(job.id))) return;
    await deliveryAction(discard, state, {
      type: DELIVERY_MESSAGE.discard, jobId: job.id, localConfirmed: true,
    }, context);
  });
  nodes.push(retry, discard);
  return nodes;
}
