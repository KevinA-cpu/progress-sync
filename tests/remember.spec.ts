import { captureConsole, consoleOutput, expect, launchExtensionProfile, test } from './fixtures';
import type { BrowserContext, Page, TestInfo } from '@playwright/test';
import type { Browser } from 'wxt/browser';
import { resolve } from 'node:path';
import {
  ACCESS_TOKEN, CLIENT_ID, DEVICE_CODE, REFRESH_TOKEN, githubFixture, indexedDatabaseRecords, openConnection,
} from './github-fixture';
import { destinationFixture } from './destination-fixture';
import { publicationFixture } from './publication-fixture';
import { setup } from './publication-setup';

declare const chrome: typeof Browser;

const rememberLabel = 'Remember GitHub on this device';
const notRemembered = 'Not remembered. The connection ends when Chrome closes.';

const REMEMBER_KEY = 'github-remembered-connection-v1';

// Remembering is the one case where the access token is expected on disk, and only under the one key the user
// consented to. accessInLocal reports that key alone; every other local value is held to the same standard as
// synchronized storage, the page, IndexedDB and the console, so no other place can hold a credential unnoticed.
async function storedCredentials(page: Page) {
  const persisted = JSON.stringify(await indexedDatabaseRecords(page));
  const logged = consoleOutput(page.context()).join('\n');
  return page.evaluate(async ({ credentials, persisted, logged, rememberKey }) => {
    const [session, local, sync] = await Promise.all([
      chrome.storage.session.get(null), chrome.storage.local.get(null), chrome.storage.sync.get(null),
    ]);
    const { [rememberKey]: remembered, ...otherLocal } = local;
    const rememberedText = JSON.stringify(remembered ?? null);
    const elsewhere = [
      JSON.stringify(otherLocal), JSON.stringify(sync), document.documentElement.outerHTML, persisted, logged,
    ];
    return {
      accessInSession: JSON.stringify(session).includes(credentials.access),
      accessInLocal: rememberedText.includes(credentials.access),
      refreshInLocal: rememberedText.includes(credentials.refresh),
      deviceInLocal: rememberedText.includes(credentials.device),
      leakedElsewhere: elsewhere.some(text => Object.values(credentials).some(value => text.includes(value))),
    };
  }, {
    credentials: { access: ACCESS_TOKEN, refresh: REFRESH_TOKEN, device: DEVICE_CODE },
    persisted, logged, rememberKey: REMEMBER_KEY,
  });
}

// A genuine restart: the same profile and the same installed extension, with session storage gone.
async function restart(context: BrowserContext, testInfo: TestInfo): Promise<BrowserContext> {
  await context.close();
  const restarted = await launchExtensionProfile(
    resolve(testInfo.outputPath('extension')), testInfo.outputPath('profile'),
  );
  captureConsole(restarted);
  return restarted;
}

async function openConnectPage(context: BrowserContext): Promise<Page> {
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
  const page = await context.newPage();
  await page.goto(`chrome-extension://${new URL(worker.url()).hostname}/connect.html`);
  return page;
}

test.use({ githubClientId: CLIENT_ID });

test('the connection is not remembered unless the option is turned on', async ({
  extensionContext, progress,
}) => {
  await githubFixture(extensionContext);
  const connection = await openConnection(extensionContext, progress);
  const remember = connection.getByRole('checkbox', { name: rememberLabel });
  await expect(remember).not.toBeChecked();
  await expect(connection.getByText(notRemembered, { exact: true })).toBeVisible();
  await connection.getByRole('button', { name: 'Connect GitHub', exact: true }).click();
  await expect(connection.getByRole('status')).toHaveText('Connected as fixture-user');

  await expect(remember).not.toBeChecked();
  expect(await storedCredentials(connection)).toEqual({
    accessInSession: true, accessInLocal: false, refreshInLocal: false, deviceInLocal: false, leakedElsewhere: false,
  });
});

