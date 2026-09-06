import { expect, stopExtensionWorker, test } from './fixtures';
import { CLIENT_ID, githubFixture, openConnection } from './github-fixture';
import { destinationFixture } from './destination-fixture';
import type { BrowserContext, Page } from '@playwright/test';
import type { Browser } from 'wxt/browser';

declare const chrome: typeof Browser;

test.use({ githubClientId: CLIENT_ID });

async function startSetup(context: BrowserContext, progress: Page) {
  const auth = await githubFixture(context);
  const server = await destinationFixture(context);
  const connection = await openConnection(context, progress);
  await connection.getByRole('button', { name: 'Connect GitHub', exact: true }).click();
  await expect(connection.getByRole('status')).toHaveText('Connected as fixture-user');
  const [destination] = await Promise.all([
    context.waitForEvent('page'),
    connection.getByRole('link', { name: 'Set up progress repository' }).click(),
  ]);
  await expect(destination.getByText('Owner: fixture-user', { exact: true })).toBeVisible();
  return { auth, server, connection, destination };
}

test('onboarding creates a public repository and verifies its installation and actual branch', async ({
  extensionContext, progress,
}, testInfo) => {
  const { server, destination } = await startSetup(extensionContext, progress);
  await destination.getByLabel('Repository name', { exact: true }).fill('progress-solutions');
  await destination.getByLabel('I understand this repository will be public').check();
  await destination.getByRole('button', { name: 'Create public repository', exact: true }).click();

  await expect(destination.getByRole('status')).toHaveText('Verified destination: fixture-user/progress-solutions @ learning');
  expect(server.creations).toBe(1);
  expect(server.initializations).toBe(1);
  expect(server.requestsValid).toBe(true);
  expect(JSON.parse(server.markerContent)).toMatchObject({ kind: 'progress-sync', schemaVersion: 1 });
  await destination.screenshot({ path: testInfo.outputPath('destination-verified.png'), fullPage: true });
});

test('existing compatible repositories are explicitly connected without writes', async ({
  extensionContext, progress,
}) => {
  const { server, destination } = await startSetup(extensionContext, progress);
  server.exists = true;
  server.marker = true;
  server.defaultBranch = 'practice/verilog';
  await destination.getByRole('button', { name: 'Connect existing repository', exact: true }).click();
  await expect(destination.getByRole('status'))
    .toHaveText('Verified destination: fixture-user/progress-solutions @ practice/verilog');
  expect(server.creations).toBe(0);
  expect(server.initializations).toBe(0);
});

test('name collisions require an explicit existing-repository selection', async ({
  extensionContext, progress,
}) => {
  const { server, destination } = await startSetup(extensionContext, progress);
  server.exists = true;
  server.marker = true;
  await destination.getByLabel('I understand this repository will be public').check();
  await destination.getByRole('button', { name: 'Create public repository', exact: true }).click();
  await expect(destination.getByRole('status'))
    .toHaveText('That repository already exists. Explicitly connect it or choose another name.');
  expect(server.creations).toBe(0);
  await destination.getByRole('button', { name: 'Connect existing repository', exact: true }).click();
  await expect(destination.getByRole('status')).toContainText('Verified destination:');
  expect(server.initializations).toBe(0);
});

test('missing installation access is recoverable without creating another repository', async ({
  extensionContext, progress,
}) => {
  const { server, destination } = await startSetup(extensionContext, progress);
  server.included = false;
  await destination.getByLabel('I understand this repository will be public').check();
  await destination.getByRole('button', { name: 'Create public repository', exact: true }).click();
  await expect(destination.getByRole('status')).toContainText('not accessible to the selected App installation');
  expect(server.creations).toBe(1);
  expect(server.initializations).toBe(0);
  server.included = true;
  await destination.getByRole('button', { name: 'Verify pending or saved repository' }).click();
  await expect(destination.getByRole('status')).toContainText('Verified destination:');
  expect(server.creations).toBe(1);
});

test('empty existing repositories require consent before initialization', async ({
  extensionContext, progress,
}) => {
  const { server, destination } = await startSetup(extensionContext, progress);
  server.exists = true;
  server.empty = true;
  server.defaultBranch = 'exercises';
  await destination.getByRole('button', { name: 'Connect existing repository', exact: true }).click();
  await expect(destination.getByRole('status')).toContainText('Confirm initialization before connecting');
  expect(server.initializations).toBe(0);
  await destination.getByLabel('Initialize this empty or previously requested repository with a Progress Sync marker').check();
  await destination.getByRole('button', { name: 'Connect existing repository', exact: true }).click();
  await expect(destination.getByRole('status')).toHaveText('Verified destination: fixture-user/progress-solutions @ exercises');
  expect(server.initializations).toBe(1);
});

