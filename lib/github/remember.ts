import { browser } from 'wxt/browser';
import { STORAGE_ACCESS } from '../constants/browser';
import { AUTH_ISSUE, AUTH_REMEMBER_KEY, AUTH_REMEMBER_PREFERENCE_KEY } from '../constants/github';
import {
  AuthFault, rememberedConnectionSchema, rememberPreferenceSchema,
  type RememberedConnection, type RememberPreference,
} from './schemas';

export const REMEMBER_OFF: RememberPreference = { schemaVersion: 1, enabled: false, consentedAt: null };

// The remembered access token lives in extension-local storage, which this call restricts to extension pages and
// the worker. Content scripts and web pages cannot read it, and it is never written to synchronized storage.
export function rememberStore() {
  const ready = browser.storage.local.setAccessLevel({ accessLevel: STORAGE_ACCESS.trustedContexts });

  async function preference(): Promise<RememberPreference> {
    await ready;
    const value: unknown = (await browser.storage.local.get(AUTH_REMEMBER_PREFERENCE_KEY))[AUTH_REMEMBER_PREFERENCE_KEY];
    if (value === undefined) return REMEMBER_OFF;
    const parsed = rememberPreferenceSchema.safeParse(value);
    // Absent means off; unreadable does not. Reporting it as off would hide that a choice was recorded here.
    if (!parsed.success) throw new AuthFault(AUTH_ISSUE.rememberUnreadable);
    return parsed.data;
  }

  async function setPreference(next: RememberPreference): Promise<void> {
    await ready;
    await browser.storage.local.set({
      [AUTH_REMEMBER_PREFERENCE_KEY]: rememberPreferenceSchema.parse(next),
    });
  }

  async function credential(): Promise<RememberedConnection | null> {
    await ready;
    const value: unknown = (await browser.storage.local.get(AUTH_REMEMBER_KEY))[AUTH_REMEMBER_KEY];
    if (value === undefined) return null;
    const parsed = rememberedConnectionSchema.safeParse(value);
    // Raising instead of returning is what keeps the unreadable value from being used. It is left in place so the
    // state stays visible rather than turning into "nothing was saved"; forget() removes it when the user says so.
    // The fault carries a fixed message, never the parse detail or any part of the stored value.
    if (!parsed.success) throw new AuthFault(AUTH_ISSUE.rememberUnreadable);
    return parsed.data;
  }

  async function keep(next: RememberedConnection): Promise<void> {
    await ready;
    await browser.storage.local.set({ [AUTH_REMEMBER_KEY]: rememberedConnectionSchema.parse(next) });
  }

  async function forget(): Promise<void> {
    await ready;
    await browser.storage.local.remove(AUTH_REMEMBER_KEY);
  }

  return { preference, setPreference, credential, keep, forget };
}

export type RememberStore = ReturnType<typeof rememberStore>;
