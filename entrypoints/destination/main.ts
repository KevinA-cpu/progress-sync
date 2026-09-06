import { browser } from 'wxt/browser';
import { AUTH_SESSION_KEY } from '../../lib/github/schemas';
import {
  destinationMessages, destinationReplySchema, destinationRequestSchema,
  type DestinationRequest, type DestinationView,
} from '../../lib/destination/schemas';
import '../options/style.css';

function required<T extends HTMLElement>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error('Destination interface is incomplete.');
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
  owner.textContent = `Owner: ${view.user.login}`;
  const chosen = installation.value;
  installation.replaceChildren(...view.installations.map(item => {
    const option = document.createElement('option');
    option.value = String(item.id);
    option.textContent = `App ${item.appId}, installation ${item.id} (${item.selection} repositories)`;
    return option;
  }));
  if (view.installations.some(item => String(item.id) === chosen)) installation.value = chosen;
  saved.textContent = view.journal
    ? `Saved setup: ${view.journal.owner}/${view.journal.name} (${view.journal.phase}). Repository ID: ${view.journal.repositoryId ?? 'not confirmed'}.`
    : 'No destination selected.';
  status.textContent = view.verified && view.journal
    ? `Verified destination: ${view.journal.owner}/${view.journal.name} @ ${view.journal.branch}`
    : view.installations.length === 0 ? destinationMessages['installation-required']
      : 'Select a repository action. Saved destinations must be verified again before use.';
}
async function perform(input: DestinationRequest): Promise<void> {
  if (busy) {
    status.textContent = 'A repository operation is already running. Wait for it to finish.';
    return;
  }
  const current = ++version;
  busy = true;
  form.disabled = true;
  status.textContent = 'Checking GitHub destination...';
  try {
    const parsedInput = destinationRequestSchema.safeParse(input);
    if (!parsedInput.success) {
      status.textContent = destinationMessages['invalid-input'];
      return;
    }
    const reply = destinationReplySchema.safeParse(await browser.runtime.sendMessage(parsedInput.data));
    if (current !== version) return;
    if (!reply.success) {
      status.textContent = destinationMessages['invalid-response'];
    } else if (!reply.data.ok) {
      status.textContent = destinationMessages[reply.data.error];
      if (reply.data.error === 'not-connected' || reply.data.error === 'session-changed') connectionId = null;
    } else {
      render(reply.data.view);
    }
  } catch {
    if (current === version) status.textContent = 'Destination setup was interrupted. Refresh and verify before retrying.';
  } finally {
    busy = false;
    form.disabled = connectionId === null;
  }
}
required('#refresh').addEventListener('click', () => { void perform({ type: 'destination:load' }); });
required('#create').addEventListener('click', () => {
  if (!required<HTMLInputElement>('#public-confirmed').checked) {
    status.textContent = 'Confirm public visibility before creating a repository.';
    return;
  }
  void perform({
    type: 'destination:create', name: name.value, installationId: Number(installation.value),
    publicConfirmed: true, expectedConnectionId: connectionId ?? '',
  });
});
required('#existing').addEventListener('click', () => {
  void perform({
    type: 'destination:connect', name: name.value, installationId: Number(installation.value),
    initialize: required<HTMLInputElement>('#initialize').checked,
    expectedConnectionId: connectionId ?? '',
    ...(branch.value ? { branch: branch.value } : {}),
  });
});
required('#verify').addEventListener('click', () => {
  void perform({ type: 'destination:verify', expectedConnectionId: connectionId ?? '' });
});
required('#discard').addEventListener('click', () => {
  if (!required<HTMLInputElement>('#discard-confirmed').checked) {
    status.textContent = 'Confirm discarding only the local setup record.';
    return;
  }
  void perform({ type: 'destination:discard', confirmed: true, expectedConnectionId: connectionId ?? '' });
});
browser.storage.onChanged.addListener((changes, area) => {
  if (area === 'session' && AUTH_SESSION_KEY in changes) {
    version++;
    connectionId = null;
    owner.textContent = 'GitHub session changed. Refresh to verify your identity.';
    status.textContent = destinationMessages['session-changed'];
    saved.textContent = '';
    form.disabled = true;
  }
});
void perform({ type: 'destination:load' });