test('a lost creation response survives worker restart and requires explicit recovery', async ({
  extensionContext, progress,
}) => {
  const { server, destination } = await startSetup(extensionContext, progress);
  server.loseCreationResponse = true;
  await destination.getByLabel('I understand this repository will be public').check();
  await destination.getByRole('button', { name: 'Create public repository', exact: true }).click();
  await expect(destination.getByRole('status')).toContainText('Creation may have completed.');
  expect(server.creations).toBe(1);
  await stopExtensionWorker(extensionContext, destination);
  await destination.reload();
  await expect(destination.getByText('Saved setup:', { exact: false })).toContainText('(creating)');
  await destination.getByRole('button', { name: 'Verify pending or saved repository' }).click();
  await expect(destination.getByRole('status')).toContainText('Creation may have completed.');
  expect(server.creations).toBe(1);
  await destination.getByLabel('Initialize this empty or previously requested repository with a Progress Sync marker').check();
  await destination.getByRole('button', { name: 'Connect existing repository', exact: true }).click();
  await expect(destination.getByRole('status')).toContainText('Verified destination:');
  expect(server.creations).toBe(1);
});

test('disconnect during repository creation keeps the old destination form disabled', async ({
  extensionContext, progress,
}) => {
  const { server, connection, destination } = await startSetup(extensionContext, progress);
  const gate = Promise.withResolvers<void>();
  server.createGate = gate.promise;
  await destination.getByLabel('I understand this repository will be public').check();
  await destination.getByRole('button', { name: 'Create public repository', exact: true }).click();
  await expect.poll(() => server.creations).toBe(1);
  await connection.getByRole('button', { name: 'Disconnect GitHub' }).click();
  await expect(connection.getByRole('status')).toHaveText('Not connected to GitHub.');
  gate.resolve();
  await expect(destination.getByRole('status')).toContainText('session changed');
  await expect.poll(() => server.exists).toBe(true);

  await expect(destination.getByRole('button', { name: 'Create public repository', exact: true })).toBeDisabled();
  expect(server.initializations).toBe(0);
});

for (const scenario of [
  { name: 'missing Contents authority', change: { contentsWrite: false }, message: 'permission is missing or denied' },
  { name: 'missing Administration authority', change: { administrationWrite: false }, message: 'permission is missing or denied' },
  { name: 'an installation of another App', change: { installationClientId: 'Iv1.some-other-app' }, message: 'Install this GitHub App' },
  { name: 'a suspended installation', change: { suspended: true }, message: 'Install this GitHub App' },
  { name: 'a denied creation request', change: { creationDenied: true }, message: 'GitHub rejected repository creation.' },
]) {
  test(`new onboarding rejects ${scenario.name}`, async ({ extensionContext, progress }) => {
    const { server, destination } = await startSetup(extensionContext, progress);
    Object.assign(server, scenario.change);
    await destination.getByLabel('I understand this repository will be public').check();
    await destination.getByRole('button', { name: 'Create public repository', exact: true }).click();

    await expect(destination.getByRole('status')).toContainText(scenario.message);
    expect(server.initializations).toBe(0);
    expect(server.exists).toBe(false);
    expect(await destination.content()).not.toContain('SYNTHETIC_PRIVATE_DIAGNOSTIC');
  });
}

for (const scenario of [
  { name: 'a read-only repository', change: { userPush: false }, message: 'permission is missing or denied' },
  { name: 'a private repository', change: { private: true }, message: 'visibility changed' },
  { name: 'an archived repository', change: { archived: true }, message: 'permission is missing or denied' },
  { name: 'an unrelated populated repository', change: { marker: false }, message: 'not a compatible public Progress Sync repository' },
]) {
  test(`existing onboarding refuses ${scenario.name} without writing`, async ({ extensionContext, progress }) => {
    const { server, destination } = await startSetup(extensionContext, progress);
    server.exists = true;
    server.marker = true;
    Object.assign(server, scenario.change);
    await destination.getByLabel('Initialize this empty or previously requested repository with a Progress Sync marker').check();
    await destination.getByRole('button', { name: 'Connect existing repository', exact: true }).click();

    await expect(destination.getByRole('status')).toContainText(scenario.message);
    expect(server.initializations).toBe(0);
    expect(server.creations).toBe(0);
  });
}

