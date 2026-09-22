import { EXTENSION_PAGE, FETCH_POLICY, STORAGE_ACCESS } from '../constants/browser';
import {
  AUTH_EXPIRY_ALARM, AUTH_ISSUE, AUTH_MESSAGE, AUTH_RESTORE_ALARM, AUTH_RESTORE_RETRY, AUTH_SESSION_KEY,
  AUTH_STATUS, AUTH_TEXT, GITHUB_HTTP_STATUS,
} from '../constants/github';
import { browser, type Browser } from 'wxt/browser';
import {
  appConfigSchema, authRequestSchema, AuthFault, githubUserResponseSchema, sessionSchema,
  type AuthIssue, type AuthReply, type AuthSession, type AuthState, type ConnectedSession,
  type RememberedConnection, type RememberView,
} from './schemas';
import { REMEMBER_OFF, rememberStore } from './remember';
import { githubRest } from './rest';
import { githubResponseStatus, GithubWriteRejected } from './errors';

// A restored connection may only resume queued work once the originally selected destination has been
// revalidated read-only. The caller reports what it found; nothing here substitutes a different target.
export const RESTORE_AUTHORITY = { authorized: 'authorized', unauthorized: 'unauthorized', unavailable: 'unavailable' } as const;
export type RestoreAuthority = (typeof RESTORE_AUTHORITY)[keyof typeof RESTORE_AUTHORITY];
export type RestoreHooks = {
  // Read-only revalidation of the destination this connection had already selected. `current` answers whether
  // the restore that asked is still the one in progress, so a late answer about a withdrawn connection cannot
  // change anything for a session that has replaced it.
  authorize: (session: ConnectedSession, current: () => Promise<boolean>) => Promise<RestoreAuthority>;
  // Called only when a later retry succeeds; the first call reports the outcome to its caller instead.
  resumed: () => void;
};

async function loadConfig(): Promise<{ clientId: string } | { issue: AuthIssue }> {
  let response: Response;
  try {
    response = await fetch(browser.runtime.getURL(EXTENSION_PAGE.githubAppConfig), { cache: FETCH_POLICY.cache });
  } catch {
    return { issue: AUTH_ISSUE.configurationUnavailable };
  }
  if (!response.ok) return { issue: AUTH_ISSUE.configurationUnavailable };
  let value: unknown;
  try {
    value = await response.json();
  } catch {
    return { issue: AUTH_ISSUE.configurationInvalid };
  }
  const parsed = appConfigSchema.safeParse(value);
  if (!parsed.success) return { issue: AUTH_ISSUE.configurationInvalid };
  return parsed.data.clientId === null
    ? { issue: AUTH_ISSUE.configurationRequired } : { clientId: parsed.data.clientId };
}

function publicState(session: AuthSession): AuthState {
  switch (session.status) {
    case AUTH_STATUS.authorizing:
      return { status: session.status, attemptId: session.attemptId, clientId: session.clientId };
    case AUTH_STATUS.connected:
      return {
        status: session.status, user: session.user,
        expiresAt: session.expiresAt, verifiedAt: session.verifiedAt,
      };
    case AUTH_STATUS.disconnected:
      return session;
  }
}

