import { EXTENSION_PAGE, STORAGE_ACCESS } from '../constants/browser';
import {
  DESTINATION_ISSUE, DESTINATION_MESSAGE, DESTINATION_PHASE, DESTINATION_STORAGE_PREFIX,
  DESTINATION_TEXT,
} from '../constants/destination';
import { AUTH_ISSUE, GITHUB_PERMISSION } from '../constants/github';
import { browser, type Browser } from 'wxt/browser';
import type { GithubService } from '../github/service';
import { AuthFault, type ConnectedSession } from '../github/schemas';
import { destinationApi, status } from './api';
import {
  DestinationFault, destinationRequestSchema, journalSchema, type DestinationJournal,
  type DestinationReply, type DestinationView, type Installation,
} from './schemas';

export function createDestinationService(github: GithubService) {
  let queue: Promise<unknown> = Promise.resolve();
  const storageReady = browser.storage.local.setAccessLevel({ accessLevel: STORAGE_ACCESS.trustedContexts });
  function key(userId: number) { return `${DESTINATION_STORAGE_PREFIX}${userId}`; }
  async function readJournal(userId: number): Promise<DestinationJournal | null> {
    await storageReady;
    const value: unknown = (await browser.storage.local.get(key(userId)))[key(userId)];
    if (value === undefined) return null;
    const parsed = journalSchema.safeParse(value);
    if (!parsed.success || parsed.data.userId !== userId) throw new DestinationFault(DESTINATION_ISSUE.storedDataInvalid);
    return parsed.data;
  }
  async function save(journal: DestinationJournal) {
    const parsed = journalSchema.safeParse(journal);
    if (!parsed.success) throw new DestinationFault(DESTINATION_ISSUE.storedDataInvalid);
    await browser.storage.local.set({ [key(journal.userId)]: parsed.data });
  }
  function choose(installations: Installation[], id: number, creating: boolean) {
    const installation = installations.find(item => item.id === id);
    if (!installation) throw new DestinationFault(DESTINATION_ISSUE.installationRequired);
    if (installation.permissions.contents !== GITHUB_PERMISSION.write
      || (creating && installation.permissions.administration !== GITHUB_PERMISSION.write)) {
      throw new DestinationFault(DESTINATION_ISSUE.permissionDenied);
    }
    return installation;
  }
  function journalFor(session: ConnectedSession, installation: Installation, name: string): DestinationJournal {
    return {
      schemaVersion: 1, operationId: crypto.randomUUID(), userId: session.user.id,
      owner: session.user.login, name, clientId: session.clientId, connectionId: session.connectionId,
      installationId: installation.id, appId: installation.app_id, repositoryId: null,
      phase: DESTINATION_PHASE.creating, branch: null, verifiedAt: null, commitSha: null, initializationAuthorized: false,
    };
  }
  async function message(value: unknown, sender: Browser.runtime.MessageSender): Promise<DestinationReply> {
    if (sender.id !== browser.runtime.id || sender.url !== browser.runtime.getURL(EXTENSION_PAGE.destination)
      || sender.frameId !== 0 || !sender.documentId || sender.tab?.id === undefined) {
      return { ok: false, error: DESTINATION_ISSUE.invalidInput };
    }
    const parsed = destinationRequestSchema.safeParse(value);
    if (!parsed.success) return { ok: false, error: DESTINATION_ISSUE.invalidInput };
    const input = parsed.data;
    const action = queue.then(() => github.withConnection(async (session, guard, signal): Promise<DestinationReply> => {
      if (input.type !== DESTINATION_MESSAGE.load && input.expectedConnectionId !== session.connectionId) {
        throw new DestinationFault(DESTINATION_ISSUE.sessionChanged);
      }
      const api = destinationApi(session, guard, signal);
      const user = await api.identity();
      const installations = await api.installations();
      let journal = await readJournal(user.id);
      const view = (verified = false): DestinationView => ({
        user, connectionId: session.connectionId,
        installations: installations.map(item => ({ id: item.id, appId: item.app_id, selection: item.repository_selection })),
        journal, verified,
      });
      switch (input.type) {
        case DESTINATION_MESSAGE.load:
          return { ok: true, view: view() };
        case DESTINATION_MESSAGE.discard: {
          await guard();
          await browser.storage.local.remove(key(user.id));
          journal = null;
          return { ok: true, view: view() };
        }
        case DESTINATION_MESSAGE.create: {
          if (journal && journal.phase !== DESTINATION_PHASE.ready) throw new DestinationFault(DESTINATION_ISSUE.pendingOperation);
          const installation = choose(installations, input.installationId, true);
          try {
            await api.repository(input.name);
            throw new DestinationFault(DESTINATION_ISSUE.nameCollision);
          } catch (error) {
            if (status(error) !== 404) throw error;
          }
          journal = journalFor(session, installation, input.name);
          journal.initializationAuthorized = true;
          await guard();
          // Persist intent before a write: worker termination must not turn a lost response into a retry.
          await save(journal);
          try {
            const created = await api.create(input.name);
            if (created.owner.id !== user.id || created.name !== input.name || created.private) {
              throw new DestinationFault(DESTINATION_ISSUE.repositoryChanged);
            }
            journal.repositoryId = created.id;
            journal.phase = DESTINATION_PHASE.created;
            await save(journal);
          } catch (error) {
            if ([401, 403, 422].includes(status(error) ?? 0)) {
              await browser.storage.local.remove(key(user.id));
              throw new DestinationFault(status(error) === 422 ? DESTINATION_ISSUE.nameCollision : DESTINATION_ISSUE.permissionDenied);
            }
            throw new DestinationFault(DESTINATION_ISSUE.creationUncertain);
          }
          break;
        }
        case DESTINATION_MESSAGE.connect: {
          const installation = choose(installations, input.installationId, false);
          const repo = await api.repository(input.name);
          await api.included(installation.id, repo.id);
          const isEmpty = await api.empty(input.name);
          let initializationAuthorized = isEmpty && input.initialize;
          if (isEmpty && !input.initialize) throw new DestinationFault(DESTINATION_ISSUE.initializationRequired);
          const selectedBranch = input.branch ?? repo.default_branch;
          if (!isEmpty) {
            await api.branch(input.name, selectedBranch);
            const marker = await api.marker(input.name, selectedBranch);
            const explicitRecovery = input.initialize && journal?.phase === DESTINATION_PHASE.creating
              && journal.name === input.name && journal.clientId === session.clientId;
            if (!marker && !explicitRecovery) throw new DestinationFault(DESTINATION_ISSUE.incompatibleRepository);
            initializationAuthorized = !marker && explicitRecovery;
          } else if (input.branch && input.branch !== repo.default_branch) {
            throw new DestinationFault(DESTINATION_ISSUE.branchUnavailable);
          }
          journal = {
            ...journalFor(session, installation, input.name),
            repositoryId: repo.id, phase: DESTINATION_PHASE.created, branch: isEmpty ? null : selectedBranch,
            initializationAuthorized,
          };
          await guard();
          await save(journal);
          break;
        }
        case DESTINATION_MESSAGE.verify:
          break;
      }

      if (!journal) throw new DestinationFault(DESTINATION_ISSUE.invalidInput);
      if (journal.clientId !== session.clientId || journal.owner !== user.login) {
        throw new DestinationFault(DESTINATION_ISSUE.repositoryChanged);
      }
      const installation = choose(installations, journal.installationId, false);
      if (installation.app_id !== journal.appId) throw new DestinationFault(DESTINATION_ISSUE.repositoryChanged);
      if (journal.repositoryId === null) throw new DestinationFault(DESTINATION_ISSUE.creationUncertain);
      let repo = await api.repository(journal.name);
      if (repo.id !== journal.repositoryId) throw new DestinationFault(DESTINATION_ISSUE.repositoryChanged);
      await api.included(journal.installationId, repo.id);
      const isEmpty = await api.empty(journal.name);
      const selectedBranch = journal.branch ?? repo.default_branch;
      if (!isEmpty) await api.branch(journal.name, selectedBranch);
      let marker = isEmpty ? null : await api.marker(journal.name, selectedBranch);
      if (journal.phase === DESTINATION_PHASE.initializing) {
        if (!marker || marker.initializationId !== journal.operationId) {
          throw new DestinationFault(DESTINATION_ISSUE.initializationUncertain);
        }
      } else if (!marker) {
        if (journal.phase === DESTINATION_PHASE.ready || !journal.initializationAuthorized) {
          throw new DestinationFault(DESTINATION_ISSUE.incompatibleRepository);
        }
        journal.phase = DESTINATION_PHASE.initializing;
        journal.branch = isEmpty ? null : selectedBranch;
        await guard();
        await save(journal);
        try {
          await api.initialize(journal.name, journal.branch, journal.operationId);
        } catch (error) {
          if ([400, 401, 403, 404, 409, 422].includes(status(error) ?? 0)) {
            journal.phase = DESTINATION_PHASE.initializationRejected;
            await save(journal);
            throw new DestinationFault(DESTINATION_ISSUE.initializationRejected);
          }
          throw new DestinationFault(DESTINATION_ISSUE.initializationUncertain);
        }
        repo = await api.repository(journal.name);
        if (repo.id !== journal.repositoryId) throw new DestinationFault(DESTINATION_ISSUE.repositoryChanged);
      }
      const branch = await api.branch(journal.name, journal.branch ?? repo.default_branch);
      marker = await api.marker(journal.name, branch.name);
      if (!marker) throw new DestinationFault(DESTINATION_ISSUE.incompatibleRepository);
      if (journal.phase === DESTINATION_PHASE.initializing && marker.initializationId !== journal.operationId) {
        throw new DestinationFault(DESTINATION_ISSUE.initializationUncertain);
      }
      await api.included(journal.installationId, repo.id);
      const verifiedAt = new Date().toISOString();
      const selectedAt = journal.phase === DESTINATION_PHASE.ready && journal.connectionId === session.connectionId
        ? journal.selectedAt ?? journal.verifiedAt ?? verifiedAt : verifiedAt;
      journal = {
        ...journal, phase: DESTINATION_PHASE.ready, branch: branch.name, commitSha: branch.commit.sha,
        verifiedAt, selectedAt, connectionId: session.connectionId,
      };
      await guard();
      await save(journal);
      return { ok: true, view: view(true) };
    }));
    queue = action.then(() => undefined, () => undefined);
    try {
      return await action;
    } catch (error) {
      if (error instanceof DestinationFault) return { ok: false, error: error.issue };
      if (error instanceof AuthFault) {
        return { ok: false, error: error.issue === AUTH_ISSUE.notConnected ? DESTINATION_ISSUE.notConnected : DESTINATION_ISSUE.sessionChanged };
      }
      if (status(error) === 401 || status(error) === 403) return { ok: false, error: DESTINATION_ISSUE.permissionDenied };
      console.warn(DESTINATION_TEXT.verificationIncomplete);
      return { ok: false, error: DESTINATION_ISSUE.networkError };
    }
  }
  return { message, readJournal };
}

export type DestinationService = ReturnType<typeof createDestinationService>;
