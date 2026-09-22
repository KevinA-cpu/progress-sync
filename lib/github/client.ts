import { AUTH_ISSUE } from '../constants/github';
import { browser } from 'wxt/browser';
import { AuthFault, authReplySchema, type AuthRequest, type AuthState, type RememberView } from './schemas';

export type AuthOutcome = { state: AuthState; remember: RememberView };

export async function githubCall(input: AuthRequest): Promise<AuthOutcome> {
  let value: unknown;
  try {
    value = await browser.runtime.sendMessage(input);
  } catch {
    throw new AuthFault(AUTH_ISSUE.interrupted);
  }
  const parsed = authReplySchema.safeParse(value);
  if (!parsed.success) throw new AuthFault(AUTH_ISSUE.providerError);
  if (!parsed.data.ok) throw new AuthFault(parsed.data.error);
  return { state: parsed.data.state, remember: parsed.data.remember };
}
