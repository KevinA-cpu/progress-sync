import { AUTH_ISSUE } from '../constants/github';
import { browser } from 'wxt/browser';
import { AuthFault, authReplySchema, type AuthRequest, type AuthState } from './schemas';

export async function githubCall(input: AuthRequest): Promise<AuthState> {
  let value: unknown;
  try {
    value = await browser.runtime.sendMessage(input);
  } catch {
    throw new AuthFault(AUTH_ISSUE.interrupted);
  }
  const parsed = authReplySchema.safeParse(value);
  if (!parsed.success) throw new AuthFault(AUTH_ISSUE.providerError);
  if (!parsed.data.ok) throw new AuthFault(parsed.data.error);
  return parsed.data.state;
}