test('a remembered connection resumes after a browser restart once its own destination revalidates', async ({
  extensionContext, progress,
}, testInfo) => {
  const { target } = await setup(extensionContext, progress);
  const connection = await openConnection(extensionContext, progress);
  await connection.getByRole('checkbox', { name: rememberLabel }).check();
  await expect(connection.getByText('Remembered on this device until the original expiry', { exact: false }))
    .toBeVisible();
  expect(await storedCredentials(connection)).toEqual({
    accessInSession: true, accessInLocal: true, refreshInLocal: false, deviceInLocal: false, leakedElsewhere: false,
  });

  const restarted = await restart(extensionContext, testInfo);
  try {
    const auth = await githubFixture(restarted);
    const restartedTarget = await destinationFixture(restarted);
    restartedTarget.exists = true;
    restartedTarget.marker = true;
    restartedTarget.repositoryId = target.repositoryId;
    await publicationFixture(restarted, restartedTarget);
    const page = await openConnectPage(restarted);

    await expect(page.getByRole('status')).toHaveText('Connected as fixture-user');
    await expect(page.getByRole('checkbox', { name: rememberLabel })).toBeChecked();
    expect(auth.identityRequests).toBeGreaterThanOrEqual(1);
    expect(auth.deviceRequests).toBe(0);
    expect(auth.tokenRequestTimes).toHaveLength(0);
    expect(restartedTarget.requestsValid).toBe(true);
  } finally {
    await restarted.close();
  }
});

test('a remembered connection whose destination is no longer authorized resumes nothing', async ({
  extensionContext, progress,
}, testInfo) => {
  await setup(extensionContext, progress);
  const connection = await openConnection(extensionContext, progress);
  await connection.getByRole('checkbox', { name: rememberLabel }).check();
  await expect(connection.getByText('Remembered on this device until', { exact: false })).toBeVisible();

  const restarted = await restart(extensionContext, testInfo);
  try {
    await githubFixture(restarted);
    const restartedTarget = await destinationFixture(restarted);
    restartedTarget.exists = true;
    restartedTarget.marker = true;
    restartedTarget.included = false;
    await publicationFixture(restarted, restartedTarget);
    const page = await openConnectPage(restarted);

    await expect(page.getByRole('status')).toHaveText(
      'The remembered connection is no longer authorized for the repository that was selected.'
      + ' Nothing was resumed or redirected. Connect and verify the destination again.',
    );
    expect((await storedCredentials(page)).accessInLocal).toBe(false);
    expect((await storedCredentials(page)).accessInSession).toBe(false);
  } finally {
    await restarted.close();
  }
});

test('an unreachable GitHub keeps the remembered credential and a rejected one withdraws it', async ({
  extensionContext, progress,
}, testInfo) => {
  await setup(extensionContext, progress);
  const connection = await openConnection(extensionContext, progress);
  await connection.getByRole('checkbox', { name: rememberLabel }).check();
  await expect(connection.getByText('Remembered on this device until', { exact: false })).toBeVisible();

  const restarted = await restart(extensionContext, testInfo);
  try {
    const auth = await githubFixture(restarted);
    // Registered after the fixture so it takes precedence; falling back reaches the fixture again.
    let offline = true;
    await restarted.route('https://api.github.com/user', route =>
      offline ? route.abort('internetdisconnected') : route.fallback());
    const page = await openConnectPage(restarted);

    await expect(page.getByRole('status')).toHaveText(
      'The remembered connection could not be checked with GitHub yet.'
      + ' It is still kept and will be checked again; nothing has resumed.',
    );
    expect((await storedCredentials(page)).accessInLocal).toBe(true);
    expect((await storedCredentials(page)).accessInSession).toBe(false);

    // A refusal that is not an outright rejection of the credential is not read as revocation either.
    offline = false;
    auth.identityStatus = 403;
    await page.reload();

    await expect(page.getByRole('status')).toHaveText(
      'The remembered connection could not be checked with GitHub yet.'
      + ' It is still kept and will be checked again; nothing has resumed.',
    );
    expect((await storedCredentials(page)).accessInLocal).toBe(true);

    auth.identityStatus = 401;
    await page.reload();

    await expect(page.getByRole('status')).toHaveText('GitHub authorization was rejected. Connect again.');
    expect((await storedCredentials(page)).accessInLocal).toBe(false);
  } finally {
    await restarted.close();
  }
});

