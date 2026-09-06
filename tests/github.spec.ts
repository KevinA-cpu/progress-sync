import { expect, stopExtensionWorker, submittedSource, test } from './fixtures';
import {
  ACCESS_TOKEN, CLIENT_ID, DEVICE_CODE, REFRESH_TOKEN, advanceUntilPolls, credentialSummary,
  githubFixture, openClockedConnection, openConnection,
} from './github-fixture';
import { chromium } from '@playwright/test';
import { resolve } from 'node:path';

test.use({ githubClientId: CLIENT_ID });

test('connects through a dedicated tab and verifies the GitHub identity', async ({
  extensionContext, progress,
}, testInfo) => {
  const server = await githubFixture(extensionContext);
  server.approved = false;
  const connection = await openConnection(extensionContext, progress);
  await connection.getByRole('button', { name: 'Connect GitHub', exact: true }).click();
  await expect(connection.getByText('TEST-CODE', { exact: true })).toBeVisible();
  const verificationOpened = extensionContext.waitForEvent('page');
  await connection.getByRole('link', { name: 'Open GitHub', exact: true }).click();
  const verification = await verificationOpened;
  await verification.getByRole('button', { name: 'Approve test app' }).click();

  await expect(connection.getByText('Connected as fixture-user', { exact: true })).toBeVisible();
  expect(server.identityRequests).toBe(1);
  expect(server.requestChecks.length).toBeGreaterThanOrEqual(3);
  expect(server.requestChecks.every(Boolean)).toBe(true);
  await expect(connection.getByText('Administration: write', { exact: false })).toBeVisible();
  await expect(connection.getByText('Contents: write', { exact: false })).toBeVisible();
  await connection.screenshot({ path: testInfo.outputPath('github-connected.png'), fullPage: true });
});

test('denied authorization is actionable and does not expose provider error details', async ({
  extensionContext, progress,
}) => {
  const server = await githubFixture(extensionContext);
  server.tokenErrors.push('access_denied');
  const connection = await openConnection(extensionContext, progress);
  await connection.getByRole('button', { name: 'Connect GitHub', exact: true }).click();

  await expect(connection.getByRole('status')).toHaveText('GitHub authorization was denied. You can try again.');
  expect(server.identityRequests).toBe(0);
  expect(server.logs.some(line => line.includes('SENSITIVE_FIXTURE_DETAIL'))).toBe(false);
  expect((await connection.content()).includes('SENSITIVE_FIXTURE_DETAIL')).toBe(false);
});

test('a token response granting OAuth repo scope is not accepted as GitHub App authorization', async ({
  extensionContext, progress,
}) => {
  const server = await githubFixture(extensionContext);
  server.scope = 'repo';
  const connection = await openConnection(extensionContext, progress);
  await connection.getByRole('button', { name: 'Connect GitHub', exact: true }).click();

  await expect(connection.getByRole('status'))
    .toHaveText('GitHub returned an unsupported authorization response. Try connecting again.');
  expect(server.identityRequests).toBe(0);
});

for (const scenario of [
  { name: 'non-expiring token', setup: (server: Awaited<ReturnType<typeof githubFixture>>) => { server.expiringToken = false; },
    message: 'Enable expiring user access tokens in the GitHub App settings, then reconnect.' },
  { name: 'failed identity verification', setup: (server: Awaited<ReturnType<typeof githubFixture>>) => { server.identityStatus = 401; },
    message: 'GitHub identity could not be verified. Connect again.' },
  { name: 'expired verification code', setup: (server: Awaited<ReturnType<typeof githubFixture>>) => { server.deviceLifetime = 1; },
    message: 'The GitHub verification code expired. Start a new connection.' },
  { name: 'untrusted verification URL', setup: (server: Awaited<ReturnType<typeof githubFixture>>) => { server.verificationUri = 'https://untrusted.invalid/device'; },
    message: 'GitHub returned an unsupported authorization response. Try connecting again.' },
]) {
  test(`rejects ${scenario.name}`, async ({ extensionContext, progress }) => {
    const server = await githubFixture(extensionContext);
    scenario.setup(server);
    const connection = await openConnection(extensionContext, progress);
    await connection.getByRole('button', { name: 'Connect GitHub', exact: true }).click();

    await expect(connection.getByRole('status')).toHaveText(scenario.message);
    await expect(connection.getByRole('button', { name: 'Disconnect GitHub' })).toBeDisabled();
  });
}

