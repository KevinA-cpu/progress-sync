import { DOM_EVENT, LOG_PREFIX, STORAGE_AREA } from '../../lib/constants/browser';
import { AUTH_ISSUE, AUTH_MESSAGE, AUTH_SESSION_KEY, AUTH_STATUS, AUTH_TEXT } from '../../lib/constants/github';
import { browser } from 'wxt/browser';
import { githubCall } from '../../lib/github/client';
import { authorizeDevice } from '../../lib/github/device-flow';
import {
  AuthFault, authIssue, issueMessages, pendingSessionSchema, type AuthRequest, type AuthState,
} from '../../lib/github/schemas';
import '../options/style.css';

function required<T extends HTMLElement>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(AUTH_TEXT.interfaceIncomplete);
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
  connect.disabled = state.status === AUTH_STATUS.unavailable || state.status === AUTH_STATUS.connected
    || (state.status === AUTH_STATUS.authorizing && active?.id === state.attemptId);
  cancel.disabled = !active;
  disconnect.disabled = state.status !== AUTH_STATUS.connected && state.status !== AUTH_STATUS.authorizing;
  check.disabled = state.status !== AUTH_STATUS.connected;
  details.textContent = '';
  switch (state.status) {
    case AUTH_STATUS.connected:
      status.textContent = AUTH_TEXT.connected(state.user.login);
      details.textContent = AUTH_TEXT.connectionDetails(state.verifiedAt, state.expiresAt);
      break;
    case AUTH_STATUS.authorizing:
      status.textContent = active?.id === state.attemptId
        ? AUTH_TEXT.waiting : AUTH_TEXT.anotherTab;
      break;
    case AUTH_STATUS.disconnected:
    case AUTH_STATUS.unavailable:
      status.textContent = issueMessages[state.issue];
      break;
  }
  if (state.status !== AUTH_STATUS.authorizing || active?.id !== state.attemptId) challenge.hidden = true;
}

async function refresh(): Promise<void> {
  const version = ++refreshVersion;
  try {
    const state = await githubCall({ type: AUTH_MESSAGE.state });
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
    status.textContent = AUTH_TEXT.alreadyRunning;
    return;
  }
  refreshVersion++;
  const current = { id: crypto.randomUUID(), controller: new AbortController() };
  active = current;
  connect.disabled = true;
  cancel.disabled = false;
  status.textContent = AUTH_TEXT.starting;
  challenge.hidden = true;
  try {
    const state = await githubCall({ type: AUTH_MESSAGE.begin, attemptId: current.id });
    if (current.controller.signal.aborted) throw new AuthFault(AUTH_ISSUE.cancelled);
    if (state.status !== AUTH_STATUS.authorizing || state.attemptId !== current.id) throw new AuthFault(AUTH_ISSUE.notAllowed);
    const credentials = await authorizeDevice(
      state.clientId,
      current.controller.signal,
      async () => {
        if (current.controller.signal.aborted) throw new AuthFault(AUTH_ISSUE.cancelled);
        await githubCall({ type: AUTH_MESSAGE.permit, attemptId: current.id });
        if (current.controller.signal.aborted) throw new AuthFault(AUTH_ISSUE.cancelled);
      },
      verification => {
        if (active?.id !== current.id || current.controller.signal.aborted) return;
        code.textContent = verification.userCode;
        verificationLink.href = verification.verificationUri;
        verificationExpiry.textContent = AUTH_TEXT.verificationExpiry(verification.expiresAt);
        challenge.hidden = false;
        status.textContent = AUTH_TEXT.waiting;
      },
    );
    if (current.controller.signal.aborted) throw new AuthFault(AUTH_ISSUE.cancelled);
    status.textContent = AUTH_TEXT.verifying;
    challenge.hidden = true;
    await githubCall({ type: AUTH_MESSAGE.complete, attemptId: current.id, credentials });
  } catch (error) {
    const issue = current.controller.signal.aborted
      ? current.controller.signal.reason instanceof AuthFault
        ? current.controller.signal.reason.issue : AUTH_ISSUE.cancelled
      : authIssue(error);
    try {
      await githubCall({ type: AUTH_MESSAGE.cancel, attemptId: current.id, issue });
    } catch (cancelError) {
      if (cancelError instanceof AuthFault && cancelError.issue === AUTH_ISSUE.notAllowed) {
        console.info(AUTH_TEXT.obsoleteResult);
      } else {
        console.error(AUTH_TEXT.cancellationUnconfirmed);
      }
    }
  } finally {
    if (active?.id === current.id) active = null;
    await refresh();
  }
}

async function updateConnection(request: AuthRequest): Promise<void> {
  try {
    await githubCall(request);
  } catch (error) {
    if (!(error instanceof AuthFault)) throw error;
    console.warn(LOG_PREFIX, issueMessages[error.issue]);
  }
  await refresh();
}

connect.addEventListener(DOM_EVENT.click, () => { void start(); });
cancel.addEventListener(DOM_EVENT.click, () => {
  if (!active) return;
  const current = active;
  current.controller.abort();
  void updateConnection({ type: AUTH_MESSAGE.cancel, attemptId: current.id, issue: AUTH_ISSUE.cancelled });
});
disconnect.addEventListener(DOM_EVENT.click, () => {
  active?.controller.abort();
  void updateConnection({ type: AUTH_MESSAGE.disconnect });
});
check.addEventListener(DOM_EVENT.click, () => {
  check.disabled = true;
  void updateConnection({ type: AUTH_MESSAGE.check });
});
browser.storage.onChanged.addListener((changes, area) => {
  if (area !== STORAGE_AREA.session || !(AUTH_SESSION_KEY in changes)) return;
  if (active) {
    const pending = pendingSessionSchema.safeParse(changes[AUTH_SESSION_KEY]?.newValue);
    if (!pending.success || pending.data.attemptId !== active.id) active.controller.abort();
  }
  void refresh();
});
window.addEventListener(DOM_EVENT.pageHide, () => { active?.controller.abort(new AuthFault(AUTH_ISSUE.interrupted)); });
void refresh();
