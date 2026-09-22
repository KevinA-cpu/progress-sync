import { browser } from 'wxt/browser';
import { DOM_EVENT, STORAGE_AREA } from '../../lib/constants/browser';
import { AUTH_SESSION_KEY } from '../../lib/constants/github';
import { DESTINATION_STORAGE_PREFIX } from '../../lib/constants/destination';
import { deliveryCommitUrl, DELIVERY_TEXT } from '../../lib/constants/delivery';
import { IMPORT_TEXT } from '../../lib/constants/import';
import { PROGRESS_TEXT, VERDICT_LABEL } from '../../lib/constants/progress';
import { REPORT_TEXT } from '../../lib/constants/report';
import {
  RECOVERY_ENTRY, RECOVERY_MESSAGE, RECOVERY_MESSAGES, RECOVERY_STATUS, RECOVERY_TEXT,
} from '../../lib/constants/recovery';
import {
  recoveryImageReplySchema, recoveryNotificationSchema, recoveryReplySchema, type RecoveredEntry,
} from '../../lib/recovery/schemas';
import type { Diagram, DiagramImage } from '../../lib/report';
import { readRecoveryCache } from '../../lib/recovery/cache';
import type { DestinationTarget } from '../../lib/destination/schemas';
import { renderMetadata, renderReport, renderSource } from './fields';

// A published image is asked for by the record that names it. The service returns only bytes that match the
// recovered report, and they are rendered from their own data URL.
function published(path: string): (diagram: Diagram) => Promise<DiagramImage> {
  return async diagram => {
    const reply = recoveryImageReplySchema.parse(await browser.runtime.sendMessage({
      type: RECOVERY_MESSAGE.image, path, name: diagram.name,
    }));
    if (!reply.ok) throw new Error(reply.error);
    return reply.image;
  };
}

function render(entry: RecoveredEntry): HTMLElement {
  const article = document.createElement('article');
  const heading = document.createElement('h3');
  const state = document.createElement('p');
  switch (entry.state) {
    case RECOVERY_ENTRY.recorded: {
      heading.textContent = PROGRESS_TEXT.problemHeading(entry.metadata.problemId);
      state.textContent = RECOVERY_TEXT.recorded;
      state.className = 'accepted';
      const values = {
        [PROGRESS_TEXT.attemptLabel]: entry.metadata.attemptId,
        [PROGRESS_TEXT.hashLabel]: entry.metadata.sourceHash,
        [PROGRESS_TEXT.submittedLabel]: entry.metadata.submittedAt,
        [PROGRESS_TEXT.observedLabel]: entry.metadata.observedAt,
        ...entry.metadata.reportHash !== undefined
          ? { [REPORT_TEXT.publishedLabel]: REPORT_TEXT.publishedValue(entry.metadata.reportHash) }
          : {},
      };
      article.append(renderMetadata(values));
      // Accepted records published before they carried a report have none to show.
      if (entry.report) {
        article.append(renderReport(entry.report, {
          problemId: entry.metadata.problemId, images: null, request: published(entry.path),
        }));
      }
      break;
    }
    case RECOVERY_ENTRY.failed: {
      heading.textContent = PROGRESS_TEXT.problemHeading(entry.metadata.problemId);
      state.textContent = RECOVERY_TEXT.failed;
      state.className = 'failed';
      article.append(renderMetadata({
        [PROGRESS_TEXT.attemptLabel]: entry.metadata.attemptId,
        [PROGRESS_TEXT.outcomeLabel]: VERDICT_LABEL[entry.metadata.outcome],
        [PROGRESS_TEXT.hashLabel]: entry.metadata.sourceHash,
        [PROGRESS_TEXT.submittedLabel]: entry.metadata.submittedAt,
        [PROGRESS_TEXT.observedLabel]: entry.metadata.observedAt,
        [REPORT_TEXT.publishedLabel]: REPORT_TEXT.publishedValue(entry.metadata.reportHash),
      }), renderReport(entry.report, {
        problemId: entry.metadata.problemId, images: null, request: published(entry.path),
      }));
      break;
    }
    case RECOVERY_ENTRY.imported: {
      heading.textContent = PROGRESS_TEXT.problemHeading(entry.metadata.problemId);
      state.textContent = RECOVERY_TEXT.imported;
      state.className = 'unverified';
      article.append(renderMetadata({
        [IMPORT_TEXT.recordLabel]: entry.metadata.recordId,
        [IMPORT_TEXT.submissionLabel]: entry.metadata.submissionId,
        [IMPORT_TEXT.claimLabel]: IMPORT_TEXT.claimValue,
        [IMPORT_TEXT.labelLabel]: entry.metadata.providerLabel,
        [IMPORT_TEXT.statusLabel]: String(entry.metadata.providerStatus),
        [IMPORT_TEXT.hashLabel]: entry.metadata.sourceHash,
        [IMPORT_TEXT.discoveredLabel]: entry.metadata.discoveredAt,
      }));
      break;
    }
    case RECOVERY_ENTRY.unverified:
      heading.textContent = entry.path;
      state.textContent = RECOVERY_TEXT.unverified(RECOVERY_MESSAGES[entry.issue]);
      state.className = 'unverified';
      break;
  }
  article.prepend(heading, state);
  if (entry.source !== null) {
    article.append(renderSource(RECOVERY_TEXT.sourceLabel, entry.source));
  }
  return article;
}