test('a remembered credential past its original expiry is withdrawn and never renewed', async ({
  extensionContext, progress,
}, testInfo) => {
  await setup(extensionContext, progress);
  const connection = await openConnection(extensionContext, progress);
  await connection.getByRole('checkbox', { name: rememberLabel }).check();
  await expect(connection.getByText('Remembered on this device until', { exact: false })).toBeVisible();
  // The original expiry is what the stored copy lives by, so the test moves that and nothing else.
  const expired = await connection.evaluate(async key => {
    const stored = (await chrome.storage.local.get(key))[key] as { expiresAt: string } | undefined;
    if (!stored) return null;
    const before = stored.expiresAt;
    await chrome.storage.local.set({ [key]: { ...stored, expiresAt: new Date(Date.now() - 1000).toISOString() } });
    return before;
  }, REMEMBER_KEY);
  expect(expired).not.toBeNull();

  const restarted = await restart(extensionContext, testInfo);
  try {
    const auth = await githubFixture(restarted);
    const page = await openConnectPage(restarted);

    await expect(page.getByRole('status')).toHaveText('The GitHub session expired. Connect again.');
    expect((await storedCredentials(page)).accessInLocal).toBe(false);
    expect((await storedCredentials(page)).accessInSession).toBe(false);
    // Nothing was renewed or refreshed on the way out.
    expect(auth.identityRequests).toBe(0);
    expect(auth.tokenRequestTimes).toHaveLength(0);
    expect(auth.deviceRequests).toBe(0);
  } finally {
    await restarted.close();
  }
});

test('a remembered credential that now answers as another account is withdrawn', async ({
  extensionContext, progress,
}, testInfo) => {
  await setup(extensionContext, progress);
  const connection = await openConnection(extensionContext, progress);
  await connection.getByRole('checkbox', { name: rememberLabel }).check();
  await expect(connection.getByText('Remembered on this device until', { exact: false })).toBeVisible();

  const restarted = await restart(extensionContext, testInfo);
  try {
    const auth = await githubFixture(restarted);
    auth.identityUser = { id: 4242, login: 'someone-else' };
    const page = await openConnectPage(restarted);

    await expect(page.getByRole('status')).toHaveText('GitHub identity could not be verified. Connect again.');
    expect((await storedCredentials(page)).accessInLocal).toBe(false);
    expect((await storedCredentials(page)).accessInSession).toBe(false);
  } finally {
    await restarted.close();
  }
});

test('turning the option off withdraws the stored credential immediately', async ({
  extensionContext, progress,
}, testInfo) => {
  await githubFixture(extensionContext);
  const connection = await openConnection(extensionContext, progress);
  await connection.getByRole('button', { name: 'Connect GitHub', exact: true }).click();
  await expect(connection.getByRole('status')).toHaveText('Connected as fixture-user');
  await connection.getByRole('checkbox', { name: rememberLabel }).check();
  await expect(connection.getByText('Remembered on this device until', { exact: false })).toBeVisible();
  await connection.getByRole('checkbox', { name: rememberLabel }).uncheck();

  await expect(connection.getByText(notRemembered, { exact: true })).toBeVisible();
  expect((await storedCredentials(connection)).accessInLocal).toBe(false);
  const restarted = await restart(extensionContext, testInfo);
  try {
    await githubFixture(restarted);
    const page = await openConnectPage(restarted);
    await expect(page.getByRole('status')).toHaveText('Not connected to GitHub.');
    await expect(page.getByRole('checkbox', { name: rememberLabel })).not.toBeChecked();
  } finally {
    await restarted.close();
  }
});

