import { browser, type Browser } from 'wxt/browser';
import type { GithubService } from '../github/service';
import { AuthFault, type ConnectedSession } from '../github/schemas';
import { destinationApi, status } from './api';
import {
  DestinationFault, destinationRequestSchema, journalSchema,
  type DestinationJournal, type DestinationReply, type DestinationView, type Installation,
} from './schemas';

export function createDestinationService(github: GithubService) {
  let queue: Promise<unknown> = Promise.resolve();
  const storageReady = browser.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
  function key(userId: number) { return `destination-v1:${userId}`; }
  async function readJournal(userId: number): Promise<DestinationJournal | null> {
    await storageReady;
    const value: unknown = (await browser.storage.local.get(key(userId)))[key(userId)];
    if (value === undefined) return null;
    const parsed = journalSchema.safeParse(value);
    if (!parsed.success || parsed.data.userId !== userId) throw new DestinationFault('stored-data-invalid');
    return parsed.data;
  }
  async function save(journal: DestinationJournal) {
    const parsed = journalSchema.safeParse(journal);
    if (!parsed.success) throw new DestinationFault('stored-data-invalid');
    await browser.storage.local.set({ [key(journal.userId)]: parsed.data });
  }
  function choose(installations: Installation[], id: number, creating: boolean) {
    const installation = installations.find(item => item.id === id);
    if (!installation) throw new DestinationFault('installation-required');
    if (installation.permissions.contents !== 'write'
      || (creating && installation.permissions.administration !== 'write')) {
      throw new DestinationFault('permission-denied');
    }
    return installation;
  }
  function journalFor(session: ConnectedSession, installation: Installation, name: string): DestinationJournal {
    return {
      schemaVersion: 1, operationId: crypto.randomUUID(), userId: session.user.id,
      owner: session.user.login, name, clientId: session.clientId, connectionId: session.connectionId,
      installationId: installation.id, appId: installation.app_id, repositoryId: null,
      phase: 'creating', branch: null, verifiedAt: null, commitSha: null, initializationAuthorized: false,
    };
  }
  async function message(value: unknown, sender: Browser.runtime.MessageSender): Promise<DestinationReply> {
    if (sender.id !== browser.runtime.id || sender.url !== browser.runtime.getURL('/destination.html')
      || sender.frameId !== 0 || !sender.documentId || sender.tab?.id === undefined) {
      return { ok: false, error: 'invalid-input' };
    }
    const parsed = destinationRequestSchema.safeParse(value);
    if (!parsed.success) return { ok: false, error: 'invalid-input' };
    const input = parsed.data;
    const action = queue.then(() => github.withConnection(async (session, guard, signal): Promise<DestinationReply> => {
      if (input.type !== 'destination:load' && input.expectedConnectionId !== session.connectionId) {
        throw new DestinationFault('session-changed');
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
      if (input.type === 'destination:load') return { ok: true, view: view() };
      if (input.type === 'destination:discard') {
        await guard();
        await browser.storage.local.remove(key(user.id));
        journal = null;
        return { ok: true, view: view() };
      }

      if (input.type === 'destination:create') {
        if (journal && journal.phase !== 'ready') throw new DestinationFault('pending-operation');
        const installation = choose(installations, input.installationId, true);
        try {
          await api.repository(input.name);
          throw new DestinationFault('name-collision');
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
            throw new DestinationFault('repository-changed');
          }
          journal.repositoryId = created.id;
          journal.phase = 'created';
          await save(journal);
        } catch (error) {
          if ([401, 403, 422].includes(status(error) ?? 0)) {
            await browser.storage.local.remove(key(user.id));
            throw new DestinationFault(status(error) === 422 ? 'name-collision' : 'permission-denied');
          }
          throw new DestinationFault('creation-uncertain');
        }
      } else if (input.type === 'destination:connect') {
        const installation = choose(installations, input.installationId, false);
        const repo = await api.repository(input.name);
        await api.included(installation.id, repo.id);
        const isEmpty = await api.empty(input.name);
        let initializationAuthorized = isEmpty && input.initialize;
        if (isEmpty && !input.initialize) throw new DestinationFault('initialization-required');
        const selectedBranch = input.branch ?? repo.default_branch;
        if (!isEmpty) {
          await api.branch(input.name, selectedBranch);
          const marker = await api.marker(input.name, selectedBranch);
          const explicitRecovery = input.initialize && journal?.phase === 'creating'
            && journal.name === input.name && journal.clientId === session.clientId;
          if (!marker && !explicitRecovery) throw new DestinationFault('incompatible-repository');
          initializationAuthorized = !marker && explicitRecovery;
        } else if (input.branch && input.branch !== repo.default_branch) {
          throw new DestinationFault('branch-unavailable');
        }
        journal = {
          ...journalFor(session, installation, input.name),
          repositoryId: repo.id, phase: 'created', branch: isEmpty ? null : selectedBranch,
          initializationAuthorized,
        };
        await guard();
        await save(journal);
      }

      if (!journal) throw new DestinationFault('invalid-input');
      if (journal.clientId !== session.clientId || journal.owner !== user.login) {
        throw new DestinationFault('repository-changed');
      }
      const installation = choose(installations, journal.installationId, false);
      if (installation.app_id !== journal.appId) throw new DestinationFault('repository-changed');
      if (journal.repositoryId === null) throw new DestinationFault('creation-uncertain');
      let repo = await api.repository(journal.name);
      if (repo.id !== journal.repositoryId) throw new DestinationFault('repository-changed');
      await api.included(journal.installationId, repo.id);
      const isEmpty = await api.empty(journal.name);
      const selectedBranch = journal.branch ?? repo.default_branch;
      if (!isEmpty) await api.branch(journal.name, selectedBranch);
      let marker = isEmpty ? null : await api.marker(journal.name, selectedBranch);
      if (journal.phase === 'initializing') {
        if (!marker || marker.initializationId !== journal.operationId) {
          throw new DestinationFault('initialization-uncertain');
        }
      } else if (!marker) {
        if (journal.phase === 'ready' || !journal.initializationAuthorized) {
          throw new DestinationFault('incompatible-repository');
        }
        journal.phase = 'initializing';
        journal.branch = isEmpty ? null : selectedBranch;
        await guard();
        await save(journal);
        try {
          await api.initialize(journal.name, journal.branch, journal.operationId);
        } catch (error) {
          if ([400, 401, 403, 404, 409, 422].includes(status(error) ?? 0)) {
            journal.phase = 'initialization-rejected';
            await save(journal);
            throw new DestinationFault('initialization-rejected');
          }
          throw new DestinationFault('initialization-uncertain');
        }
        repo = await api.repository(journal.name);
        if (repo.id !== journal.repositoryId) throw new DestinationFault('repository-changed');
      }
      const branch = await api.branch(journal.name, journal.branch ?? repo.default_branch);
      marker = await api.marker(journal.name, branch.name);
      if (!marker) throw new DestinationFault('incompatible-repository');
      if (journal.phase === 'initializing' && marker.initializationId !== journal.operationId) {
        throw new DestinationFault('initialization-uncertain');
      }
      await api.included(journal.installationId, repo.id);
      journal = {
        ...journal, phase: 'ready', branch: branch.name, commitSha: branch.commit.sha,
        verifiedAt: new Date().toISOString(), connectionId: session.connectionId,
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
        return { ok: false, error: error.issue === 'not-connected' ? 'not-connected' : 'session-changed' };
      }
      if (status(error) === 401 || status(error) === 403) return { ok: false, error: 'permission-denied' };
      console.warn('Progress Sync: destination verification did not complete.');
      return { ok: false, error: 'network-error' };
    }
  }
  return { message };
}