test('lost initialization responses are reconciled without another marker write', async ({
  extensionContext, progress,
}) => {
  const { server, destination } = await startSetup(extensionContext, progress);
  server.loseInitializationResponse = true;
  await destination.getByLabel('I understand this repository will be public').check();
  await destination.getByRole('button', { name: 'Create public repository', exact: true }).click();
  await expect(destination.getByRole('status')).toContainText('Initialization may have completed.');
  expect(server.initializations).toBe(1);
  await destination.getByRole('button', { name: 'Verify pending or saved repository' }).click();
  await expect(destination.getByRole('status')).toContainText('Verified destination:');
  expect(server.initializations).toBe(1);
});

test('initialization failure remains blocked rather than looping or reporting a ready destination', async ({
  extensionContext, progress,
}) => {
  const { server, destination } = await startSetup(extensionContext, progress);
  server.initializationUnknownFailure = true;
  await destination.getByLabel('I understand this repository will be public').check();
  await destination.getByRole('button', { name: 'Create public repository', exact: true }).click();
  await expect(destination.getByRole('status')).toContainText('Initialization may have completed.');
  await destination.getByRole('button', { name: 'Verify pending or saved repository' }).click();
  await expect(destination.getByRole('status')).toContainText('Initialization may have completed.');
  expect(server.initializations).toBe(1);
});

test('read-only connection never initializes a marker that disappears during verification', async ({
  extensionContext, progress,
}) => {
  const { server, destination } = await startSetup(extensionContext, progress);
  server.exists = true;
  server.marker = true;
  server.removeMarkerAfterRead = true;
  await destination.getByRole('button', { name: 'Connect existing repository', exact: true }).click();
  await expect(destination.getByRole('status')).toContainText('not a compatible public Progress Sync repository');
  await destination.getByRole('button', { name: 'Verify pending or saved repository' }).click();
  await expect(destination.getByRole('status')).toContainText('not a compatible public Progress Sync repository');
  expect(server.initializations).toBe(0);
});

test('a definitely rejected initialization can be retried after permission repair', async ({
  extensionContext, progress,
}) => {
  const { server, destination } = await startSetup(extensionContext, progress);
  server.initializationFails = true;
  await destination.getByLabel('I understand this repository will be public').check();
  await destination.getByRole('button', { name: 'Create public repository', exact: true }).click();
  await expect(destination.getByRole('status')).toContainText('Initialization was rejected.');
  server.initializationFails = false;
  await destination.getByRole('button', { name: 'Verify pending or saved repository' }).click();
  await expect(destination.getByRole('status')).toContainText('Verified destination:');
  expect(server.creations).toBe(1);
  expect(server.initializations).toBe(2);
});

test('installation and repository membership checks follow pagination', async ({
  extensionContext, progress,
}) => {
  const { server, destination } = await startSetup(extensionContext, progress);
  server.laterInstallationPage = true;
  server.laterRepositoryPage = true;
  await destination.getByLabel('I understand this repository will be public').check();
  await destination.getByRole('button', { name: 'Create public repository', exact: true }).click();
  await expect(destination.getByRole('status')).toContainText('Verified destination:');
  expect(server.requestsValid).toBe(true);
});

test('a recreated repository with the same name cannot silently replace the saved repository', async ({
  extensionContext, progress,
}) => {
  const { server, destination } = await startSetup(extensionContext, progress);
  await destination.getByLabel('I understand this repository will be public').check();
  await destination.getByRole('button', { name: 'Create public repository', exact: true }).click();
  await expect(destination.getByRole('status')).toContainText('Verified destination:');
  server.repositoryId = 102;
  await destination.getByRole('button', { name: 'Verify pending or saved repository' }).click();
  await expect(destination.getByRole('status')).toContainText('repository identity, owner, or visibility changed');
  expect(server.initializations).toBe(1);
});

