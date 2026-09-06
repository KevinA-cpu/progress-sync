import { browser, type Browser } from 'wxt/browser';
import { EXTENSION_PAGE, STORAGE_ACCESS } from '../constants/browser';
import { DESTINATION_ISSUE } from '../constants/destination';
import { AUTH_ISSUE } from '../constants/github';
import { RECOVERY_MESSAGE, RECOVERY_STATUS, RECOVERY_STORAGE_PREFIX, RECOVERY_TEXT } from '../constants/recovery';
import type { GithubService } from '../github/service';
import { AuthFault } from '../github/schemas';
import type { DestinationService } from '../destination/service';
import { DestinationFault, type DestinationTarget } from '../destination/schemas';
import {
  parseRecovery, RecoveryFault, recoveryRequestSchema, recoveryStateSchema, type RecoveryReply, type RecoveryState,
} from './schemas';
import { recoverProgress } from './api';

export function createRecoveryService(github: GithubService, destination: DestinationService) {
  const ready = browser.storage.local.setAccessLevel({ accessLevel: STORAGE_ACCESS.trustedContexts });
  let generation = 0;
  let activeKey: string | null = null;
  let writes: Promise<unknown> = ready;
  function key(target: DestinationTarget) {
    return RECOVERY_STORAGE_PREFIX + JSON.stringify([
      target.userId, target.clientId, target.installationId, target.appId, target.repositoryId, target.branch,
    ]);
  }
  async function read(target: DestinationTarget): Promise<RecoveryState | null> {
    await ready;
    const value: unknown = (await browser.storage.local.get(key(target)))[key(target)];
    if (value === undefined) return null;
    const state = parseRecovery(value, recoveryStateSchema, RECOVERY_TEXT.storedInvalid);
    if (key(state.target) !== key(target)) throw new RecoveryFault(RECOVERY_TEXT.storedInvalid);
    return state.status === RECOVERY_STATUS.loading && activeKey !== key(target)
      ? { ...state, status: RECOVERY_STATUS.failed, error: RECOVERY_TEXT.interrupted } : state;
  }
  function save(state: RecoveryState, current: number, guard?: () => Promise<void>) {
    const action = writes.then(async () => {
      if (guard) await guard();
      if (current !== generation) throw new RecoveryFault(RECOVERY_TEXT.sessionChanged);
      await browser.storage.local.set({
        [key(state.target)]: parseRecovery(state, recoveryStateSchema, RECOVERY_TEXT.storedInvalid),
      });
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
      activeKey = key(target);
      let prior: RecoveryState | null = null;
      let state: RecoveryState | null = null;
      try {
        prior = await read(target);
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
            error: error instanceof RecoveryFault || error instanceof DestinationFault ? error.message
              : error instanceof AuthFault || signal.aborted ? RECOVERY_TEXT.sessionChanged : RECOVERY_TEXT.readFailed,
          };
          await save(state, current);
        }
        throw error;
      } finally {
        if (current === generation) activeKey = null;
      }
    });
  }
  function selected(): void {
    void restore().catch(() => { console.warn(RECOVERY_TEXT.operationFailed); });
  }
  async function view(): Promise<RecoveryReply> {
    try {
      return await github.withConnection(async (session, guard) => {
        const target = await destination.selection(session);
        const state = await read(target);
        await guard();
        return { ok: true, selection: target, state };
      });
    } catch (error) {
      if ((error instanceof AuthFault && error.issue === AUTH_ISSUE.notConnected)
        || (error instanceof DestinationFault && error.issue === DESTINATION_ISSUE.selectionRequired)) {
        return { ok: true, selection: null, state: null };
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
      return { ok: false, error: error instanceof RecoveryFault || error instanceof DestinationFault ? error.message
        : error instanceof AuthFault ? RECOVERY_TEXT.sessionChanged : RECOVERY_TEXT.readFailed };
    }
  }
  return { message, selected };
}
