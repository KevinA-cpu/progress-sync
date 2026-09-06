import { DOM_EVENT, STORAGE_AREA, UI_ROLE } from '../../lib/constants/browser';
import { CAPTURE_STATE, PROGRESS_KEY, PROGRESS_MESSAGE, PROGRESS_TEXT } from '../../lib/constants/progress';
import { browser } from 'wxt/browser';
import { progressReplySchema, type Attempt } from '../../lib/progress';
import './style.css';

const status = document.querySelector<HTMLParagraphElement>('#status');
const attempts = document.querySelector<HTMLElement>('#attempts');
const refresh = document.querySelector<HTMLButtonElement>('#refresh');
if (!status || !attempts || !refresh) throw new Error(PROGRESS_TEXT.interfaceIncomplete);

function renderAttempt(attempt: Attempt): HTMLElement {
  const article = document.createElement('article');
  const heading = document.createElement('h2');
  heading.textContent = PROGRESS_TEXT.problemHeading(attempt.problemId);
  const state = document.createElement('p');
  state.className = attempt.state;
  state.textContent = attempt.state === CAPTURE_STATE.unverified ? PROGRESS_TEXT.unverified(attempt.reason) : attempt.reason;
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
  return article;
}

async function load(): Promise<void> {
  if (!status || !attempts) throw new Error(PROGRESS_TEXT.interfaceIncomplete);
  try {
    const parsed = progressReplySchema.safeParse(
      await browser.runtime.sendMessage({ type: PROGRESS_MESSAGE.list }),
    );
    if (!parsed.success) throw new Error(PROGRESS_TEXT.readFailed);
    const reply = parsed.data;
    if (!reply.ok) throw new Error(reply.error);
    attempts.replaceChildren(...[...reply.attempts].reverse().map(renderAttempt));
    status.textContent = reply.attempts.length === 0
      ? PROGRESS_TEXT.empty
      : PROGRESS_TEXT.attemptCount(reply.attempts.length);
    status.setAttribute('role', UI_ROLE.status);
  } catch (error) {
    status.textContent = error instanceof Error ? error.message : PROGRESS_TEXT.readFailed;
    status.setAttribute('role', UI_ROLE.alert);
  }
}

refresh.addEventListener(DOM_EVENT.click, () => { void load(); });
browser.storage.onChanged.addListener((changes, area) => {
  if (area === STORAGE_AREA.local && PROGRESS_KEY in changes) void load();
});
void load();