export function createGithubService() {
  const config = loadConfig();
  const requests = new Map<string, AbortController>();
  const ready = browser.storage.session.setAccessLevel({ accessLevel: STORAGE_ACCESS.trustedContexts });
  let queue: Promise<unknown> = ready;
  const remember = rememberStore();
  // Bumped whenever the remembered credential is withdrawn, so a restore already in flight cannot reinstate it.
  let rememberGeneration = 0;
  let rememberIssue: AuthIssue | null = null;
  let restoreAttempts = 0;
  let restoring: Promise<boolean> | null = null;
  let hooks: RestoreHooks | null = null;

  // Unreadable remembered data keeps its own issue so it is not reported as a device that cannot store one.
  function rememberFault(error: unknown): AuthIssue {
    return error instanceof AuthFault && error.issue === AUTH_ISSUE.rememberUnreadable
      ? error.issue : AUTH_ISSUE.rememberUnavailable;
  }

  function serialize<T>(action: () => Promise<T>): Promise<T> {
    const result = queue.then(async () => {
      await ready;
      return action();
    });
    queue = result.catch(() => {
      console.error(AUTH_TEXT.storageFailed);
    });
    return result;
  }

  async function store(session: AuthSession): Promise<void> {
    const parsed = sessionSchema.safeParse(session);
    if (!parsed.success) throw new AuthFault(AUTH_ISSUE.invalidSession);
    if (session.status === AUTH_STATUS.connected) {
      await browser.alarms.create(AUTH_EXPIRY_ALARM, { when: Date.parse(session.expiresAt) });
    }
    await browser.storage.session.set({ [AUTH_SESSION_KEY]: parsed.data });
    if (session.status !== AUTH_STATUS.connected) await browser.alarms.clear(AUTH_EXPIRY_ALARM);
  }

  // Withdrawing the remembered credential is always safe to repeat and never blocks the session change itself.
  // It reports whether the withdrawal actually holds: if the stored credential cannot be removed, the recorded
  // preference is turned off instead, which is what a later start reads before it would restore anything. Only
  // when neither can be written does this return false, and the caller then says so rather than replying as if
  // the connection had been safely forgotten.
  async function forgetRemembered(issue: AuthIssue | null): Promise<boolean> {
    rememberGeneration++;
    restoreAttempts = 0;
    rememberIssue = issue;
    try {
      await remember.forget();
      await browser.alarms.clear(AUTH_RESTORE_ALARM);
      return true;
    } catch {
      rememberIssue = AUTH_ISSUE.rememberUnavailable;
      console.error(AUTH_TEXT.rememberFailed);
    }
    try {
      await remember.setPreference(REMEMBER_OFF);
      await browser.alarms.clear(AUTH_RESTORE_ALARM);
      return true;
    } catch {
      return false;
    }
  }

  // Keeping a connection is a separate, best-effort step: a storage failure is surfaced, not turned into a
  // failed connection, and never silently leaves a stale credential behind.
  async function keepRemembered(session: ConnectedSession): Promise<void> {
    const generation = rememberGeneration;
    try {
      if (!(await remember.preference()).enabled) return;
      if (generation !== rememberGeneration) return;
      await remember.keep({
        schemaVersion: 1, connectionId: session.connectionId, clientId: session.clientId, token: session.token,
        expiresAt: session.expiresAt, rememberedAt: new Date().toISOString(), user: session.user,
      });
      if (generation !== rememberGeneration) await remember.forget();
      else rememberIssue = null;
    } catch (error) {
      rememberIssue = rememberFault(error);
      console.error(AUTH_TEXT.rememberFailed);
      // Unreadable data is left for the user to see and replace; any other failure may have written a partial or
      // stale credential, which is cleared.
      if (rememberIssue !== AUTH_ISSUE.rememberUnreadable) await remember.forget().catch(() => undefined);
    }
  }

  async function rememberView(): Promise<RememberView> {
    let preference = REMEMBER_OFF;
    let kept: RememberedConnection | null = null;
    try {
      preference = await remember.preference();
    } catch (error) {
      return { enabled: false, stored: false, expiresAt: null, issue: rememberFault(error) };
    }
    try {
      kept = await remember.credential();
    } catch (error) {
      // Something is stored; it just cannot be used. Saying nothing is saved would be the wrong reassurance.
      return { enabled: preference.enabled, stored: true, expiresAt: null, issue: rememberFault(error) };
    }
    return {
      enabled: preference.enabled, stored: kept !== null, expiresAt: kept?.expiresAt ?? null, issue: rememberIssue,
    };
  }

  // A transient failure keeps the credential and comes back later; it is never treated as a revocation.
  async function deferRestore(issue: AuthIssue): Promise<void> {
    rememberIssue = issue;
    restoreAttempts++;
    if (restoreAttempts >= AUTH_RESTORE_RETRY.maxAttempts) return;
    await browser.alarms.create(AUTH_RESTORE_ALARM, { when: Date.now() + AUTH_RESTORE_RETRY.delayMs });
  }

  async function read(): Promise<AuthSession> {
    const value: unknown = (await browser.storage.session.get(AUTH_SESSION_KEY))[AUTH_SESSION_KEY];
    if (value === undefined) return { status: AUTH_STATUS.disconnected, issue: AUTH_ISSUE.notConnected };
    const parsed = sessionSchema.safeParse(value);
    if (!parsed.success) {
      const cleared = { status: AUTH_STATUS.disconnected, issue: AUTH_ISSUE.invalidSession } as const;
      await store(cleared);
      return cleared;
    }
    if (parsed.data.status === AUTH_STATUS.connected && Date.parse(parsed.data.expiresAt) <= Date.now()) {
      const expired = { status: AUTH_STATUS.disconnected, issue: AUTH_ISSUE.expired } as const;
      await store(expired);
      await forgetRemembered(AUTH_ISSUE.expired);
      return expired;
    }
    return parsed.data;
  }

  function owns(session: AuthSession, attemptId: string, sender: Browser.runtime.MessageSender) {
    return session.status === AUTH_STATUS.authorizing && session.attemptId === attemptId
      && session.ownerTabId === sender.tab?.id && session.ownerDocumentId === sender.documentId;
  }

  async function state(): Promise<AuthState> {
    const settings = await config;
    const session = await read();
    if ('issue' in settings) {
      if (session.status !== AUTH_STATUS.disconnected) {
        await store({ status: AUTH_STATUS.disconnected, issue: settings.issue });
      }
      return { status: AUTH_STATUS.unavailable, issue: settings.issue };
    }
    if (session.status !== AUTH_STATUS.disconnected && session.clientId !== settings.clientId) {
      const disconnected = { status: AUTH_STATUS.disconnected, issue: AUTH_ISSUE.configurationInvalid } as const;
      await store(disconnected);
      await forgetRemembered(AUTH_ISSUE.configurationInvalid);
      return disconnected;
    }
    return publicState(session);
  }

  async function verifyIdentity(token: string, signal: AbortSignal) {
    const octokit = githubRest(token, signal);
    const response = await octokit.rest.users.getAuthenticated();
    const parsed = githubUserResponseSchema.safeParse(response.data);
    if (!parsed.success) throw new Error(AUTH_TEXT.invalidIdentity);
    return parsed.data;
  }

  // Reads the remembered credential and, only if the original client configuration, the original account and the
  // originally selected destination all still check out, installs it as the session. Every failure path either
  // withdraws the credential (revoked, expired, wrong client, wrong account) or keeps it for a bounded retry
  // (network, rate limiting, destination temporarily unreadable). Nothing here picks a different destination.
  async function attemptRestore(check: RestoreHooks): Promise<boolean> {
    const generation = rememberGeneration;
    let kept;
    try {
      kept = await serialize(async () => {
        const current = await read();
        if (current.status !== AUTH_STATUS.disconnected) return null;
        if (!(await remember.preference()).enabled) {
          // A credential left behind by a removal that failed is disabled by the preference above, and this is
          // the next chance to actually get rid of it.
          await remember.forget().catch(() => undefined);
          return null;
        }
        return remember.credential();
      });
    } catch (error) {
      rememberIssue = rememberFault(error);
      console.error(AUTH_TEXT.restoreFailed);
      return false;
    }
    if (kept === null) return false;
    const credential = kept;
    const controller = new AbortController();
    // True only while this restore is still the one the stored state is waiting on: the same generation, the
    // same stored credential, nothing aborted, and no session installed since it started.
    async function currentUnlocked(): Promise<boolean> {
      if (generation !== rememberGeneration || controller.signal.aborted) return false;
      if ((await read()).status !== AUTH_STATUS.disconnected) return false;
      let still: RememberedConnection | null;
      try {
        still = await remember.credential();
      } catch {
        return false;
      }
      return still !== null && still.token === credential.token
        && still.connectionId === credential.connectionId;
    }
    function current(): Promise<boolean> {
      return serialize(currentUnlocked);
    }
    // A restore runs with no page waiting for a reply, so its outcome is recorded as the connection state. Every
    // effect it has - withdrawing the credential, scheduling a retry, writing the issue - belongs to the
    // credential it started with. If the user disconnected, turned remembering off, or signed in again while
    // this was in flight, the whole conclusion is discarded: nothing is deleted, nothing is retried, and no
    // newer session's state is written over.
    async function failed(issue: AuthIssue, terminal: boolean): Promise<false> {
      await serialize(async () => {
        if (!await currentUnlocked()) return;
        if (terminal) await forgetRemembered(issue);
        else await deferRestore(issue);
        const latest = await read();
        if (latest.status === AUTH_STATUS.disconnected && latest.issue !== issue) {
          await store({ status: AUTH_STATUS.disconnected, issue });
        }
      });
      return false;
    }
    const settings = await config;
    if ('issue' in settings) {
      return settings.issue === AUTH_ISSUE.configurationUnavailable
        ? failed(AUTH_ISSUE.restoreIncomplete, false) : failed(settings.issue, true);
    }
    if (credential.clientId !== settings.clientId) return failed(AUTH_ISSUE.configurationInvalid, true);
    if (Date.parse(credential.expiresAt) <= Date.now()) return failed(AUTH_ISSUE.expired, true);
    const requestId = crypto.randomUUID();
    requests.set(requestId, controller);
    let user;
    try {
      user = await verifyIdentity(credential.token, controller.signal);
    } catch (error) {
      // Only an outright rejection withdraws the credential; being unable to ask keeps it for a later try.
      return githubResponseStatus(error) === GITHUB_HTTP_STATUS.unauthorized
        ? failed(AUTH_ISSUE.authorizationRejected, true) : failed(AUTH_ISSUE.restoreIncomplete, false);
    } finally {
      requests.delete(requestId);
    }
    if (user.id !== credential.user.id) return failed(AUTH_ISSUE.identityFailed, true);
    const provisional: ConnectedSession = {
      status: AUTH_STATUS.connected, connectionId: credential.connectionId, clientId: credential.clientId,
      token: credential.token, expiresAt: credential.expiresAt, user, verifiedAt: new Date().toISOString(),
    };
    if (!await current()) return false;
    let verdict: RestoreAuthority;
    try {
      verdict = await check.authorize(provisional, current);
    } catch {
      verdict = RESTORE_AUTHORITY.unavailable;
    }
    if (verdict === RESTORE_AUTHORITY.unauthorized) return failed(AUTH_ISSUE.restoreUnauthorized, true);
    if (verdict === RESTORE_AUTHORITY.unavailable) return failed(AUTH_ISSUE.restoreIncomplete, false);
    return serialize(async () => {
      // The checks above ran outside the lock, so a disconnect or a disabled preference in the meantime wins.
      if (!await currentUnlocked()) return false;
      if (!(await remember.preference()).enabled) return false;
      if (Date.parse(credential.expiresAt) <= Date.now()) return false;
      await store(provisional);
      restoreAttempts = 0;
      rememberIssue = null;
      await browser.alarms.clear(AUTH_RESTORE_ALARM);
      return true;
    });
  }

  // Reopening an extension page is a natural moment to try again rather than waiting for the retry alarm.
  function retryRestore(): void {
    if (hooks === null) return;
    const pending = hooks;
    void restore(pending).then(restored => {
      if (restored) pending.resumed();
    });
  }

  function restore(next: RestoreHooks): Promise<boolean> {
    hooks = next;
    if (restoring === null) {
      restoring = attemptRestore(next)
        .catch((error: unknown) => {
          if (error instanceof AuthFault && error.issue === AUTH_ISSUE.rememberUnreadable) rememberIssue = error.issue;
          console.error(AUTH_TEXT.restoreFailed);
          return false;
        })
        .finally(() => { restoring = null; });
    }
    return restoring;
  }

  type Handled = { ok: true; state: AuthState } | { ok: false; error: AuthIssue };

  async function message(value: unknown, sender: Browser.runtime.MessageSender): Promise<AuthReply> {
    const reply = await handle(value, sender);
    return reply.ok ? { ...reply, remember: await rememberView() } : reply;
  }

  async function handle(value: unknown, sender: Browser.runtime.MessageSender): Promise<Handled> {
    await ready;
    const connectionPage = sender.url === browser.runtime.getURL(EXTENSION_PAGE.connect);
    const ownerTabId = sender.tab?.id;
    const ownerDocumentId = sender.documentId;
    const trusted = sender.id === browser.runtime.id && sender.frameId === 0
      && (connectionPage || sender.url === browser.runtime.getURL(EXTENSION_PAGE.options));
    if (!trusted || ownerTabId === undefined || ownerDocumentId === undefined) {
      return { ok: false, error: AUTH_ISSUE.notAllowed };
    }
    const parsed = authRequestSchema.safeParse(value);
    if (!parsed.success) return { ok: false, error: AUTH_ISSUE.notAllowed };
    const input = parsed.data;
    if (!connectionPage && input.type !== AUTH_MESSAGE.state && input.type !== AUTH_MESSAGE.disconnect) {
      return { ok: false, error: AUTH_ISSUE.notAllowed };
    }
    switch (input.type) {
      case AUTH_MESSAGE.state: {
        const current = await serialize(state);
        if (current.status === AUTH_STATUS.disconnected) retryRestore();
        return { ok: true, state: current };
      }
      case AUTH_MESSAGE.disconnect:
        return serialize(async () => {
          for (const controller of requests.values()) controller.abort();
          const disconnected = { status: AUTH_STATUS.disconnected, issue: AUTH_ISSUE.notConnected } as const;
          const withdrawn = await forgetRemembered(null);
          await store(disconnected);
          // The session is gone either way. Saying the disconnection succeeded when the remembered credential
          // could neither be removed nor disabled would describe a state that reconnects itself on restart.
          return withdrawn
            ? { ok: true, state: disconnected } : { ok: false, error: AUTH_ISSUE.rememberUnavailable };
        });
      case AUTH_MESSAGE.remember:
        // Enabling requires the acknowledgement to travel with the request; nothing here infers it.
        if (input.enabled && !input.consentAcknowledged) return { ok: false, error: AUTH_ISSUE.notAllowed };
        return serialize(async () => {
          if (!input.enabled) {
            const withdrawn = await forgetRemembered(null);
            try {
              await remember.setPreference(REMEMBER_OFF);
            } catch {
              return { ok: false, error: AUTH_ISSUE.rememberUnavailable };
            }
            if (!withdrawn) return { ok: false, error: AUTH_ISSUE.rememberUnavailable };
            return { ok: true, state: await state() };
          }
          try {
            await remember.setPreference({ schemaVersion: 1, enabled: true, consentedAt: new Date().toISOString() });
          } catch {
            rememberIssue = AUTH_ISSUE.rememberUnavailable;
            return { ok: false, error: AUTH_ISSUE.rememberUnavailable };
          }
          rememberIssue = null;
          const current = await read();
          if (current.status === AUTH_STATUS.connected) await keepRemembered(current);
          return { ok: true, state: await state() };
        });
      case AUTH_MESSAGE.begin:
        return serialize(async () => {
          const settings = await config;
          if ('issue' in settings) return { ok: false, error: settings.issue };
          for (const controller of requests.values()) controller.abort();
          const pending: AuthSession = {
            status: AUTH_STATUS.authorizing, attemptId: input.attemptId, clientId: settings.clientId,
            ownerTabId, ownerDocumentId,
          };
          await store(pending);
          return { ok: true, state: publicState(pending) };
        });
      case AUTH_MESSAGE.permit:
        return serialize(async () => {
          const session = await read();
          if (!owns(session, input.attemptId, sender)) return { ok: false, error: AUTH_ISSUE.notAllowed };
          return { ok: true, state: publicState(session) };
        });
      case AUTH_MESSAGE.cancel:
        return serialize(async () => {
          const session = await read();
          if (!owns(session, input.attemptId, sender)) return { ok: false, error: AUTH_ISSUE.notAllowed };
          requests.get(input.attemptId)?.abort();
          const cancelled = { status: AUTH_STATUS.disconnected, issue: input.issue } as const;
          await store(cancelled);
          return { ok: true, state: cancelled };
        });
      case AUTH_MESSAGE.check: {
        const previous = await serialize(read);
        if (previous.status !== AUTH_STATUS.connected) return { ok: false, error: AUTH_ISSUE.notAllowed };
        const controller = new AbortController();
        requests.set(previous.connectionId, controller);
        let user;
        try {
          user = await verifyIdentity(previous.token, controller.signal);
        } catch (error) {
          // A rejected credential is withdrawn; an unreachable GitHub is not, so the remembered copy survives it.
          const rejected = githubResponseStatus(error) === GITHUB_HTTP_STATUS.unauthorized;
          return serialize(async () => {
            const latest = await read();
            if (latest.status === AUTH_STATUS.connected && latest.connectionId === previous.connectionId) {
              await store({ status: AUTH_STATUS.disconnected, issue: AUTH_ISSUE.identityFailed });
              if (rejected) await forgetRemembered(AUTH_ISSUE.authorizationRejected);
            }
            return { ok: false, error: AUTH_ISSUE.identityFailed };
          });
        } finally {
          requests.delete(previous.connectionId);
        }
        return serialize(async () => {
          const latest = await read();
          if (latest.status !== AUTH_STATUS.connected || latest.connectionId !== previous.connectionId) {
            return { ok: false, error: AUTH_ISSUE.notAllowed };
          }
          if (user.id !== latest.user.id) {
            await store({ status: AUTH_STATUS.disconnected, issue: AUTH_ISSUE.identityFailed });
            await forgetRemembered(AUTH_ISSUE.identityFailed);
            return { ok: false, error: AUTH_ISSUE.identityFailed };
          }
          const verified = { ...latest, user, verifiedAt: new Date().toISOString() };
          await store(verified);
          await keepRemembered(verified);
          return { ok: true, state: publicState(verified) };
        });
      }
      case AUTH_MESSAGE.complete: {
        const previous = await serialize(read);
        if (!owns(previous, input.attemptId, sender) || previous.status !== AUTH_STATUS.authorizing) {
          return { ok: false, error: AUTH_ISSUE.notAllowed };
        }
        if (Date.parse(input.credentials.expiresAt) <= Date.now()) {
          return { ok: false, error: AUTH_ISSUE.expired };
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
              await store({ status: AUTH_STATUS.disconnected, issue: AUTH_ISSUE.identityFailed });
            }
            return { ok: false, error: AUTH_ISSUE.identityFailed };
          });
        } finally {
          requests.delete(input.attemptId);
        }
        return serialize(async () => {
          const latest = await read();
          if (!owns(latest, input.attemptId, sender) || controller.signal.aborted) {
            return { ok: false, error: AUTH_ISSUE.notAllowed };
          }
          if (Date.parse(input.credentials.expiresAt) <= Date.now()) return { ok: false, error: AUTH_ISSUE.expired };
          const connected: ConnectedSession = {
            status: AUTH_STATUS.connected, connectionId: input.attemptId, clientId: previous.clientId,
            ...input.credentials, user, verifiedAt: new Date().toISOString(),
          };
          await store(connected);
          await keepRemembered(connected);
          return { ok: true, state: publicState(connected) };
        });
      }
    }
  }

  function ownerClosed(tabId: number): void {
    void serialize(async () => {
      const session = await read();
      if (session.status === AUTH_STATUS.authorizing && session.ownerTabId === tabId) {
        requests.get(session.attemptId)?.abort();
        await store({ status: AUTH_STATUS.disconnected, issue: AUTH_ISSUE.interrupted });
      }
    }).catch(() => console.error(AUTH_TEXT.interruptionUnrecorded));
  }

  function alarm(name: string): void {
    if (name === AUTH_EXPIRY_ALARM) {
      void serialize(read).catch(() => console.error(AUTH_TEXT.expiryUnchecked));
    }
    if (name === AUTH_RESTORE_ALARM) retryRestore();
  }
  async function withConnection<T>(
    action: (session: ConnectedSession, guard: () => Promise<void>, signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const session: ConnectedSession = await serialize(async () => {
      await state();
      const current = await read();
      if (current.status !== AUTH_STATUS.connected) throw new AuthFault(AUTH_ISSUE.notConnected);
      return current;
    });
    const controller = new AbortController();
    const requestId = crypto.randomUUID();
    requests.set(requestId, controller);
    async function guard(): Promise<void> {
      controller.signal.throwIfAborted();
      const latest = await serialize(read);
      if (latest.status !== AUTH_STATUS.connected || latest.connectionId !== session.connectionId
        || latest.user.id !== session.user.id || latest.clientId !== session.clientId) {
        throw new AuthFault(AUTH_ISSUE.notAllowed);
      }
      controller.signal.throwIfAborted();
    }
    try {
      await guard();
      return await action(session, guard, controller.signal);
    } catch (error) {
      const status = error instanceof GithubWriteRejected ? error.status : githubResponseStatus(error);
      if (status === GITHUB_HTTP_STATUS.unauthorized) {
        await serialize(async () => {
          const latest = await read();
          if (latest.status === AUTH_STATUS.connected && latest.connectionId === session.connectionId) {
            for (const request of requests.values()) request.abort();
            await store({ status: AUTH_STATUS.disconnected, issue: AUTH_ISSUE.authorizationRejected });
            // GitHub rejected the credential itself, so the remembered copy is no longer usable either.
            await forgetRemembered(AUTH_ISSUE.authorizationRejected);
          }
        });
      }
      throw error;
    } finally {
      requests.delete(requestId);
    }
  }
  return { message, ownerClosed, alarm, restore, withConnection };
}

export type GithubService = ReturnType<typeof createGithubService>;
