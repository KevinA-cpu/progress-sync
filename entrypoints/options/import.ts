import { browser } from 'wxt/browser';
import { DOM_EVENT, STORAGE_AREA, UI_ROLE } from '../../lib/constants/browser';
import {
  DELIVERY_KEY, DELIVERY_SCHEDULE_KEY, DELIVERY_STATE, DISCARDED_DELIVERY_KEY,
} from '../../lib/constants/delivery';
import { DESTINATION_STORAGE_PREFIX } from '../../lib/constants/destination';
import { AUTH_SESSION_KEY } from '../../lib/constants/github';
import {
  IMPORT_DISCOVERY_KEY, IMPORT_LIMIT, IMPORT_MESSAGE, IMPORT_MESSAGES, IMPORT_STATUS, IMPORT_STOP, IMPORT_TEXT,
} from '../../lib/constants/import';
import { PROGRESS_TEXT } from '../../lib/constants/progress';
import { importedJobSnapshot, type DeliveryJob } from '../../lib/delivery/schemas';
import {
  importJobId, importReplySchema, type ImportCandidate, type ImportDiscovery,
} from '../../lib/import/schemas';
import { renderMetadata, renderSource } from './fields';
import { deliveryView, invalidateDeliveryView, jobStateText, renderJob, type JobContext } from './job';

interface Entry {
  candidate: ImportCandidate;
  job?: DeliveryJob;
  discarded: boolean;
}

function candidateMetadata(candidate: ImportCandidate): Record<string, string> {
  return {
    [IMPORT_TEXT.recordLabel]: candidate.recordId,
    [IMPORT_TEXT.submissionLabel]: candidate.submissionId,
    [IMPORT_TEXT.claimLabel]: IMPORT_TEXT.claimValue,
    [IMPORT_TEXT.labelLabel]: candidate.providerLabel,
    [IMPORT_TEXT.statusLabel]: String(candidate.providerStatus),
    [IMPORT_TEXT.bytesLabel]: String(candidate.sourceBytes),
    [IMPORT_TEXT.hashLabel]: candidate.sourceHash,
    [IMPORT_TEXT.discoveredLabel]: candidate.discoveredAt,
  };
}

// Delivery's own wording says "accepted"; an import states its own state instead.
function stateText(job: DeliveryJob | undefined): string {
  if (!job) return IMPORT_TEXT.unverified;
  switch (job.state) {
    case DELIVERY_STATE.pending:
    case DELIVERY_STATE.publishing:
      return IMPORT_TEXT.awaiting;
    case DELIVERY_STATE.saved:
      return IMPORT_TEXT.saved;
    default:
      return jobStateText(job) ?? IMPORT_TEXT.unverified;
  }
}

