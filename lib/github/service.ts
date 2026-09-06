import { browser, type Browser } from 'wxt/browser';
import {
  AUTH_EXPIRY_ALARM, AUTH_SESSION_KEY, USER_URL, appConfigSchema, authRequestSchema,
  AuthFault, githubUserResponseSchema, sessionSchema,
  type AuthIssue, type AuthReply, type AuthSession, type AuthState, type ConnectedSession,
} from './schemas';
import { githubRequest } from './transport';

async function loadConfig(): Promise<{ clientId: string } | { issue: AuthIssue }> {
  let response: Response;
  try {
    response = await fetch(browser.runtime.getURL('/github-app.json'), { cache: 'no-store' });
  } catch {
    return { issue: 'configuration-unavailable' };
  }
  if (!response.ok) return { issue: 'configuration-unavailable' };
  let value: unknown;
  try {
    value = await response.json();
  } catch {
    return { issue: 'configuration-invalid' };
  }
  const parsed = appConfigSchema.safeParse(value);
  if (!parsed.success) return { issue: 'configuration-invalid' };
  return parsed.data.clientId === null
    ? { issue: 'configuration-required' } : { clientId: parsed.data.clientId };
}

function publicState(session: AuthSession): AuthState {
  if (session.status === 'authorizing') {
    return { status: session.status, attemptId: session.attemptId, clientId: session.clientId };
  }
  if (session.status === 'connected') {
    return {
      status: session.status, user: session.user,
      expiresAt: session.expiresAt, verifiedAt: session.verifiedAt,
    };
  }
  return session;
}

