import { DOM_EVENT, STORAGE_AREA } from '../../lib/constants/browser';
import { DESTINATION_ISSUE, DESTINATION_MESSAGE, DESTINATION_TEXT } from '../../lib/constants/destination';
import { AUTH_SESSION_KEY } from '../../lib/constants/github';
import { browser } from 'wxt/browser';

import {
  destinationMessages, destinationReplySchema, destinationRequestSchema, type DestinationRequest,
  type DestinationView,
} from '../../lib/destination/schemas';
import '../options/style.css';

function required<T extends HTMLElement>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(DESTINATION_TEXT.interfaceIncomplete);
  return element;
}
const status = required<HTMLElement>('#status');
const owner = required<HTMLElement>('#owner');
const form = required<HTMLFieldSetElement>('#form');
const installation = required<HTMLSelectElement>('#installation');
const name = required<HTMLInputElement>('#name');
const branch = required<HTMLInputElement>('#branch');
const saved = required<HTMLElement>('#saved');
let version = 0;
let busy = false;
let connectionId: string | null = null;

function render(view: DestinationView) {
  if (connectionId !== view.connectionId) {
    required<HTMLInputElement>('#public-confirmed').checked = false;
    required<HTMLInputElement>('#initialize').checked = false;
    required<HTMLInputElement>('#discard-confirmed').checked = false;
  }
  connectionId = view.connectionId;
  owner.textContent = DESTINATION_TEXT.owner(view.user.login);
  const chosen = installation.value;
  installation.replaceChildren(...view.installations.map(item => {
    const option = document.createElement('option');
    option.value = String(item.id);
    option.textContent = DESTINATION_TEXT.installation(item.appId, item.id, item.selection);
    return option;
  }));
  if (view.installations.some(item => String(item.id) === chosen)) installation.value = chosen;
  saved.textContent = view.journal
    ? DESTINATION_TEXT.savedSetup(view.journal.owner, view.journal.name, view.journal.phase, view.journal.repositoryId)
    : DESTINATION_TEXT.noSelection;
  status.textContent = view.verified && view.journal
    ? DESTINATION_TEXT.verified(view.journal.owner, view.journal.name, view.journal.branch)
    : view.installations.length === 0 ? destinationMessages[DESTINATION_ISSUE.installationRequired]
      : DESTINATION_TEXT.selectAction;
}
async function perform(input: DestinationRequest): Promise<void> {
  if (busy) {
    status.textContent = DESTINATION_TEXT.alreadyRunning;
    return;
  }
  const current = ++version;
  busy = true;
  form.disabled = true;
  status.textContent = DESTINATION_TEXT.checking;
  try {
    const parsedInput = destinationRequestSchema.safeParse(input);
    if (!parsedInput.success) {
      status.textContent = destinationMessages[DESTINATION_ISSUE.invalidInput];
      return;
    }
    const reply = destinationReplySchema.safeParse(await browser.runtime.sendMessage(parsedInput.data));
    if (current !== version) return;
    if (!reply.success) {
      status.textContent = destinationMessages[DESTINATION_ISSUE.invalidResponse];
    } else if (!reply.data.ok) {
      status.textContent = destinationMessages[reply.data.error];
      if (reply.data.error === DESTINATION_ISSUE.notConnected || reply.data.error === DESTINATION_ISSUE.sessionChanged) connectionId = null;
    } else {
      render(reply.data.view);
    }
  } catch {
    if (current === version) status.textContent = DESTINATION_TEXT.interrupted;
  } finally {
    busy = false;
    form.disabled = connectionId === null;
  }
}
required('#refresh').addEventListener(DOM_EVENT.click, () => { void perform({ type: DESTINATION_MESSAGE.load }); });
required('#create').addEventListener(DOM_EVENT.click, () => {
  if (!required<HTMLInputElement>('#public-confirmed').checked) {
    status.textContent = DESTINATION_TEXT.confirmPublic;
    return;
  }
  void perform({
    type: DESTINATION_MESSAGE.create, name: name.value, installationId: Number(installation.value),
    publicConfirmed: true, expectedConnectionId: connectionId ?? '',
  });
});
required('#existing').addEventListener(DOM_EVENT.click, () => {
  void perform({
    type: DESTINATION_MESSAGE.connect, name: name.value, installationId: Number(installation.value),
    initialize: required<HTMLInputElement>('#initialize').checked,
    expectedConnectionId: connectionId ?? '',
    ...(branch.value ? { branch: branch.value } : {}),
  });
});
required('#verify').addEventListener(DOM_EVENT.click, () => {
  void perform({ type: DESTINATION_MESSAGE.verify, expectedConnectionId: connectionId ?? '' });
});
required('#discard').addEventListener(DOM_EVENT.click, () => {
  if (!required<HTMLInputElement>('#discard-confirmed').checked) {
    status.textContent = DESTINATION_TEXT.confirmDiscard;
    return;
  }
  void perform({ type: DESTINATION_MESSAGE.discard, confirmed: true, expectedConnectionId: connectionId ?? '' });
});
browser.storage.onChanged.addListener((changes, area) => {
  if (area === STORAGE_AREA.session && AUTH_SESSION_KEY in changes) {
    version++;
    connectionId = null;
    owner.textContent = DESTINATION_TEXT.sessionChanged;
    status.textContent = destinationMessages[DESTINATION_ISSUE.sessionChanged];
    saved.textContent = '';
    form.disabled = true;
  }
});
void perform({ type: DESTINATION_MESSAGE.load });