export function initializeRecovery(): void {
  const status = document.querySelector<HTMLParagraphElement>('#recovery-status');
  const entries = document.querySelector<HTMLElement>('#recovered-entries');
  const refresh = document.querySelector<HTMLButtonElement>('#refresh-recovery');
  const origin = document.querySelector<HTMLElement>('#recovery-origin');
  if (!status || !entries || !refresh || !origin) throw new Error(RECOVERY_TEXT.interfaceIncomplete);
  const ui = { status, entries, refresh, origin };
  let generation = 0;
  let selection: DestinationTarget | null = null;
  async function load() {
    const current = ++generation;
    try {
      const reply = recoveryReplySchema.parse(await browser.runtime.sendMessage({ type: RECOVERY_MESSAGE.list }));
      if (!reply.ok) throw new Error(reply.error);
      let state = reply.selection ? await readRecoveryCache(reply.selection) : null;
      if (state?.status === RECOVERY_STATUS.loading && !reply.active) {
        state = { ...state, status: RECOVERY_STATUS.failed, error: RECOVERY_TEXT.interrupted };
      }
      if (current !== generation) return;
      selection = reply.selection;
      ui.refresh.disabled = !selection || state?.status === RECOVERY_STATUS.loading;
      ui.status.className = '';
      ui.origin.replaceChildren();
      switch (state?.status) {
        case RECOVERY_STATUS.loading:
          ui.status.textContent = RECOVERY_TEXT.loading;
          break;
        case RECOVERY_STATUS.failed:
          ui.status.textContent = state.error;
          ui.status.className = 'unverified';
          break;
        case RECOVERY_STATUS.ready: {
          const items = state.snapshot.entries;
          ui.status.textContent = RECOVERY_TEXT.summary(
            items.filter(item => item.state === RECOVERY_ENTRY.recorded).length,
            items.filter(item => item.state === RECOVERY_ENTRY.failed).length,
            items.filter(item => item.state === RECOVERY_ENTRY.imported).length,
            items.filter(item => item.state === RECOVERY_ENTRY.unverified).length,
          );
          break;
        }
        default:
          ui.status.textContent = selection ? RECOVERY_TEXT.waiting : RECOVERY_TEXT.noSelection;
      }
      ui.entries.replaceChildren(...(state?.snapshot?.entries ?? []).map(render));
      if (state?.snapshot) {
        const label = document.createElement('p');
        label.textContent = DELIVERY_TEXT.target(state.target.owner, state.target.name, state.target.branch);
        const snapshot = document.createElement('a');
        snapshot.textContent = RECOVERY_TEXT.snapshot(state.snapshot.commitSha);
        snapshot.href = deliveryCommitUrl(state.target.owner, state.target.name, state.snapshot.commitSha);
        snapshot.target = '_blank';
        snapshot.rel = 'noopener noreferrer';
        const readAt = document.createElement('p');
        readAt.textContent = RECOVERY_TEXT.readAt(state.snapshot.recoveredAt);
        ui.origin.append(label, snapshot, readAt);
        if (state.status !== RECOVERY_STATUS.ready) {
          const cached = document.createElement('p');
          cached.textContent = RECOVERY_TEXT.cached;
          ui.origin.append(cached);
        }
      }
    } catch (error) {
      if (current !== generation) return;
      selection = null;
      ui.entries.replaceChildren();
      ui.origin.replaceChildren();
      ui.status.textContent = error instanceof Error ? error.message : RECOVERY_TEXT.readFailed;
      ui.status.className = 'unverified';
      ui.refresh.disabled = !selection;
    }
  }
  ui.refresh.addEventListener(DOM_EVENT.click, async () => {
    if (!selection) {
      ui.status.textContent = RECOVERY_TEXT.noSelection;
      return;
    }
    ui.refresh.disabled = true;
    const current = ++generation;
    try {
      const reply = recoveryReplySchema.parse(await browser.runtime.sendMessage({
        type: RECOVERY_MESSAGE.refresh, expectedConnectionId: selection.connectionId, expectedSelectionId: selection.operationId,
      }));
      if (current !== generation) return;
      if (!reply.ok) throw new Error(reply.error);
      await load();
    } catch (error) {
      if (current !== generation) return;
      ui.status.textContent = error instanceof Error ? error.message : RECOVERY_TEXT.readFailed;
      ui.status.className = 'unverified';
      ui.refresh.disabled = !selection;
    }
  });
  browser.storage.onChanged.addListener((changes, area) => {
    if ((area === STORAGE_AREA.local && Object.keys(changes).some(key =>
      key.startsWith(DESTINATION_STORAGE_PREFIX)))
      || (area === STORAGE_AREA.session && AUTH_SESSION_KEY in changes)) void load();
  });
  browser.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
    if (sender.id !== browser.runtime.id || sender.tab !== undefined || !recoveryNotificationSchema.safeParse(message).success) return;
    void load();
    sendResponse({ ok: true });
  });
  void load();
}
