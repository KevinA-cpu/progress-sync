import { DOM_EVENT, STORAGE_AREA, UI_ROLE } from '../../lib/constants/browser';
import { CAPTURE_STATE, PROGRESS_KEY, PROGRESS_MESSAGE, PROGRESS_TEXT } from '../../lib/constants/progress';
import { browser } from 'wxt/browser';
import { progressReplySchema, type Attempt } from '../../lib/progress';
import { DELIVERY_KEY, DELIVERY_MESSAGE, DELIVERY_STATE, DELIVERY_TEXT, deliveryCommitUrl } from '../../lib/constants/delivery';
import { AUTH_SESSION_KEY } from '../../lib/constants/github';
import { DESTINATION_STORAGE_PREFIX } from '../../lib/constants/destination';
import { deliveryReplySchema, type DeliveryJob, type DeliveryTarget } from '../../lib/delivery/schemas';
import './style.css';

const status = document.querySelector<HTMLParagraphElement>('#status');
const attempts = document.querySelector<HTMLElement>('#attempts');
const refresh = document.querySelector<HTMLButtonElement>('#refresh');
if (!status || !attempts || !refresh) throw new Error(PROGRESS_TEXT.interfaceIncomplete);

function renderAttempt(attempt: Attempt, selection: DeliveryTarget | null, job?: DeliveryJob): HTMLElement {
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
      case DELIVERY_STATE.blocked:
        state.textContent = DELIVERY_TEXT.blocked(job.detail ?? DELIVERY_TEXT.operationFailed);
        break;
      case DELIVERY_STATE.uncertain:
        state.textContent = job.detail;
        break;
    }
  }
  const metadata = document.createElement('dl');
  const values = {
    [PROGRESS_TEXT.attemptLabel]: attempt.id,
    [PROGRESS_TEXT.submittedLabel]: attempt.submittedAt,
    [PROGRESS_TEXT.observedLabel]: attempt.observedAt ?? PROGRESS_TEXT.notYet,
    [PROGRESS_TEXT.hashLabel]: attempt.sourceHash ?? PROGRESS_TEXT.unavailable,
    [PROGRESS_TEXT.captureLabel]: PROGRESS_TEXT.captureDescription,
  };
  for (const [label, value] of Object.entries(values)) {
    const term = document.createElement('dt');
    const description = document.createElement('dd');
    term.textContent = label;
    description.textContent = value;
    metadata.append(term, description);
  }
  article.append(heading, state, metadata);
  if (job) {
    const destination = document.createElement('p');
    destination.textContent = DELIVERY_TEXT.target(job.target.owner, job.target.name, job.target.branch);
    article.append(destination);
    if (job.receipt) {
      const receipt = document.createElement('a');
      receipt.textContent = DELIVERY_TEXT.commit(job.receipt.commitSha);
      receipt.href = deliveryCommitUrl(job.target.owner, job.target.name, job.receipt.commitSha);
      receipt.target = '_blank';
      receipt.rel = 'noopener noreferrer';
      article.append(receipt);
    }
  }
  if (attempt.source !== null) {
    const label = document.createElement('label');
    label.textContent = PROGRESS_TEXT.submittedSource;
    const source = document.createElement('textarea');
    source.readOnly = true;
    source.value = attempt.source;
    source.rows = Math.min(18, Math.max(4, attempt.source.split('\n').length));
    label.append(source);
    article.append(label);
  }
  if (attempt.state === CAPTURE_STATE.accepted && !job) {
    if (selection) {
      const publish = document.createElement('button');
      publish.textContent = DELIVERY_TEXT.select(selection.owner, selection.name, selection.branch);
      publish.addEventListener(DOM_EVENT.click, async () => {
        publish.disabled = true;
        try {
          const reply = deliveryReplySchema.parse(await browser.runtime.sendMessage({
            type: DELIVERY_MESSAGE.publish, attemptId: attempt.id, expectedConnectionId: selection.connectionId,
            expectedSelectionId: selection.operationId, publicConfirmed: true,
          }));
          if (!reply.ok) throw new Error(reply.error);
          await load();
        } catch (error) {
          state.textContent = error instanceof Error ? error.message : DELIVERY_TEXT.operationFailed;
          state.setAttribute('role', UI_ROLE.alert);
          publish.disabled = false;
        }
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

let loadGeneration = 0;
async function load(): Promise<void> {
  const generation = ++loadGeneration;
  if (!status || !attempts) throw new Error(PROGRESS_TEXT.interfaceIncomplete);
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
    attempts.replaceChildren(...[...reply.attempts].reverse().map(attempt =>
      renderAttempt(attempt, delivery.selection, delivery.jobs.find(job => job.id === attempt.id))));
    status.textContent = reply.attempts.length === 0
      ? PROGRESS_TEXT.empty
      : PROGRESS_TEXT.attemptCount(reply.attempts.length);
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
    || Object.keys(changes).some(key => key.startsWith(DESTINATION_STORAGE_PREFIX))))
    || (area === STORAGE_AREA.session && AUTH_SESSION_KEY in changes)) void load();
});
void load();