test('a slowdown increases every subsequent polling interval', async ({
  extensionContext, progress,
}) => {
  const connection = await openClockedConnection(extensionContext, progress);
  const server = await githubFixture(extensionContext, () => connection.evaluate(() => Date.now()));
  server.tokenErrors.push('slow_down', 'authorization_pending');
  await connection.getByRole('button', { name: 'Connect GitHub', exact: true }).click();
  await expect(connection.getByText('TEST-CODE', { exact: true })).toBeVisible();
  await advanceUntilPolls(connection, server, 3);

  await expect(connection.getByRole('status')).toHaveText('Connected as fixture-user');
  expect(server.tokenRequestTimes).toHaveLength(3);
  const [first, second, third] = server.tokenRequestTimes;
  if (first === undefined || second === undefined || third === undefined) throw new Error('Missing poll timestamps.');
  expect(second - first).toBeGreaterThanOrEqual(6000);
  expect(third - second).toBeGreaterThanOrEqual(6000);
});

test('cancelling a pending grant prevents later responses from connecting', async ({
  extensionContext, progress,
}) => {
  const server = await githubFixture(extensionContext);
  const gate = Promise.withResolvers<void>();
  server.deviceGate = gate.promise;
  const connection = await openConnection(extensionContext, progress);
  await connection.getByRole('button', { name: 'Connect GitHub', exact: true }).click();
  await expect.poll(() => server.deviceRequests).toBe(1);
  await connection.getByRole('button', { name: 'Cancel authorization' }).click();
  await expect(connection.getByRole('status')).toHaveText('GitHub authorization cancelled.');
  gate.resolve();
  await progress.reload();
  const reopened = await openConnection(extensionContext, progress);

  await expect(reopened.getByRole('status')).toHaveText('GitHub authorization cancelled.');
  expect(server.tokenRequestTimes).toHaveLength(0);
  expect(server.identityRequests).toBe(0);
});

test('disconnect during identity verification cannot be undone by its late response', async ({
  extensionContext, progress,
}) => {
  const server = await githubFixture(extensionContext);
  const gate = Promise.withResolvers<void>();
  server.identityGate = gate.promise;
  const connection = await openConnection(extensionContext, progress);
  await connection.getByRole('button', { name: 'Connect GitHub', exact: true }).click();
  await expect.poll(() => server.identityRequests).toBe(1);
  await connection.getByRole('button', { name: 'Disconnect GitHub' }).click();
  await expect(connection.getByRole('status')).toHaveText('Not connected to GitHub.');
  gate.resolve();
  const reopened = await openConnection(extensionContext, progress);

  await expect(reopened.getByRole('status')).toHaveText('Not connected to GitHub.');
  await expect(reopened.getByText('Connected as fixture-user', { exact: true })).toHaveCount(0);
});

