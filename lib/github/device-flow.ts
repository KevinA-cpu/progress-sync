import { createDeviceCode, exchangeDeviceCode } from '@octokit/oauth-methods';
import {
  AuthFault, DEVICE_CODE_URL, TOKEN_URL, authenticationSchema, authIssue,
  grantResponseSchema, oauthErrorCode, verificationSchema, type Credentials,
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
      reject(new AuthFault('cancelled'));
      return;
    }
    const abort = () => {
      clearTimeout(timer);
      reject(new AuthFault('cancelled'));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    }, milliseconds);
    signal.addEventListener('abort', abort, { once: true });
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
    const response = await createDeviceCode({ clientType: 'github-app', clientId, request });
    const parsed = verificationSchema.safeParse(response.data);
    if (!parsed.success) throw new AuthFault('provider-error');
    verification = parsed.data;
  } catch (error) {
    throw new AuthFault(signal.aborted ? 'cancelled' : authIssue(error));
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
    if (Date.now() >= deadline) throw new AuthFault('flow-expired');
    await permit();
    if (signal.aborted) throw new AuthFault('cancelled');
    if (Date.now() >= deadline) throw new AuthFault('flow-expired');
    try {
      const result = await exchangeDeviceCode({
        clientType: 'github-app', clientId, code: verification.device_code, request,
      });
      if (signal.aborted) throw new AuthFault('cancelled');
      if (Date.now() >= deadline) throw new AuthFault('flow-expired');
      if (!grantResponseSchema.safeParse(result.data).success) throw new AuthFault('provider-error');
      const parsed = authenticationSchema.safeParse(result.authentication);
      if (!parsed.success) throw new AuthFault('provider-error');
      if (!parsed.data.expiresAt) throw new AuthFault('expiring-tokens-required');
      if (Date.parse(parsed.data.expiresAt) <= Date.now()) throw new AuthFault('expired');
      return { token: parsed.data.token, expiresAt: parsed.data.expiresAt };
    } catch (error) {
      if (signal.aborted) throw new AuthFault('cancelled');
      if (Date.now() >= deadline) throw new AuthFault('flow-expired');
      switch (oauthErrorCode(error)) {
        case 'authorization_pending':
          continue;
        case 'slow_down':
          interval += 5000;
          continue;
        default:
          throw new AuthFault(authIssue(error));
      }
    }
  }
}