test('a stale session confirmation cannot create a repository after reconnecting', async ({
  extensionContext, progress,
}) => {
  const { server, connection, destination } = await startSetup(extensionContext, progress);
  const connectionId = await destination.evaluate(async () => {
    const reply = await chrome.runtime.sendMessage({ type: 'destination:load' });
    const id: unknown = reply.view.connectionId;
    if (typeof id !== 'string') throw new Error('Expected a connection identity from destination setup.');
    return id;
  });
  await connection.getByRole('button', { name: 'Disconnect GitHub' }).click();
  await expect(connection.getByRole('status')).toHaveText('Not connected to GitHub.');
  await connection.getByRole('button', { name: 'Connect GitHub', exact: true }).click();
  await expect(connection.getByRole('status')).toHaveText('Connected as fixture-user');
  const rejected = await destination.evaluate(expectedConnectionId =>
    chrome.runtime.sendMessage({
      type: 'destination:create', name: 'progress-solutions', installationId: 77,
      publicConfirmed: true, expectedConnectionId,
    }), connectionId);
  expect(rejected).toEqual({ ok: false, error: 'session-changed' });
  expect(server.creations).toBe(0);
});

test('arbitrary operations from another extension page are rejected', async ({
  extensionContext, progress,
}) => {
  await githubFixture(extensionContext);
  const server = await destinationFixture(extensionContext);
  const reply = await progress.evaluate(() => chrome.runtime.sendMessage({
    type: 'destination:create', name: 'progress-solutions', installationId: 77, publicConfirmed: true,
    expectedConnectionId: '12345678-1234-4234-8234-123456789abc',
  }));
  expect(reply).toEqual({ ok: false, error: 'invalid-input' });
  expect(server.creations).toBe(0);
});

test('a missing selected branch never initializes or reports a verified destination', async ({
  extensionContext, progress,
}) => {
  const { server, destination } = await startSetup(extensionContext, progress);
  server.exists = true;
  server.marker = true;
  await destination.getByLabel('Branch (optional)').fill('missing-branch');
  await destination.getByRole('button', { name: 'Connect existing repository', exact: true }).click();
  await expect(destination.getByRole('status')).toContainText('selected branch is unavailable');
  expect(server.initializations).toBe(0);
});

test('discarding unresolved setup is explicit and never deletes the GitHub repository', async ({
  extensionContext, progress,
}) => {
  const { server, destination } = await startSetup(extensionContext, progress);
  server.loseCreationResponse = true;
  await destination.getByLabel('I understand this repository will be public').check();
  await destination.getByRole('button', { name: 'Create public repository', exact: true }).click();
  await expect(destination.getByRole('status')).toContainText('Creation may have completed.');
  await destination.getByRole('button', { name: 'Discard local setup record' }).click();
  await expect(destination.getByRole('status')).toHaveText('Confirm discarding only the local setup record.');
  await destination.getByLabel('Forget only the local setup record; leave any GitHub repository unchanged').check();
  await destination.getByRole('button', { name: 'Discard local setup record' }).click();
  await expect(destination.getByText('No destination selected.', { exact: true })).toBeVisible();
  expect(server.exists).toBe(true);
  expect(server.creations).toBe(1);
});

test('a creation validation rejection is not assumed to prove a name collision', async ({
  extensionContext, progress,
}) => {
  const { server, destination } = await startSetup(extensionContext, progress);
  await extensionContext.route('https://api.github.com/user/repos', route =>
    route.fulfill({ status: 422, json: { message: 'SYNTHETIC_VALIDATION_FAILURE' } }));
  await destination.getByLabel('I understand this repository will be public').check();
  await destination.getByRole('button', { name: 'Create public repository', exact: true }).click();
  await expect(destination.getByRole('status')).toContainText('GitHub rejected repository creation.');
  expect(server.exists).toBe(false);
  await destination.reload();
  await expect(destination.getByText('No destination selected.', { exact: true })).toBeVisible();
});

test('an explicit initialization rate limit allows an intentional retry after the limit is cleared', async ({
  extensionContext, progress,
}) => {
  const { server, destination } = await startSetup(extensionContext, progress);
  let limited = true;
  await extensionContext.route('https://api.github.com/repos/fixture-user/progress-solutions/contents/.progress-sync.json',
    route => limited && route.request().method() === 'PUT'
      ? route.fulfill({ status: 429, json: { message: 'Rate limit exceeded' } })
      : route.fallback());
  await destination.getByLabel('I understand this repository will be public').check();
  await destination.getByRole('button', { name: 'Create public repository', exact: true }).click();
  await expect(destination.getByRole('status')).toContainText('Initialization was rejected.');
  expect(server.initializations).toBe(0);
  limited = false;
  await destination.getByRole('button', { name: 'Verify pending or saved repository' }).click();
  await expect(destination.getByRole('status')).toContainText('Verified destination:');
  expect(server.creations).toBe(1);
  expect(server.initializations).toBe(1);
});