test('only the access token survives worker recreation, and disconnect removes it', async ({
  extensionContext, progress,
}) => {
  await extensionContext.addCookies([{ name: 'website_session', value: 'synthetic-cookie', url: 'https://github.com' }]);
  const server = await githubFixture(extensionContext);
  const connection = await openConnection(extensionContext, progress);
  await connection.getByRole('button', { name: 'Connect GitHub', exact: true }).click();
  await expect(connection.getByRole('status')).toHaveText('Connected as fixture-user');
  await stopExtensionWorker(extensionContext, connection);
  await connection.reload();
  await expect(connection.getByRole('status')).toHaveText('Connected as fixture-user');

  expect(await credentialSummary(connection)).toEqual({
    accessInSession: true, refreshInSession: false, deviceInSession: false, leakedOutsideSession: false,
  });
  expect(server.requestChecks.every(Boolean)).toBe(true);
  expect(server.logs.some(line => [ACCESS_TOKEN, REFRESH_TOKEN, DEVICE_CODE].some(value => line.includes(value)))).toBe(false);
  await connection.getByRole('button', { name: 'Disconnect GitHub' }).click();
  await expect(connection.getByRole('status')).toHaveText('Not connected to GitHub.');
  expect((await credentialSummary(connection)).accessInSession).toBe(false);
});

test('an expired session is cleared before another identity request', async ({
  extensionContext, progress,
}) => {
  const server = await githubFixture(extensionContext);
  server.tokenLifetime = 60;
  const connection = await openConnection(extensionContext, progress);
  await connection.getByRole('button', { name: 'Connect GitHub', exact: true }).click();
  await expect(connection.getByRole('status')).toHaveText('Connected as fixture-user');
  const worker = extensionContext.serviceWorkers()[0];
  if (!worker) throw new Error('Missing extension worker.');
  await worker.evaluate(now => { Date.now = () => now; }, Date.now() + 120_000);
  await connection.getByRole('button', { name: 'Check connection' }).click();

  await expect(connection.getByRole('status')).toHaveText('The GitHub session expired. Connect again.');
  expect(server.identityRequests).toBe(1);
  expect((await credentialSummary(connection)).accessInSession).toBe(false);
});

test('closing the connection tab interrupts authorization', async ({
  extensionContext, progress,
}) => {
  const server = await githubFixture(extensionContext);
  server.approved = false;
  const connection = await openConnection(extensionContext, progress);
  await connection.getByRole('button', { name: 'Connect GitHub', exact: true }).click();
  await expect(connection.getByText('TEST-CODE', { exact: true })).toBeVisible();
  await connection.close();
  const reopened = await openConnection(extensionContext, progress);

  await expect(reopened.getByRole('status')).toHaveText('GitHub authorization was interrupted. Start a new connection.');
  expect((await credentialSummary(reopened)).accessInSession).toBe(false);
});

test.describe('without App configuration', () => {
  test.use({ githubClientId: null });
  test('offers setup guidance without starting authentication', async ({ extensionContext, progress }) => {
    const server = await githubFixture(extensionContext);
    const connection = await openConnection(extensionContext, progress);

    await expect(connection.getByRole('status'))
      .toHaveText('Configure the public GitHub App client ID, then rebuild and reload the extension.');
    await expect(connection.getByRole('button', { name: 'Connect GitHub', exact: true })).toBeDisabled();
    expect(server.deviceRequests).toBe(0);
  });
});

test.describe('with invalid App configuration', () => {
  test.use({ githubClientId: 'not a client id' });
  test('rejects configuration without sending it to GitHub', async ({ extensionContext, progress }) => {
    const server = await githubFixture(extensionContext);
    const connection = await openConnection(extensionContext, progress);

    await expect(connection.getByRole('status'))
      .toHaveText('Check the public GitHub App client ID and enable device flow in the App settings.');
    await expect(connection.getByRole('button', { name: 'Connect GitHub', exact: true })).toBeDisabled();
    expect(server.deviceRequests).toBe(0);
  });
});