export function initializeImports(): void {
  const status = document.querySelector<HTMLParagraphElement>('#import-status');
  const list = document.querySelector<HTMLElement>('#imports');
  const discover = document.querySelector<HTMLButtonElement>('#discover-imports');
  const cancel = document.querySelector<HTMLButtonElement>('#cancel-imports');
  if (!status || !list || !discover || !cancel) throw new Error(IMPORT_TEXT.interfaceIncomplete);
  const ui = { status, list, discover, cancel };
  let generation = 0;
  let populated = false;

  function render(entry: Entry, context: JobContext): HTMLElement {
    const { candidate, job } = entry;
    const article = document.createElement('article');
    const heading = document.createElement('h3');
    heading.textContent = PROGRESS_TEXT.problemHeading(candidate.problemId);
    const state = document.createElement('p');
    state.className = 'unverified';
    state.textContent = stateText(job);
    article.append(heading, state, renderMetadata(candidateMetadata(candidate)));
    if (job) article.append(...renderJob(job, state, context));
    article.append(renderSource(IMPORT_TEXT.sourceLabel, candidate.source));
    const selection = context.selection;
    if (job) return article;
    if (!selection || entry.discarded) {
      const guidance = document.createElement('p');
      guidance.textContent = entry.discarded ? IMPORT_TEXT.discardedRecord : IMPORT_TEXT.noDestination;
      article.append(guidance);
      return article;
    }
    const publish = document.createElement('button');
    publish.type = 'button';
    publish.textContent = IMPORT_TEXT.publish(selection.owner, selection.name, selection.branch);
    publish.addEventListener(DOM_EVENT.click, async () => {
      if (!context.current() || !publish.isConnected || publish.disabled) return;
      if (!window.confirm(IMPORT_TEXT.publishConfirmation(candidate.problemId))) return;
      publish.disabled = true;
      try {
        const reply = importReplySchema.parse(await browser.runtime.sendMessage({
          type: IMPORT_MESSAGE.publish, recordId: candidate.recordId, expectedSourceHash: candidate.sourceHash,
          expectedConnectionId: selection.connectionId, expectedSelectionId: selection.operationId,
          publicConfirmed: true,
        }));
        invalidateDeliveryView();
        if (!context.current() || !publish.isConnected) return;
        if (!reply.ok) throw new Error(reply.error);
        await load();
      } catch (error) {
        if (!context.current() || !publish.isConnected) return;
        state.textContent = error instanceof Error ? error.message : IMPORT_TEXT.operationFailed;
        state.setAttribute('role', UI_ROLE.alert);
        publish.disabled = false;
      }
    });
    article.append(publish);
    return article;
  }

  // A pass that stopped short of the whole list says how much is left and how to reach it.
  function summarize(state: ImportDiscovery | null): string {
    if (!state) return IMPORT_TEXT.empty;
    // The problem that hit the size limit was counted but not read, so it is not reported as read either.
    const stopped = state.stopped === IMPORT_STOP.budget;
    const read = state.offset + state.scanned - (stopped ? 1 : 0);
    // A full preview list cannot be added to, so continuing it starts a new one.
    const restart = stopped || state.candidates.length >= IMPORT_LIMIT.problems;
    const rest = read < state.inventory
      ? restart ? IMPORT_TEXT.budgetStopped(read, state.inventory) : IMPORT_TEXT.remaining(read, state.inventory)
      : '';
    switch (state.status) {
      case IMPORT_STATUS.running:
        return IMPORT_TEXT.scanning(state.scanned, state.total);
      case IMPORT_STATUS.cancelled:
        return IMPORT_TEXT.cancelled(state.candidates.length, state.scanned) + rest;
      case IMPORT_STATUS.complete:
        return IMPORT_TEXT.complete(state.candidates.length, state.failures.length) + rest;
      case IMPORT_STATUS.failed:
        return state.error ?? IMPORT_TEXT.scanFailed;
    }
  }

  async function load(): Promise<void> {
    const current = ++generation;
    ui.list.querySelectorAll('button').forEach(button => { button.disabled = true; });
    try {
      const reply = importReplySchema.parse(await browser.runtime.sendMessage({ type: IMPORT_MESSAGE.list }));
      if (!reply.ok) throw new Error(reply.error);
      const delivery = await deliveryView();
      if (current !== generation) return;
      const state = reply.state;
      const running = state?.status === IMPORT_STATUS.running;
      const selection = delivery.selection;
      const context: JobContext = {
        selection, scheduled: delivery.scheduling === null,
        current: () => current === generation, reload: load,
      };
      // A record can be published to several destinations, so each job keeps its own entry and its own controls.
      const entries: Entry[] = [];
      const records = new Map<string, ImportCandidate>();
      for (const job of delivery.jobs) {
        const snapshot = importedJobSnapshot(job);
        if (!snapshot) continue;
        records.set(snapshot.recordId, snapshot);
        entries.push({ candidate: snapshot, job, discarded: false });
      }
      for (const candidate of state?.candidates ?? []) records.set(candidate.recordId, candidate);
      const discarded = new Set(delivery.discarded);
      const placed = new Set(delivery.jobs.map(job => job.id));
      for (const candidate of records.values()) {
        const here = selection ? await importJobId(candidate.recordId, selection) : null;
        if (here !== null && placed.has(here)) continue;
        if (here === null && entries.some(entry => entry.candidate.recordId === candidate.recordId)) continue;
        entries.push({ candidate, discarded: here !== null && discarded.has(here) });
      }
      if (current !== generation) return;
      populated = state !== null || entries.length > 0;
      entries.sort((left, right) => right.candidate.discoveredAt.localeCompare(left.candidate.discoveredAt));
      ui.list.replaceChildren(...entries.map(entry => render(entry, context)));
      for (const failure of state?.failures ?? []) {
        const skipped = document.createElement('p');
        skipped.textContent = IMPORT_TEXT.skipped(failure.problemId, IMPORT_MESSAGES[failure.reason]);
        ui.list.append(skipped);
      }
      ui.status.textContent = summarize(state);
      ui.status.className = state?.status === IMPORT_STATUS.failed ? 'unverified' : '';
      ui.discover.disabled = running;
      ui.cancel.disabled = !running;
    } catch (error) {
      if (current !== generation) return;
      ui.list.replaceChildren();
      ui.status.textContent = error instanceof Error ? error.message : IMPORT_TEXT.readFailed;
      ui.status.className = 'unverified';
      ui.discover.disabled = false;
      ui.cancel.disabled = true;
    }
  }

  async function control(
    button: HTMLButtonElement, type: typeof IMPORT_MESSAGE.discover | typeof IMPORT_MESSAGE.cancel,
  ): Promise<void> {
    button.disabled = true;
    const current = ++generation;
    try {
      const reply = importReplySchema.parse(await browser.runtime.sendMessage({ type }));
      if (current !== generation) return;
      if (!reply.ok) throw new Error(reply.error);
      await load();
    } catch (error) {
      if (current !== generation) return;
      const detail = error instanceof Error ? error.message : IMPORT_TEXT.operationFailed;
      await load();
      ui.status.textContent = detail;
      ui.status.className = 'unverified';
    }
  }

  ui.discover.addEventListener(DOM_EVENT.click, () => { void control(ui.discover, IMPORT_MESSAGE.discover); });
  ui.cancel.addEventListener(DOM_EVENT.click, () => { void control(ui.cancel, IMPORT_MESSAGE.cancel); });
  browser.storage.onChanged.addListener((changes, area) => {
    if (area === STORAGE_AREA.local && IMPORT_DISCOVERY_KEY in changes) {
      void load();
      return;
    }
    // Delivery and connection changes only redraw this section when it actually holds imports.
    if (!populated) return;
    if ((area === STORAGE_AREA.local && (DELIVERY_KEY in changes
      || DELIVERY_SCHEDULE_KEY in changes || DISCARDED_DELIVERY_KEY in changes
      || Object.keys(changes).some(key => key.startsWith(DESTINATION_STORAGE_PREFIX))))
      || (area === STORAGE_AREA.session && AUTH_SESSION_KEY in changes)) void load();
  });
  void load();
}