export function createGithubService() {
  const config = loadConfig();
  const requests = new Map<string, AbortController>();
  const ready = browser.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
  let queue: Promise<unknown> = ready;

  function serialize<T>(action: () => Promise<T>): Promise<T> {
    const result = queue.then(async () => {
      await ready;
      return action();
    });
    queue = result.catch(() => {
      console.error('Progress Sync: GitHub connection storage operation failed.');
    });
    return result;
  }

  async function store(session: AuthSession): Promise<void> {
    const parsed = sessionSchema.safeParse(session);
    if (!parsed.success) throw new AuthFault('invalid-session');
    if (session.status === 'connected') {
      await browser.alarms.create(AUTH_EXPIRY_ALARM, { when: Date.parse(session.expiresAt) });
    }
    await browser.storage.session.set({ [AUTH_SESSION_KEY]: parsed.data });
    if (session.status !== 'connected') await browser.alarms.clear(AUTH_EXPIRY_ALARM);
  }

  async function read(): Promise<AuthSession> {
    const value: unknown = (await browser.storage.session.get(AUTH_SESSION_KEY))[AUTH_SESSION_KEY];
    if (value === undefined) return { status: 'disconnected', issue: 'not-connected' };
    const parsed = sessionSchema.safeParse(value);
    if (!parsed.success) {
      const cleared = { status: 'disconnected', issue: 'invalid-session' } as const;
      await store(cleared);
      return cleared;
    }
    if (parsed.data.status === 'connected' && Date.parse(parsed.data.expiresAt) <= Date.now()) {
      const expired = { status: 'disconnected', issue: 'expired' } as const;
      await store(expired);
      return expired;
    }
    return parsed.data;
  }

  function owns(session: AuthSession, attemptId: string, sender: Browser.runtime.MessageSender) {
    return session.status === 'authorizing' && session.attemptId === attemptId
      && session.ownerTabId === sender.tab?.id && session.ownerDocumentId === sender.documentId;
  }

  async function state(): Promise<AuthState> {
    const settings = await config;
    const session = await read();
    if ('issue' in settings) {
      if (session.status !== 'disconnected') {
        await store({ status: 'disconnected', issue: settings.issue });
      }
      return { status: 'unavailable', issue: settings.issue };
    }
    if (session.status !== 'disconnected' && session.clientId !== settings.clientId) {
      const disconnected = { status: 'disconnected', issue: 'configuration-invalid' } as const;
      await store(disconnected);
      return disconnected;
    }
    return publicState(session);
  }

  async function verifyIdentity(token: string, signal: AbortSignal) {
    const request = githubRequest([USER_URL], signal);
    const response = await request('GET /user', { headers: { authorization: `token ${token}` } });
    const parsed = githubUserResponseSchema.safeParse(response.data);
    if (!parsed.success) throw new Error('GitHub identity response is invalid.');
    return parsed.data;
  }

  async function message(value: unknown, sender: Browser.runtime.MessageSender): Promise<AuthReply> {
    await ready;
    const connectionPage = sender.url === browser.runtime.getURL('/connect.html');
    const ownerTabId = sender.tab?.id;
    const ownerDocumentId = sender.documentId;
    const trusted = sender.id === browser.runtime.id && sender.frameId === 0
      && (connectionPage || sender.url === browser.runtime.getURL('/options.html'));
    if (!trusted || ownerTabId === undefined || ownerDocumentId === undefined) {
      return { ok: false, error: 'not-allowed' };
    }
    const parsed = authRequestSchema.safeParse(value);
    if (!parsed.success) return { ok: false, error: 'not-allowed' };
    const input = parsed.data;
    if (input.type === 'github:state') {
      return serialize(async () => ({ ok: true, state: await state() }));
    }
    if (input.type === 'github:disconnect') {
      return serialize(async () => {
        for (const controller of requests.values()) controller.abort();
        const disconnected = { status: 'disconnected', issue: 'not-connected' } as const;
        await store(disconnected);
        return { ok: true, state: disconnected };
      });
    }
    if (!connectionPage) return { ok: false, error: 'not-allowed' };
    if (input.type === 'github:begin') {
      return serialize(async () => {
        const settings = await config;
        if ('issue' in settings) return { ok: false, error: settings.issue };
        for (const controller of requests.values()) controller.abort();
        const pending: AuthSession = {
          status: 'authorizing', attemptId: input.attemptId, clientId: settings.clientId,
          ownerTabId, ownerDocumentId,
        };
        await store(pending);
        return { ok: true, state: publicState(pending) };
      });
    }
    if (input.type === 'github:permit' || input.type === 'github:cancel') {
      return serialize(async () => {
        const session = await read();
        if (!owns(session, input.attemptId, sender)) return { ok: false, error: 'not-allowed' };
        if (input.type === 'github:permit') return { ok: true, state: publicState(session) };
        requests.get(input.attemptId)?.abort();
        const cancelled = { status: 'disconnected', issue: input.issue } as const;
        await store(cancelled);
        return { ok: true, state: cancelled };
      });
    }
    if (input.type === 'github:check') {
      const previous = await serialize(read);
      if (previous.status !== 'connected') return { ok: false, error: 'not-allowed' };
      const controller = new AbortController();
      requests.set(previous.connectionId, controller);
      let user;
      try {
        user = await verifyIdentity(previous.token, controller.signal);
      } catch {
        return serialize(async () => {
          const latest = await read();
          if (latest.status === 'connected' && latest.connectionId === previous.connectionId) {
            await store({ status: 'disconnected', issue: 'identity-failed' });
          }
          return { ok: false, error: 'identity-failed' };
        });
      } finally {
        requests.delete(previous.connectionId);
      }
      return serialize(async () => {
        const latest = await read();
        if (latest.status !== 'connected' || latest.connectionId !== previous.connectionId) {
          return { ok: false, error: 'not-allowed' };
        }
        if (user.id !== latest.user.id) {
          await store({ status: 'disconnected', issue: 'identity-failed' });
          return { ok: false, error: 'identity-failed' };
        }
        const verified = { ...latest, user, verifiedAt: new Date().toISOString() };
        await store(verified);
        return { ok: true, state: publicState(verified) };
      });
    }
    const previous = await serialize(read);
    if (!owns(previous, input.attemptId, sender) || previous.status !== 'authorizing') {
      return { ok: false, error: 'not-allowed' };
    }
    if (Date.parse(input.credentials.expiresAt) <= Date.now()) {
      return { ok: false, error: 'expired' };
    }
    const controller = new AbortController();
    requests.set(input.attemptId, controller);
    let user;
    try {
      user = await verifyIdentity(input.credentials.token, controller.signal);
    } catch {
      return serialize(async () => {
        const latest = await read();
        if (owns(latest, input.attemptId, sender)) {
          await store({ status: 'disconnected', issue: 'identity-failed' });
        }
        return { ok: false, error: 'identity-failed' };
      });
    } finally {
      requests.delete(input.attemptId);
    }
    return serialize(async () => {
      const latest = await read();
      if (!owns(latest, input.attemptId, sender) || controller.signal.aborted) {
        return { ok: false, error: 'not-allowed' };
      }
      if (Date.parse(input.credentials.expiresAt) <= Date.now()) return { ok: false, error: 'expired' };
      const connected: AuthSession = {
        status: 'connected', connectionId: input.attemptId, clientId: previous.clientId,
        ...input.credentials, user, verifiedAt: new Date().toISOString(),
      };
      await store(connected);
      return { ok: true, state: publicState(connected) };
    });
  }

  function ownerClosed(tabId: number): void {
    void serialize(async () => {
      const session = await read();
      if (session.status === 'authorizing' && session.ownerTabId === tabId) {
        requests.get(session.attemptId)?.abort();
        await store({ status: 'disconnected', issue: 'interrupted' });
      }
    }).catch(() => console.error('Progress Sync: GitHub authorization interruption could not be recorded.'));
  }

  function alarm(name: string): void {
    if (name === AUTH_EXPIRY_ALARM) {
      void serialize(read).catch(() => console.error('Progress Sync: GitHub session expiry could not be checked.'));
    }
  }
  async function withConnection<T>(
    action: (session: ConnectedSession, guard: () => Promise<void>, signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const session: ConnectedSession = await serialize(async () => {
      await state();
      const current = await read();
      if (current.status !== 'connected') throw new AuthFault('not-connected');
      return current;
    });
    const controller = new AbortController();
    const requestId = crypto.randomUUID();
    requests.set(requestId, controller);
    async function guard(): Promise<void> {
      controller.signal.throwIfAborted();
      const latest = await serialize(read);
      if (latest.status !== 'connected' || latest.connectionId !== session.connectionId
        || latest.user.id !== session.user.id || latest.clientId !== session.clientId) {
        throw new AuthFault('not-allowed');
      }
      controller.signal.throwIfAborted();
    }
    try {
      await guard();
      return await action(session, guard, controller.signal);
    } finally {
      requests.delete(requestId);
    }
  }
  return { message, ownerClosed, alarm, withConnection };
}

export type GithubService = ReturnType<typeof createGithubService>;
