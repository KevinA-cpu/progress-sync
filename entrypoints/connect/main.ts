import { DOM_EVENT, LOG_PREFIX, STORAGE_AREA, UI_ROLE } from '../../lib/constants/browser';
import { AUTH_ISSUE, AUTH_MESSAGE, AUTH_SESSION_KEY, AUTH_STATUS, AUTH_TEXT } from '../../lib/constants/github';
import { browser } from 'wxt/browser';
import { githubCall } from '../../lib/github/client';
import { authorizeDevice } from '../../lib/github/device-flow';
import {
  AuthFault, authIssue, issueMessages, pendingSessionSchema,
  type AuthRequest, type AuthState, type RememberView,
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
const remember = required<HTMLInputElement>('#remember');
const rememberLabel = required<HTMLElement>('#remember-label');
const rememberConsent = required<HTMLParagraphElement>('#remember-consent');
const rememberState = required<HTMLParagraphElement>('#remember-state');
let active: { id: string; controller: AbortController } | null = null;
let refreshVersion = 0;

rememberLabel.textContent = AUTH_TEXT.rememberLabel;
rememberConsent.textContent = AUTH_TEXT.rememberConsent;

function rememberText(view: RememberView): string {
  if (view.issue === AUTH_ISSUE.rememberUnavailable) return AUTH_TEXT.rememberBlocked;
  if (view.issue !== null) return issueMessages[view.issue];
  if (view.stored && view.expiresAt !== null) return AUTH_TEXT.remembered(view.expiresAt);
  return view.enabled ? AUTH_TEXT.rememberPending : AUTH_TEXT.rememberOff;
}

function renderRemember(view: RememberView): void {
  remember.checked = view.enabled;
  remember.disabled = false;
  rememberState.textContent = rememberText(view);
  // Only a problem is announced: the page already has one status region for the connection itself.
  if (view.issue === null) rememberState.removeAttribute('role');
  else rememberState.setAttribute('role', UI_ROLE.alert);
}

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
    const outcome = await githubCall({ type: AUTH_MESSAGE.state });
    if (version === refreshVersion) {
      render(outcome.state);
      renderRemember(outcome.remember);
    }
  } catch {
    if (version === refreshVersion) {
      status.textContent = issueMessages.interrupted;
      connect.disabled = false;
      remember.disabled = false;
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
    const { state } = await githubCall({ type: AUTH_MESSAGE.begin, attemptId: current.id });
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
remember.addEventListener(DOM_EVENT.change, () => {
  const enabled = remember.checked;
  remember.disabled = true;
  // The acknowledgement states that this page had the consent text on screen when the box was ticked.
  void updateConnection({
    type: AUTH_MESSAGE.remember, enabled,
    consentAcknowledged: enabled && rememberConsent.textContent === AUTH_TEXT.rememberConsent,
  });
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
