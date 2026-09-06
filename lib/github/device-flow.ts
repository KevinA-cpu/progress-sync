import { DOM_EVENT } from '../constants/browser';
import { AUTH_ISSUE, DEVICE_CODE_URL, GITHUB_CLIENT_TYPE, OAUTH_ERROR, TOKEN_URL } from '../constants/github';
import { createDeviceCode, exchangeDeviceCode } from '@octokit/oauth-methods';
import {
  AuthFault, authenticationSchema, authIssue, grantResponseSchema, oauthErrorCode, verificationSchema,
  type Credentials,
} from './schemas';
import { githubRequest } from './transport';

export interface Challenge {
  userCode: string;
  verificationUri: string;
  expiresAt: string;
}

function wait(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new AuthFault(AUTH_ISSUE.cancelled));
      return;
    }
    const abort = () => {
      clearTimeout(timer);
      reject(new AuthFault(AUTH_ISSUE.cancelled));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener(DOM_EVENT.abort, abort);
      resolve();
    }, milliseconds);
    signal.addEventListener(DOM_EVENT.abort, abort, { once: true });
  });
}

export async function authorizeDevice(
  clientId: string,
  signal: AbortSignal,
  permit: () => Promise<void>,
  onChallenge: (challenge: Challenge) => void,
): Promise<Credentials> {
  const request = githubRequest([DEVICE_CODE_URL, TOKEN_URL], signal);
  await permit();
  let verification;
  try {
    const response = await createDeviceCode({ clientType: GITHUB_CLIENT_TYPE, clientId, request });
    const parsed = verificationSchema.safeParse(response.data);
    if (!parsed.success) throw new AuthFault(AUTH_ISSUE.providerError);
    verification = parsed.data;
  } catch (error) {
    throw new AuthFault(signal.aborted ? AUTH_ISSUE.cancelled : authIssue(error));
  }
  const deadline = Date.now() + verification.expires_in * 1000;
  let interval = verification.interval * 1000;
  onChallenge({
    userCode: verification.user_code,
    verificationUri: verification.verification_uri,
    expiresAt: new Date(deadline).toISOString(),
  });

  while (true) {
    await wait(Math.min(interval, Math.max(0, deadline - Date.now())), signal);
    if (Date.now() >= deadline) throw new AuthFault(AUTH_ISSUE.flowExpired);
    await permit();
    if (signal.aborted) throw new AuthFault(AUTH_ISSUE.cancelled);
    if (Date.now() >= deadline) throw new AuthFault(AUTH_ISSUE.flowExpired);
    try {
      const result = await exchangeDeviceCode({
        clientType: GITHUB_CLIENT_TYPE, clientId, code: verification.device_code, request,
      });
      if (signal.aborted) throw new AuthFault(AUTH_ISSUE.cancelled);
      if (Date.now() >= deadline) throw new AuthFault(AUTH_ISSUE.flowExpired);
      if (!grantResponseSchema.safeParse(result.data).success) throw new AuthFault(AUTH_ISSUE.providerError);
      const parsed = authenticationSchema.safeParse(result.authentication);
      if (!parsed.success) throw new AuthFault(AUTH_ISSUE.providerError);
      if (!parsed.data.expiresAt) throw new AuthFault(AUTH_ISSUE.expiringTokensRequired);
      if (Date.parse(parsed.data.expiresAt) <= Date.now()) throw new AuthFault(AUTH_ISSUE.expired);
      return { token: parsed.data.token, expiresAt: parsed.data.expiresAt };
    } catch (error) {
      if (signal.aborted) throw new AuthFault(AUTH_ISSUE.cancelled);
      if (Date.now() >= deadline) throw new AuthFault(AUTH_ISSUE.flowExpired);
      switch (oauthErrorCode(error)) {
        case OAUTH_ERROR.authorizationPending:
          continue;
        case OAUTH_ERROR.slowDown:
          interval += 5000;
          continue;
        default:
          throw new AuthFault(authIssue(error));
      }
    }
  }
}
