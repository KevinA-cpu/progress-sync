import { browser } from 'wxt/browser';
import { githubCall } from '../../lib/github/client';
import { authorizeDevice } from '../../lib/github/device-flow';
import {
  AUTH_SESSION_KEY, AuthFault, authIssue, issueMessages, pendingSessionSchema, type AuthState,
} from '../../lib/github/schemas';
import '../options/style.css';

function required<T extends HTMLElement>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error('GitHub connection interface is incomplete.');
  return element;
}

const status = required<HTMLParagraphElement>('#status');
const details = required<HTMLParagraphElement>('#details');
const connect = required<HTMLButtonElement>('#connect');
const cancel = required<HTMLButtonElement>('#cancel');
const disconnect = required<HTMLButtonElement>('#disconnect');
const check = required<HTMLButtonElement>('#check');
const challenge = required<HTMLElement>('#challenge');
const code = required<HTMLElement>('#user-code');
const verificationLink = required<HTMLAnchorElement>('#verification-link');
const verificationExpiry = required<HTMLElement>('#verification-expiry');
let active: { id: string; controller: AbortController } | null = null;
let refreshVersion = 0;

function render(state: AuthState): void {
  connect.disabled = state.status === 'unavailable' || state.status === 'connected'
    || (state.status === 'authorizing' && active?.id === state.attemptId);
  cancel.disabled = !active;
  disconnect.disabled = state.status !== 'connected' && state.status !== 'authorizing';
  check.disabled = state.status !== 'connected';
  details.textContent = '';
  if (state.status === 'connected') {
    status.textContent = `Connected as ${state.user.login}`;
    details.textContent = `Identity verified at ${state.verifiedAt}. Session expires at ${state.expiresAt}.`;
  } else if (state.status === 'authorizing') {
    status.textContent = active?.id === state.attemptId
      ? 'Waiting for GitHub authorization...' : 'Authorization is in progress in another connection tab.';
  } else {
    status.textContent = issueMessages[state.issue];
  }
  if (state.status !== 'authorizing' || active?.id !== state.attemptId) challenge.hidden = true;
}

async function refresh(): Promise<void> {
  const version = ++refreshVersion;
  try {
    const state = await githubCall({ type: 'github:state' });
    if (version === refreshVersion) render(state);
  } catch {
    if (version === refreshVersion) {
      status.textContent = issueMessages.interrupted;
      connect.disabled = false;
    }
  }
}

async function start(): Promise<void> {
  if (active) {
    status.textContent = 'An authorization attempt is already running in this tab.';
    return;
  }
  refreshVersion++;
  const current = { id: crypto.randomUUID(), controller: new AbortController() };
  active = current;
  connect.disabled = true;
  cancel.disabled = false;
  status.textContent = 'Starting GitHub authorization...';
  challenge.hidden = true;
  try {
    const state = await githubCall({ type: 'github:begin', attemptId: current.id });
    if (current.controller.signal.aborted) throw new AuthFault('cancelled');
    if (state.status !== 'authorizing' || state.attemptId !== current.id) throw new AuthFault('not-allowed');
    const credentials = await authorizeDevice(
      state.clientId,
      current.controller.signal,
      async () => {
        if (current.controller.signal.aborted) throw new AuthFault('cancelled');
        await githubCall({ type: 'github:permit', attemptId: current.id });
        if (current.controller.signal.aborted) throw new AuthFault('cancelled');
      },
      verification => {
        if (active?.id !== current.id || current.controller.signal.aborted) return;
        code.textContent = verification.userCode;
        verificationLink.href = verification.verificationUri;
        verificationExpiry.textContent = `Verification code expires at ${verification.expiresAt}.`;
        challenge.hidden = false;
        status.textContent = 'Waiting for GitHub authorization...';
      },
    );
    if (current.controller.signal.aborted) throw new AuthFault('cancelled');
    status.textContent = 'Verifying GitHub identity...';
    challenge.hidden = true;
    await githubCall({ type: 'github:complete', attemptId: current.id, credentials });
  } catch (error) {
    const issue = current.controller.signal.aborted
      ? current.controller.signal.reason instanceof AuthFault
        ? current.controller.signal.reason.issue : 'cancelled'
      : authIssue(error);
    try {
      await githubCall({ type: 'github:cancel', attemptId: current.id, issue });
    } catch (cancelError) {
      if (cancelError instanceof AuthFault && cancelError.issue === 'not-allowed') {
        console.info('Progress Sync: obsolete authorization result discarded.');
      } else {
        console.error('Progress Sync: authorization cancellation could not be confirmed.');
      }
    }
  } finally {
    if (active?.id === current.id) active = null;
    await refresh();
  }
}

connect.addEventListener('click', () => { void start(); });
cancel.addEventListener('click', () => {
  if (!active) return;
  const current = active;
  current.controller.abort();
  void githubCall({ type: 'github:cancel', attemptId: current.id, issue: 'cancelled' })
    .then(refresh, refresh);
});
disconnect.addEventListener('click', () => {
  active?.controller.abort();
  void githubCall({ type: 'github:disconnect' }).then(refresh, refresh);
});
check.addEventListener('click', () => {
  check.disabled = true;
  void githubCall({ type: 'github:check' }).then(refresh, refresh);
});
browser.storage.onChanged.addListener((changes, area) => {
  if (area !== 'session' || !(AUTH_SESSION_KEY in changes)) return;
  if (active) {
    const pending = pendingSessionSchema.safeParse(changes[AUTH_SESSION_KEY]?.newValue);
    if (!pending.success || pending.data.attemptId !== active.id) active.controller.abort();
  }
  void refresh();
});
window.addEventListener('pagehide', () => { active?.controller.abort(new AuthFault('interrupted')); });
void refresh();