test('the real HDLBits content-script context cannot read session credentials or GitHub state', async ({
  extensionContext, problem, progress,
}) => {
  await githubFixture(extensionContext);
  const connection = await openConnection(extensionContext, progress);
  await connection.getByRole('button', { name: 'Connect GitHub', exact: true }).click();
  await expect(connection.getByRole('status')).toHaveText('Connected as fixture-user');
  expect((await credentialSummary(connection)).accessInSession).toBe(true);

  const worker = extensionContext.serviceWorkers()[0];
  if (!worker) throw new Error('Missing extension worker.');
  const extensionId = new URL(worker.url()).hostname;
  const session = await extensionContext.newCDPSession(problem);
  const contexts = new Set<number>();
  session.on('Runtime.executionContextCreated', ({ context }) => contexts.add(context.id));
  session.on('Runtime.executionContextDestroyed', ({ executionContextId }) => contexts.delete(executionContextId));
  session.on('Runtime.executionContextsCleared', () => contexts.clear());
  await session.send('Runtime.enable');
  await problem.getByRole('textbox', { name: 'Solution' }).fill(submittedSource);
  await problem.getByRole('button', { name: 'Submit', exact: true }).click();
  await expect(progress.getByText('Accepted locally - not saved to GitHub', { exact: true })).toBeVisible();

  let isolatedWorld: number | undefined;
  for (const contextId of contexts) {
    const result = await session.send('Runtime.evaluate', {
      contextId,
      expression: `globalThis.chrome?.runtime?.id === ${JSON.stringify(extensionId)}`,
      returnByValue: true,
    });
    if (result.result.value === true) isolatedWorld = contextId;
  }
  if (isolatedWorld === undefined) throw new Error('Did not find the actual extension content-script context.');
  const result = await session.send('Runtime.evaluate', {
    contextId: isolatedWorld,
    awaitPromise: true,
    returnByValue: true,
    expression: `(async () => {
      const reply = await chrome.runtime.sendMessage({ type: 'github:state' });
      let storageBlocked = !chrome.storage?.session;
      if (!storageBlocked) {
        try { await chrome.storage.session.get(null); }
        catch (error) { storageBlocked = String(error.message).includes('Access to storage is not allowed'); }
      }
      const delivery = await chrome.runtime.sendMessage({ type: 'delivery:list' });
      const publication = await chrome.runtime.sendMessage({
        type: 'delivery:publish', attemptId: '11111111-1111-4111-8111-111111111111',
        expectedConnectionId: '11111111-1111-4111-8111-111111111111',
        expectedSelectionId: '11111111-1111-4111-8111-111111111111', publicConfirmed: true
      });
      return {
        storageBlocked, stateDenied: reply.ok === false && reply.error === 'not-allowed',
        deliveryDenied: delivery.ok === false && delivery.error === 'Unsupported delivery operation or sender.',
        publicationDenied: publication.ok === false && publication.error === 'Unsupported delivery operation or sender.'
      };
    })()`,
  });
  expect(result.exceptionDetails).toBeUndefined();
  expect(result.result.value).toEqual({
    storageBlocked: true, stateDenied: true, deliveryDenied: true, publicationDenied: true,
  });
  await session.detach();
});

test('authorization continues in its tab after the service worker is recreated', async ({
  extensionContext, progress,
}) => {
  const server = await githubFixture(extensionContext);
  server.approved = false;
  const connection = await openConnection(extensionContext, progress);
  await connection.getByRole('button', { name: 'Connect GitHub', exact: true }).click();
  await expect(connection.getByText('TEST-CODE', { exact: true })).toBeVisible();
  await stopExtensionWorker(extensionContext, connection);
  server.approved = true;

  await expect(connection.getByRole('status')).toHaveText('Connected as fixture-user');
  expect(server.deviceRequests).toBe(1);
});

