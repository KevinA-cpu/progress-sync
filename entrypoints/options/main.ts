import { browser } from 'wxt/browser';
import { PROGRESS_KEY, isAttemptList, isObject, type Attempt } from '../../lib/progress';
import './style.css';

const status = document.querySelector<HTMLParagraphElement>('#status');
const attempts = document.querySelector<HTMLElement>('#attempts');
const refresh = document.querySelector<HTMLButtonElement>('#refresh');
if (!status || !attempts || !refresh) throw new Error('Progress interface is incomplete.');

function renderAttempt(attempt: Attempt): HTMLElement {
  const article = document.createElement('article');
  const heading = document.createElement('h2');
  heading.textContent = `hdlbits:${attempt.problemId ?? 'unknown'}`;
  const state = document.createElement('p');
  state.className = attempt.state;
  state.textContent = attempt.state === 'unverified' ? `Unverified: ${attempt.reason}` : attempt.reason;
  const metadata = document.createElement('dl');
  const values = {
    'Attempt': attempt.id,
    'Submitted': attempt.submittedAt,
    'Observed': attempt.observedAt ?? 'Not yet',
    'SHA-256 (submitted bytes)': attempt.sourceHash ?? 'Unavailable',
    'Capture': 'Browser-observed POST; extension observation, not a signed grading certificate',
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
    label.textContent = 'Submitted source';
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
  if (!status || !attempts) throw new Error('Progress interface is incomplete.');
  try {
    const reply: unknown = await browser.runtime.sendMessage({ type: 'progress:list' });
    if (!isObject(reply) || reply.ok !== true || !isAttemptList(reply.attempts)) {
      throw new Error(isObject(reply) && typeof reply.error === 'string'
        ? reply.error : 'Local progress could not be read.');
    }
    attempts.replaceChildren(...[...reply.attempts].reverse().map(renderAttempt));
    status.textContent = reply.attempts.length === 0
      ? 'No captured attempts yet. Submit using the in-page HDLBits editor.'
      : `${reply.attempts.length} captured attempt${reply.attempts.length === 1 ? '' : 's'}.`;
    status.setAttribute('role', 'status');
  } catch (error) {
    status.textContent = error instanceof Error ? error.message : 'Local progress could not be read.';
    status.setAttribute('role', 'alert');
  }
}

refresh.addEventListener('click', () => { void load(); });
browser.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && PROGRESS_KEY in changes) void load();
});
void load();