test('disconnecting withdraws the stored credential', async ({ extensionContext, progress }, testInfo) => {
  await githubFixture(extensionContext);
  const connection = await openConnection(extensionContext, progress);
  await connection.getByRole('button', { name: 'Connect GitHub', exact: true }).click();
  await expect(connection.getByRole('status')).toHaveText('Connected as fixture-user');
  await connection.getByRole('checkbox', { name: rememberLabel }).check();
  await expect(connection.getByText('Remembered on this device until', { exact: false })).toBeVisible();
  await connection.getByRole('button', { name: 'Disconnect GitHub' }).click();

  await expect(connection.getByRole('status')).toHaveText('Not connected to GitHub.');
  expect((await storedCredentials(connection)).accessInLocal).toBe(false);
  const restarted = await restart(extensionContext, testInfo);
  try {
    await githubFixture(restarted);
    const page = await openConnectPage(restarted);
    await expect(page.getByRole('status')).toHaveText('Not connected to GitHub.');
  } finally {
    await restarted.close();
  }
});

test('turning the option off during a slow restore cannot be undone by its late response', async ({
  extensionContext, progress,
}, testInfo) => {
  await githubFixture(extensionContext);
  const connection = await openConnection(extensionContext, progress);
  await connection.getByRole('button', { name: 'Connect GitHub', exact: true }).click();
  await expect(connection.getByRole('status')).toHaveText('Connected as fixture-user');
  await connection.getByRole('checkbox', { name: rememberLabel }).check();
  await expect(connection.getByText('Remembered on this device until', { exact: false })).toBeVisible();

  const restarted = await restart(extensionContext, testInfo);
  try {
    const auth = await githubFixture(restarted);
    const gate = Promise.withResolvers<void>();
    auth.identityGate = gate.promise;
    const page = await openConnectPage(restarted);
    await expect.poll(() => auth.identityRequests).toBeGreaterThanOrEqual(1);
    await page.getByRole('checkbox', { name: rememberLabel }).uncheck();
    await expect(page.getByText(notRemembered, { exact: true })).toBeVisible();
    gate.resolve();

    await expect(page.getByRole('status')).toHaveText('Not connected to GitHub.');
    await expect(page.getByText('Connected as fixture-user', { exact: true })).toHaveCount(0);
    expect((await storedCredentials(page)).accessInLocal).toBe(false);
    expect((await storedCredentials(page)).accessInSession).toBe(false);
  } finally {
    await restarted.close();
  }
});

const PREFERENCE_KEY = 'github-remember-preference-v1';
const unreadable = 'Remembered connection data is present in this browser profile but could not be read,'
  + ' so it is not being used and nothing was resumed. It has not been treated as "off" or as absent.'
  + ' Connect again, or turn remembering off, to replace it.';

async function corrupt(page: Page, key: string, change: Record<string, unknown>): Promise<void> {
  await page.evaluate(async ([key, change]) => {
    const stored = (await chrome.storage.local.get(key as string))[key as string] as Record<string, unknown>;
    if (stored === undefined) throw new Error(`Nothing is stored under ${String(key)}.`);
    await chrome.storage.local.set({ [key as string]: { ...stored, ...change as Record<string, unknown> } });
  }, [key, change] as const);
}

function storedKey(page: Page, key: string): Promise<boolean> {
  return page.evaluate(async key => (await chrome.storage.local.get(key))[key] !== undefined, key);
}