test('a real browser restart does not restore the GitHub credential', async ({
  extensionContext, progress,
}, testInfo) => {
  await githubFixture(extensionContext);
  const connection = await openConnection(extensionContext, progress);
  await connection.getByRole('button', { name: 'Connect GitHub', exact: true }).click();
  await expect(connection.getByRole('status')).toHaveText('Connected as fixture-user');
  expect((await credentialSummary(connection)).accessInSession).toBe(true);
  await extensionContext.close();
  const extensionPath = resolve(testInfo.outputPath('extension'));
  const restarted = await chromium.launchPersistentContext(testInfo.outputPath('profile'), {
    channel: 'chromium', headless: true,
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
  });
  try {
    await restarted.route('**/*', route => new URL(route.request().url()).protocol === 'chrome-extension:'
      ? route.continue() : route.abort());
    const worker = restarted.serviceWorkers()[0] ?? await restarted.waitForEvent('serviceworker');
    const page = await restarted.newPage();
    await page.goto(`chrome-extension://${new URL(worker.url()).hostname}/connect.html`);

    await expect(page.getByRole('status')).toHaveText('Not connected to GitHub.');
    expect((await credentialSummary(page)).accessInSession).toBe(false);
  } finally {
    await restarted.close();
  }
});

test('network failures are actionable without exposing request details', async ({
  extensionContext, progress,
}) => {
  const server = await githubFixture(extensionContext);
  await extensionContext.route('https://github.com/login/device/code', route => route.abort('internetdisconnected'));
  const connection = await openConnection(extensionContext, progress);
  await connection.getByRole('button', { name: 'Connect GitHub', exact: true }).click();

  await expect(connection.getByRole('status'))
    .toHaveText('GitHub could not be reached. Check your connection and try again.');
  expect(server.identityRequests).toBe(0);
});

test('typed identity requests reject redirects instead of forwarding credentials', async ({
  extensionContext, progress,
}) => {
  await githubFixture(extensionContext);
  let redirectedRequests = 0;
  await extensionContext.route('https://unexpected.invalid/**', async route => {
    redirectedRequests++;
    await route.fulfill({ json: { id: 42, login: 'fixture-user' } });
  });
  await extensionContext.route('https://api.github.com/user', route => route.fulfill({
    status: 302, headers: { location: 'https://unexpected.invalid/user' },
  }));
  const connection = await openConnection(extensionContext, progress);
  await connection.getByRole('button', { name: 'Connect GitHub', exact: true }).click();

  await expect(connection.getByRole('status')).toHaveText('GitHub identity could not be verified. Connect again.');
  expect(redirectedRequests).toBe(0);
  expect((await credentialSummary(connection)).accessInSession).toBe(false);
});

test('checking a revoked connection clears its credential', async ({
  extensionContext, progress,
}) => {
  const server = await githubFixture(extensionContext);
  const connection = await openConnection(extensionContext, progress);
  await connection.getByRole('button', { name: 'Connect GitHub', exact: true }).click();
  await expect(connection.getByRole('status')).toHaveText('Connected as fixture-user');
  server.identityStatus = 401;
  await connection.getByRole('button', { name: 'Check connection' }).click();

  await expect(connection.getByRole('status')).toHaveText('GitHub identity could not be verified. Connect again.');
  expect((await credentialSummary(connection)).accessInSession).toBe(false);
});

test('cancelling approval polling prevents any later poll', async ({
  extensionContext, progress,
}) => {
  const connection = await openClockedConnection(extensionContext, progress);
  const server = await githubFixture(extensionContext, () => connection.evaluate(() => Date.now()));
  server.approved = false;
  await connection.getByRole('button', { name: 'Connect GitHub', exact: true }).click();
  await expect(connection.getByText('TEST-CODE', { exact: true })).toBeVisible();
  await advanceUntilPolls(connection, server, 1);
  await connection.getByRole('button', { name: 'Cancel authorization' }).click();
  await expect(connection.getByRole('status')).toHaveText('GitHub authorization cancelled.');
  const previousPolls = server.tokenRequestTimes.length;
  await connection.clock.runFor(60_000);

  expect(server.tokenRequestTimes).toHaveLength(previousPolls);
  expect(server.identityRequests).toBe(0);
  expect((await credentialSummary(connection)).accessInSession).toBe(false);
});
