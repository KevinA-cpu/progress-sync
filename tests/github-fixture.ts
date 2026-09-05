import type { BrowserContext, Page } from '@playwright/test';
import type { Browser } from 'wxt/browser';

declare const chrome: typeof Browser;

export const CLIENT_ID = 'Iv1.progress-sync-fixture';
export const ACCESS_TOKEN = 'ghu_SYNTHETIC_ACCESS_NOT_REAL';
export const REFRESH_TOKEN = 'ghr_SYNTHETIC_REFRESH_NOT_REAL';
export const DEVICE_CODE = 'synthetic-device-code';

interface GithubFixture {
  approved: boolean;
  deviceError: string | null;
  tokenErrors: string[];
  deviceLifetime: number;
  interval: number;
  expiringToken: boolean;
  tokenLifetime: number;
  scope: string;
  identityStatus: number;
  identityUser: { id: number; login: string };
  verificationUri: string;
  deviceGate: Promise<void> | null;
  tokenGate: Promise<void> | null;
  identityGate: Promise<void> | null;
  deviceRequests: number;
  identityRequests: number;
  tokenRequestTimes: number[];
  requestChecks: boolean[];
  logs: string[];
}

export async function githubFixture(context: BrowserContext) {
  const server: GithubFixture = {
    approved: true,
    deviceError: null,
    tokenErrors: [],
    deviceLifetime: 600,
    interval: 1,
    expiringToken: true,
    tokenLifetime: 28_800,
    scope: '',
    identityStatus: 200,
    identityUser: { id: 42, login: 'fixture-user' },
    verificationUri: 'https://github.com/login/device',
    deviceGate: null,
    tokenGate: null,
    identityGate: null,
    deviceRequests: 0,
    identityRequests: 0,
    tokenRequestTimes: [],
    requestChecks: [],
    logs: [],
  };
  context.on('console', message => { server.logs.push(message.text()); });
  await context.route('https://github.com/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/login/device') {
      await route.fulfill({
        contentType: 'text/html',
        body: '<h1>GitHub verification fixture</h1><button onclick="fetch(\'/fixture-approve\', {method:\'POST\'})">Approve test app</button>',
      });
    } else if (path === '/fixture-approve') {
      server.approved = true;
      await route.fulfill({ status: 204 });
    } else if (path === '/login/device/code') {
      server.deviceRequests++;
      if (server.deviceGate) await server.deviceGate;
      const body = route.request().postDataJSON();
      const headers = await route.request().allHeaders();
      server.requestChecks.push(body.client_id === CLIENT_ID && !('scope' in body)
        && !('client_secret' in body) && !headers.cookie);
      await route.fulfill({ json: server.deviceError ? {
        error: server.deviceError, error_description: 'SENSITIVE_FIXTURE_DETAIL',
      } : {
        device_code: DEVICE_CODE, user_code: 'TEST-CODE',
        verification_uri: server.verificationUri,
        expires_in: server.deviceLifetime, interval: server.interval,
      } });
    } else if (path === '/login/oauth/access_token') {
      server.tokenRequestTimes.push(Date.now());
      if (server.tokenGate) await server.tokenGate;
      const body = route.request().postDataJSON();
      const headers = await route.request().allHeaders();
      server.requestChecks.push(body.device_code === DEVICE_CODE
        && body.grant_type === 'urn:ietf:params:oauth:grant-type:device_code'
        && !('scope' in body) && !('client_secret' in body) && !headers.cookie);
      const error = server.tokenErrors.shift() ?? (server.approved ? null : 'authorization_pending');
      await route.fulfill({ headers: { date: new Date().toUTCString() }, json: error ? {
        error, error_description: 'SENSITIVE_FIXTURE_DETAIL',
      } : {
        access_token: ACCESS_TOKEN, scope: server.scope, token_type: 'bearer',
        ...(server.expiringToken ? {
          refresh_token: REFRESH_TOKEN, expires_in: server.tokenLifetime,
          refresh_token_expires_in: 15_811_200,
        } : {}),
      } });
    } else {
      await route.fulfill({ status: 404, json: { message: 'Unexpected fixture endpoint' } });
    }
  });
  await context.route('https://api.github.com/user', async route => {
    server.identityRequests++;
    if (server.identityGate) await server.identityGate;
    const headers = await route.request().allHeaders();
    server.requestChecks.push(headers.authorization === `token ${ACCESS_TOKEN}` && !headers.cookie);
    await route.fulfill({
      status: server.identityStatus,
      json: server.identityStatus === 200 ? server.identityUser : { message: 'SENSITIVE_FIXTURE_DETAIL' },
    });
  });
  return server;
}

export async function openConnection(context: BrowserContext, progress: Page): Promise<Page> {
  const [connection] = await Promise.all([
    context.waitForEvent('page'),
    progress.getByRole('link', { name: 'Connect GitHub', exact: true }).click(),
  ]);
  await connection.getByRole('heading', { name: 'Connect GitHub', exact: true }).waitFor();
  return connection;
}

export async function credentialSummary(page: Page) {
  return page.evaluate(async credentials => {
    const [session, local, sync] = await Promise.all([
      chrome.storage.session.get(null), chrome.storage.local.get(null), chrome.storage.sync.get(null),
    ]);
    const sessionText = JSON.stringify(session);
    const outsideSession = [JSON.stringify(local), JSON.stringify(sync), document.documentElement.outerHTML];
    return {
      accessInSession: sessionText.includes(credentials.access),
      refreshInSession: sessionText.includes(credentials.refresh),
      deviceInSession: sessionText.includes(credentials.device),
      leakedOutsideSession: outsideSession.some(text => Object.values(credentials).some(value => text.includes(value))),
    };
  }, { access: ACCESS_TOKEN, refresh: REFRESH_TOKEN, device: DEVICE_CODE });
}
