import { browser, type Browser } from 'wxt/browser';
import { EXTENSION_PAGE } from '../constants/browser';
import { DESTINATION_ISSUE } from '../constants/destination';
import { AUTH_ISSUE } from '../constants/github';
import { RECOVERY_MESSAGE, RECOVERY_STATUS, RECOVERY_TEXT } from '../constants/recovery';
import type { GithubService } from '../github/service';
import { AuthFault } from '../github/schemas';
import type { DestinationService } from '../destination/service';
import { DestinationFault } from '../destination/schemas';
import {
  RecoveryFault, recoveryRequestSchema, type RecoveryReply, type RecoveryState,
} from './schemas';
import { recoverProgress } from './api';
import { readRecoveryCache, recoveryCacheKey, writeRecoveryCache } from './cache';

function errorMessage(error: unknown, aborted = false): string {
  if (error instanceof RecoveryFault || error instanceof DestinationFault) return error.message;
  return error instanceof AuthFault || aborted ? RECOVERY_TEXT.sessionChanged : RECOVERY_TEXT.readFailed;
}

export function createRecoveryService(github: GithubService, destination: DestinationService) {
  let generation = 0;
  let activeKey: string | null = null;
  let writes: Promise<unknown> = Promise.resolve();
  async function notify(): Promise<void> {
    try {
      await browser.runtime.sendMessage({ type: RECOVERY_MESSAGE.changed });
    } catch {
      console.warn(RECOVERY_TEXT.notificationFailed);
    }
  }
  function save(state: RecoveryState, current: number, guard?: () => Promise<void>) {
    const action = writes.then(async () => {
      if (guard) await guard();
      if (current !== generation) throw new RecoveryFault(RECOVERY_TEXT.sessionChanged);
      await writeRecoveryCache(state);
      await notify();
    });
    writes = action.then(() => undefined, () => undefined);
    return action;
  }
  async function restore(expected?: { expectedConnectionId: string; expectedSelectionId: string }) {
    return github.withConnection(async (session, sessionGuard, signal) => {
      const target = await destination.selection(session);
      if (expected && (expected.expectedConnectionId !== target.connectionId || expected.expectedSelectionId !== target.operationId)) {
        throw new RecoveryFault(RECOVERY_TEXT.sessionChanged);
      }
      const current = ++generation;
      async function guard() {
        await sessionGuard();
        await destination.guardSelection(session, target);
        if (current !== generation) throw new RecoveryFault(RECOVERY_TEXT.sessionChanged);
      }
      activeKey = recoveryCacheKey(target);
      let prior: RecoveryState | null = null;
      let state: RecoveryState | null = null;
      try {
        prior = await readRecoveryCache(target);
        state = {
          schemaVersion: 1, target, status: RECOVERY_STATUS.loading, snapshot: prior?.snapshot ?? null, error: null,
        };
        await save(state, current, guard);
        const snapshot = await recoverProgress(target, session, guard, signal);
        state = { ...state, status: RECOVERY_STATUS.ready, snapshot };
        await save(state, current, guard);
      } catch (error) {
        if (current === generation && state) {
          state = {
            ...state, status: RECOVERY_STATUS.failed, snapshot: prior?.snapshot ?? null,
            error: errorMessage(error, signal.aborted),
          };
          await save(state, current);
        }
        await destination.pauseAfterFailure(target, error);
        if (signal.aborted) throw new RecoveryFault(errorMessage(error, true));
        throw error;
      } finally {
        if (current === generation) activeKey = null;
      }
    });
  }
  async function selected(): Promise<void> {
    try {
      await restore();
    } catch {
      console.warn(RECOVERY_TEXT.operationFailed);
    }
  }
  async function view(): Promise<RecoveryReply> {
    try {
      return await github.withConnection(async (session, guard) => {
        const target = await destination.selection(session);
        await guard();
        return { ok: true, selection: target, active: activeKey === recoveryCacheKey(target) };
      });
    } catch (error) {
      if ((error instanceof AuthFault && error.issue === AUTH_ISSUE.notConnected)
        || (error instanceof DestinationFault && error.issue === DESTINATION_ISSUE.selectionRequired)) {
        return { ok: true, selection: null, active: false };
      }
      throw error;
    }
  }
  async function message(value: unknown, sender: Browser.runtime.MessageSender): Promise<RecoveryReply> {
    if (sender.id !== browser.runtime.id || sender.url !== browser.runtime.getURL(EXTENSION_PAGE.options)
      || sender.frameId !== 0 || !sender.documentId || sender.tab?.id === undefined) {
      return { ok: false, error: RECOVERY_TEXT.invalidInput };
    }
    const parsed = recoveryRequestSchema.safeParse(value);
    if (!parsed.success) return { ok: false, error: RECOVERY_TEXT.invalidInput };
    try {
      switch (parsed.data.type) {
        case RECOVERY_MESSAGE.list:
          return await view();
        case RECOVERY_MESSAGE.refresh:
          await restore(parsed.data);
          return await view();
      }
    } catch (error) {
      return { ok: false, error: errorMessage(error) };
    }
  }
  return { message, selected };
}