test('a remembered credential that cannot be read is reported rather than read as nothing saved', async ({
  extensionContext, progress,
}, testInfo) => {
  await setup(extensionContext, progress);
  const connection = await openConnection(extensionContext, progress);
  await connection.getByRole('checkbox', { name: rememberLabel }).check();
  await expect(connection.getByText('Remembered on this device until', { exact: false })).toBeVisible();
  // The token itself is left intact, so only the refusal to parse can keep it from being used.
  await corrupt(connection, REMEMBER_KEY, { rememberedAt: 'whenever' });

  const restarted = await restart(extensionContext, testInfo);
  try {
    const auth = await githubFixture(restarted);
    const page = await openConnectPage(restarted);

    await expect(page.locator('#remember-state')).toHaveText(unreadable);
    await expect(page.locator('#remember-state')).toHaveAttribute('role', 'alert');
    await expect(page.getByText(notRemembered, { exact: true })).toHaveCount(0);
    await expect(page.getByRole('status')).toHaveText('Not connected to GitHub.');
    // The credential was never sent anywhere, and it was not deleted behind the user's back either.
    expect(auth.identityRequests).toBe(0);
    expect(auth.deviceRequests).toBe(0);
    expect(auth.tokenRequestTimes).toHaveLength(0);
    expect(await storedKey(page, REMEMBER_KEY)).toBe(true);
    expect((await storedCredentials(page)).accessInSession).toBe(false);

    // Turning the option off is what replaces it; nothing else silently did.
    await page.getByRole('checkbox', { name: rememberLabel }).uncheck();
    await expect(page.getByText(notRemembered, { exact: true })).toBeVisible();
    expect(await storedKey(page, REMEMBER_KEY)).toBe(false);
  } finally {
    await restarted.close();
  }
});

test('a remember preference that cannot be read is not reported as the option being off', async ({
  extensionContext, progress,
}, testInfo) => {
  const { target } = await setup(extensionContext, progress);
  const connection = await openConnection(extensionContext, progress);
  await connection.getByRole('checkbox', { name: rememberLabel }).check();
  await expect(connection.getByText('Remembered on this device until', { exact: false })).toBeVisible();
  await corrupt(connection, PREFERENCE_KEY, { enabled: 'yes' });

  const restarted = await restart(extensionContext, testInfo);
  try {
    const auth = await githubFixture(restarted);
    const restartedTarget = await destinationFixture(restarted);
    restartedTarget.exists = true;
    restartedTarget.marker = true;
    restartedTarget.repositoryId = target.repositoryId;
    await publicationFixture(restarted, restartedTarget);
    const page = await openConnectPage(restarted);

    await expect(page.locator('#remember-state')).toHaveText(unreadable);
    await expect(page.getByText(notRemembered, { exact: true })).toHaveCount(0);
    // An unreadable preference is not read as consent, so the credential it guards stays unused.
    expect(auth.identityRequests).toBe(0);
    expect((await storedCredentials(page)).accessInSession).toBe(false);
    expect(await storedKey(page, REMEMBER_KEY)).toBe(true);

    // Recording the choice again replaces the unreadable preference, and the credential it guarded is intact.
    await page.getByRole('checkbox', { name: rememberLabel }).check();
    await expect(page.getByText('Remembered on this device until', { exact: false })).toBeVisible();
    await page.reload();
    await expect(page.getByRole('status')).toHaveText('Connected as fixture-user');
  } finally {
    await restarted.close();
  }
});

test('only the connection page may change the option', async ({ extensionContext, progress }) => {
  await githubFixture(extensionContext);
  const connection = await openConnection(extensionContext, progress);
  await connection.getByRole('button', { name: 'Connect GitHub', exact: true }).click();
  await expect(connection.getByRole('status')).toHaveText('Connected as fixture-user');

  const denied = await progress.evaluate(async () => {
    const options = await chrome.runtime.sendMessage({
      type: 'github:remember', enabled: true, consentAcknowledged: true,
    });
    return options as { ok: boolean; error?: string };
  });
  expect(denied).toEqual({ ok: false, error: 'not-allowed' });
  const unacknowledged = await connection.evaluate(async () => await chrome.runtime.sendMessage({
    type: 'github:remember', enabled: true, consentAcknowledged: false,
  }));
  expect(unacknowledged).toEqual({ ok: false, error: 'not-allowed' });
  expect((await storedCredentials(connection)).accessInLocal).toBe(false);
});
