import { expect, launchExtensionProfile, stopExtensionWorker, submittedBytes, submittedSource, test } from './fixtures';
import { CLIENT_ID, githubFixture, openConnection } from './github-fixture';
import { destinationFixture } from './destination-fixture';
import { publicationFixture } from './publication-fixture';
import { recoveryFixture } from './recovery-fixture';
import type { BrowserContext, Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import type { Browser } from 'wxt/browser';

declare const chrome: typeof Browser;

test.use({ githubClientId: CLIENT_ID });

async function authorize(context: BrowserContext, progress: Page) {
  const connection = await openConnection(context, progress);
  await connection.getByRole('button', { name: 'Connect GitHub', exact: true }).click();
  await expect(connection.getByRole('status')).toHaveText('Connected as fixture-user');
  const [destination] = await Promise.all([
    context.waitForEvent('page'),
    connection.getByRole('link', { name: 'Set up progress repository' }).click(),
  ]);
  await expect(destination.getByText('Owner: fixture-user', { exact: true })).toBeVisible();
  return { connection, destination };
}

function savedFiles(
  id = '11111111-1111-4111-8111-111111111111', problem = 'step_one', source = submittedBytes,
  metadata: Record<string, unknown> = {},
) {
  const root = `progress/hdlbits/${problem}/${id}`;
  return new Map([
    [`${root}/solution.v`, source],
    [`${root}/acceptance.json`, JSON.stringify({
      schemaVersion: 1, provider: 'hdlbits', problemId: problem, attemptId: id,
      sourceHash: createHash('sha256').update(source, 'utf8').digest('hex'),
      submittedAt: '2026-01-01T00:00:00.000Z', observedAt: '2026-01-01T00:00:01.000Z',
      provenance: { capture: 'browser-post', verdict: 'success' }, ...metadata,
    })],
  ]);
}

async function prepareRecovery(context: BrowserContext, progress: Page, files: Map<string, string>) {
  await githubFixture(context);
  const target = await destinationFixture(context);
  target.exists = true;
  target.marker = true;
  const remote = await recoveryFixture(context, target, { files });
  const pages = await authorize(context, progress);
  return { target, remote, ...pages };
}

test('a fresh browser recovers the published source and recorded acceptance without changing HDLBits', async ({
  extensionContext, progress, problem,
}, testInfo) => {
  await githubFixture(extensionContext);
  const originalDestination = await destinationFixture(extensionContext);
  const published = await publicationFixture(extensionContext, originalDestination);
  const original = await authorize(extensionContext, progress);
  await original.destination.getByLabel('I understand this repository will be public').check();
  await original.destination.getByRole('button', { name: 'Create public repository', exact: true }).click();
  await expect(original.destination.getByRole('status')).toContainText('Verified destination:');
  await problem.getByRole('textbox', { name: 'Solution' }).fill(submittedSource);
  await problem.getByRole('button', { name: 'Submit', exact: true }).click();
  await expect(progress.getByText('Saved to GitHub', { exact: true })).toBeVisible();
  const progressUrl = progress.url();
  const remoteFiles = new Map(published.files);
  const remoteHead = published.head;
  await extensionContext.close();

  const fresh = await launchExtensionProfile(testInfo.outputPath('extension'), testInfo.outputPath('fresh-profile'));
  try {
    const auth = await githubFixture(fresh);
    const target = await destinationFixture(fresh);
    target.exists = true;
    target.marker = true;
    const remote = await recoveryFixture(fresh, target, { files: remoteFiles, head: remoteHead });
    const restored = await fresh.newPage();
    await restored.goto(progressUrl);
    await expect(restored.getByRole('status')).toContainText('No captured attempts yet.');
    const guest = await fresh.newPage();
    await guest.goto('https://hdlbits.01xz.net/wiki/Step_one');
    await expect(guest.locator('#historical-status')).toHaveText('Not solved');
    await guest.getByRole('textbox', { name: 'Solution' }).fill('current editor draft');
    const returning = await authorize(fresh, restored);
    await returning.destination.getByRole('button', { name: 'Connect existing repository', exact: true }).click();
    await expect(returning.destination.getByRole('status')).toContainText('Verified destination:');

    await expect(restored.getByText('Recorded acceptance from GitHub', { exact: true })).toBeVisible();
    await expect(restored.getByRole('heading', { name: 'hdlbits:step_one', exact: true })).toBeVisible();
    await expect(restored.getByRole('textbox', { name: 'Recovered source (read-only)' })).toHaveValue(submittedSource);
    await expect(restored.getByText('e792e08eb073133e384987694229526ad3da6b1d3bcff73bada595e5f934dc0d', { exact: true }))
      .toBeVisible();
    await expect(restored.getByRole('link', { name: `Repository snapshot ${remoteHead}` }))
      .toHaveAttribute('href', `https://github.com/fixture-user/progress-solutions/commit/${remoteHead}`);
    await expect(restored.getByRole('status')).toContainText('No captured attempts yet.');
    await expect(guest.getByRole('textbox', { name: 'Solution' })).toHaveValue('current editor draft');
    await expect(guest.locator('#historical-status')).toHaveText('Not solved');
    expect(auth.deviceRequests).toBe(1);
    expect(target.creations).toBe(0);
    expect(remote.writes).toBe(0);
    expect(remote.requestsValid).toBe(true);
  } finally {
    await fresh.close();
  }
});

test('truncated recursive results are recovered completely through subtrees on a nonstandard branch', async ({
  extensionContext, progress,
}) => {
  const files = new Map([
    ...savedFiles(),
    ...savedFiles('22222222-2222-4222-8222-222222222222', 'zero'),
    ...savedFiles('33333333-3333-4333-8333-333333333333', 'wire'),
  ]);
  const { target, remote, destination } = await prepareRecovery(extensionContext, progress, files);
  target.defaultBranch = 'practice/verilog';
  target.laterInstallationPage = true;
  target.laterRepositoryPage = true;
  remote.truncateRecursive = true;
  await destination.getByRole('button', { name: 'Connect existing repository', exact: true }).click();
  await expect(destination.getByRole('status')).toHaveText('Verified destination: fixture-user/progress-solutions @ practice/verilog');
  await expect(progress.getByText('Recorded acceptance from GitHub', { exact: true })).toHaveCount(3);
  await expect(progress.locator('#recovery-status')).toHaveText('3 recorded accepted; 0 unverified saved entries.');
  expect(remote.reads.filter(read => read.path.includes('/git/trees/') && !read.recursive).length).toBeGreaterThan(3);
  expect(remote.writes).toBe(0);
});

const invalidRecords: {
  name: string; metadata?: Record<string, unknown>; body?: string; missingSource?: boolean; message: string;
}[] = [
  { name: 'malformed JSON', body: '{', message: 'Acceptance metadata is malformed or unsupported.' },
  { name: 'a newer schema', metadata: { schemaVersion: 2 }, message: 'Acceptance metadata is malformed or unsupported.' },
  { name: 'an unsupported provider', metadata: { provider: 'unknown-provider' }, message: 'Acceptance metadata is malformed or unsupported.' },
  { name: 'a hash mismatch', metadata: { sourceHash: '0'.repeat(64) }, message: 'The saved source hash does not match the acceptance record.' },
  { name: 'another problem identity', metadata: { problemId: 'wire' }, message: 'The record identity or observation timestamps do not match its saved attempt.' },
  { name: 'non-accepted provenance', metadata: { provenance: { capture: 'browser-post', verdict: 'failure' } }, message: 'Acceptance metadata is malformed or unsupported.' },
  { name: 'a missing source', missingSource: true, message: 'The acceptance record has no matching source file.' },
  { name: 'reversed observation times', metadata: { observedAt: '2025-01-01T00:00:00.000Z' }, message: 'The record identity or observation timestamps do not match its saved attempt.' },
];

for (const scenario of invalidRecords) {
  test(`saved progress with ${scenario.name} remains explicitly unverified`, async ({ extensionContext, progress }) => {
    const root = 'progress/hdlbits/step_one/11111111-1111-4111-8111-111111111111';
    const files = savedFiles(undefined, undefined, undefined, scenario.metadata);
    if (scenario.body !== undefined) files.set(`${root}/acceptance.json`, scenario.body);
    if (scenario.missingSource) files.delete(`${root}/solution.v`);
    const { remote, destination } = await prepareRecovery(extensionContext, progress, files);
    await destination.getByRole('button', { name: 'Connect existing repository', exact: true }).click();
    await expect(progress.locator('#recovery-status')).toHaveText('0 recorded accepted; 1 unverified saved entries.');
    await expect(progress.getByText(`Unverified saved file: ${scenario.message}`, { exact: true })).toBeVisible();
    await expect(progress.getByText('Recorded acceptance from GitHub', { exact: true })).toHaveCount(0);
    expect(remote.writes).toBe(0);
  });
}

test('a file-only import stays unverified and source text cannot execute in the progress page', async ({
  extensionContext, progress,
}) => {
  const source = '<script>globalThis.importedCodeRan = true</script>\n';
  const files = new Map([['legacy/solution.v', source]]);
  const { remote, destination } = await prepareRecovery(extensionContext, progress, files);
  await destination.getByRole('button', { name: 'Connect existing repository', exact: true }).click();
  await expect(progress.getByText('Unverified saved file: Acceptance metadata is missing or is not in a supported record path.', { exact: true })).toBeVisible();
  await expect(progress.getByRole('textbox', { name: 'Recovered source (read-only)' })).toHaveValue(source);
  expect(await progress.evaluate(() => Reflect.get(globalThis, 'importedCodeRan'))).toBeUndefined();
  await expect(progress.getByRole('button', { name: /^Publish accepted attempt to / })).toHaveCount(0);
  expect(remote.writes).toBe(0);
});

test('a UTF-8 source snapshot preserves its leading byte-order mark during recovery', async ({
  extensionContext, progress,
}) => {
  const source = String.fromCodePoint(0xfeff) + submittedBytes;
  const { destination } = await prepareRecovery(extensionContext, progress, savedFiles(undefined, undefined, source));
  await destination.getByRole('button', { name: 'Connect existing repository', exact: true }).click();
  await expect(progress.getByText('Recorded acceptance from GitHub', { exact: true })).toBeVisible();
  await expect(progress.getByRole('textbox', { name: 'Recovered source (read-only)' }))
    .toHaveValue(source.replaceAll('\r\n', '\n'));
});

test('a maximum-size source is recoverable when GitHub wraps the base64 response', async ({
  extensionContext, progress,
}) => {
  const source = ' '.repeat(256 * 1024 - submittedBytes.length) + submittedBytes;
  const sha = createHash('sha1').update(`blob ${Buffer.byteLength(source)}\0${source}`, 'utf8').digest('hex');
  const { destination } = await prepareRecovery(extensionContext, progress, savedFiles(undefined, undefined, source));
  await extensionContext.route(`https://api.github.com/repos/fixture-user/progress-solutions/git/blobs/${sha}`, route =>
    route.fulfill({ json: {
      sha, size: Buffer.byteLength(source), encoding: 'base64',
      content: Buffer.from(source).toString('base64').replace(/(.{60})/g, '$1\n'),
    } }));
  await destination.getByRole('button', { name: 'Connect existing repository', exact: true }).click();
  await expect(progress.getByText('Recorded acceptance from GitHub', { exact: true })).toBeVisible();
  await expect(progress.getByRole('textbox', { name: 'Recovered source (read-only)' }))
    .toHaveValue(source.replaceAll('\r\n', '\n'));
});

test('one corrupt record does not hide valid saved work or file-only warnings', async ({
  extensionContext, progress,
}) => {
  const files = new Map([
    ...savedFiles(),
    ...savedFiles('22222222-2222-4222-8222-222222222222', 'wire', submittedBytes, { sourceHash: '0'.repeat(64) }),
    ['legacy/old.v', submittedBytes],
  ]);
  const { destination } = await prepareRecovery(extensionContext, progress, files);
  await destination.getByRole('button', { name: 'Connect existing repository', exact: true }).click();
  await expect(progress.locator('#recovery-status')).toHaveText('1 recorded accepted; 2 unverified saved entries.');
});

for (const content of ['invalid-base64!', '/w==']) {
  test(`an invalid blob encoding ${content} cannot become recorded acceptance`, async ({ extensionContext, progress }) => {
    const { destination } = await prepareRecovery(extensionContext, progress, savedFiles());
    const sha = createHash('sha1').update(`blob ${Buffer.byteLength(submittedBytes)}\0${submittedBytes}`).digest('hex');
    await extensionContext.route(`https://api.github.com/repos/fixture-user/progress-solutions/git/blobs/${sha}`,
      route => route.fulfill({ json: { sha, size: 1, encoding: 'base64', content } }));
    await destination.getByRole('button', { name: 'Connect existing repository', exact: true }).click();
    await expect(progress.getByText('Unverified saved file: The source or metadata file is oversized, incorrectly encoded, or not a regular file.', { exact: true })).toBeVisible();
    await expect(progress.getByText('Recorded acceptance from GitHub', { exact: true })).toHaveCount(0);
  });
}

test('an incomplete shallow tree is an error rather than a successful partial recovery', async ({
  extensionContext, progress,
}) => {
  const { destination, remote } = await prepareRecovery(extensionContext, progress, savedFiles());
  remote.truncateRecursive = true;
  remote.truncateShallow = true;
  await destination.getByRole('button', { name: 'Connect existing repository', exact: true }).click();
  await expect(progress.locator('#recovery-status')).toHaveText('GitHub returned an incomplete or unsupported repository tree. Recovery did not finish.');
  await expect(progress.getByText('Recorded acceptance from GitHub', { exact: true })).toHaveCount(0);
  expect(remote.writes).toBe(0);
});

test('a failed refresh keeps only the previously completed snapshot and labels it stale', async ({
  extensionContext, progress,
}) => {
  const { destination, remote } = await prepareRecovery(extensionContext, progress, savedFiles());
  await destination.getByRole('button', { name: 'Connect existing repository', exact: true }).click();
  await expect(progress.locator('#recovery-status')).toHaveText('1 recorded accepted; 0 unverified saved entries.');
  remote.failStatus = 503;
  await progress.getByRole('button', { name: 'Refresh saved progress' }).click();
  await expect(progress.locator('#recovery-status')).toContainText('Saved progress could not be recovered.');
  await expect(progress.getByText('Showing the previously recovered snapshot, not a completed refresh.', { exact: true })).toBeVisible();
  await expect(progress.getByText('Recorded acceptance from GitHub', { exact: true })).toHaveCount(1);
  expect(remote.writes).toBe(0);
});

test('interrupted recovery survives a worker restart without publishing or silently resuming', async ({
  extensionContext, progress,
}) => {
  const { destination, remote } = await prepareRecovery(extensionContext, progress, savedFiles());
  await destination.getByRole('button', { name: 'Connect existing repository', exact: true }).click();
  await expect(progress.locator('#recovery-status')).toHaveText('1 recorded accepted; 0 unverified saved entries.');
  const gate = Promise.withResolvers<void>();
  remote.readGate = gate.promise;
  const reads = remote.reads.length;
  await progress.getByRole('button', { name: 'Refresh saved progress' }).click();
  await expect.poll(() => remote.reads.length).toBeGreaterThan(reads);
  await stopExtensionWorker(extensionContext, progress);
  await progress.reload();
  await expect(progress.locator('#recovery-status')).toHaveText('Recovery was interrupted. Refresh saved progress to try again.');
  await expect(progress.getByText('Showing the previously recovered snapshot, not a completed refresh.', { exact: true })).toBeVisible();
  remote.readGate = null;
  gate.resolve();
  await progress.getByRole('button', { name: 'Refresh saved progress' }).click();
  await expect(progress.locator('#recovery-status')).toHaveText('1 recorded accepted; 0 unverified saved entries.');
  expect(remote.writes).toBe(0);
});

test('disconnect invalidates an in-flight recovery without losing local captures', async ({
  extensionContext, progress, problem,
}) => {
  await problem.getByRole('textbox', { name: 'Solution' }).fill(submittedSource);
  await problem.getByRole('button', { name: 'Submit', exact: true }).click();
  await expect(progress.getByText('Accepted locally - not saved to GitHub', { exact: true })).toBeVisible();
  const { destination, connection, remote } = await prepareRecovery(extensionContext, progress, savedFiles());
  const gate = Promise.withResolvers<void>();
  remote.readGate = gate.promise;
  await destination.getByRole('button', { name: 'Connect existing repository', exact: true }).click();
  await expect.poll(() => remote.reads.length).toBeGreaterThan(0);
  await connection.getByRole('button', { name: 'Disconnect GitHub' }).click();
  await expect(connection.getByRole('status')).toHaveText('Not connected to GitHub.');
  remote.readGate = null;
  gate.resolve();
  await expect(progress.locator('#recovery-status')).toContainText('Connect GitHub and explicitly select an existing progress repository');
  await expect(progress.getByText('Recorded acceptance from GitHub', { exact: true })).toHaveCount(0);
  await expect(progress.getByRole('textbox', { name: 'Submitted source' })).toHaveValue(submittedSource);
  expect(remote.writes).toBe(0);
});

test('recovery commands reject arbitrary targets and wrong extension pages', async ({
  extensionContext, progress,
}) => {
  const { destination, connection, remote } = await prepareRecovery(extensionContext, progress, savedFiles());
  await destination.getByRole('button', { name: 'Connect existing repository', exact: true }).click();
  await expect(progress.locator('#recovery-status')).toHaveText('1 recorded accepted; 0 unverified saved entries.');
  const reads = remote.reads.length;
  const replies = await progress.evaluate(async () => {
    const view = await chrome.runtime.sendMessage({ type: 'recovery:list' });
    const input = {
      type: 'recovery:refresh', expectedConnectionId: view.selection.connectionId, expectedSelectionId: view.selection.operationId,
    };
    return Promise.all([
      chrome.runtime.sendMessage({ ...input, owner: 'attacker', repo: 'another', branch: 'main' }),
      chrome.runtime.sendMessage({ ...input, path: '../../secrets', url: 'https://unexpected.invalid' }),
      chrome.runtime.sendMessage({ type: 'recovery:request', method: 'DELETE' }),
    ]);
  });
  expect(replies).toEqual(Array(3).fill({ ok: false, error: 'Unsupported recovery operation or sender.' }));
  expect(await connection.evaluate(() => chrome.runtime.sendMessage({ type: 'recovery:list' })))
    .toEqual({ ok: false, error: 'Unsupported recovery operation or sender.' });
  expect(remote.reads).toHaveLength(reads);
  expect(remote.writes).toBe(0);
});

test('remote metadata cannot redirect privileged reads outside the selected repository', async ({
  extensionContext, progress,
}) => {
  const files = savedFiles(undefined, undefined, undefined, {
    sourcePath: 'https://unexpected.invalid/secret.v', owner: 'attacker', repo: 'elsewhere',
    request: { method: 'POST', url: 'https://unexpected.invalid/upload' },
  });
  let externalRequests = 0;
  await extensionContext.route('https://unexpected.invalid/**', route => {
    externalRequests++;
    return route.abort();
  });
  const { destination, remote } = await prepareRecovery(extensionContext, progress, files);
  await destination.getByRole('button', { name: 'Connect existing repository', exact: true }).click();
  await expect(progress.getByText('Unverified saved file: Acceptance metadata is malformed or unsupported.', { exact: true })).toBeVisible();
  expect(externalRequests).toBe(0);
  expect(remote.requestsValid).toBe(true);
  expect(remote.writes).toBe(0);
});

test('a stale refresh request cannot cancel a valid in-flight recovery or leave it stuck loading', async ({
  extensionContext, progress,
}) => {
  const { destination, remote } = await prepareRecovery(extensionContext, progress, savedFiles());
  const gate = Promise.withResolvers<void>();
  remote.readGate = gate.promise;
  await destination.getByRole('button', { name: 'Connect existing repository', exact: true }).click();
  await expect.poll(() => remote.reads.length).toBeGreaterThan(0);
  const reply = await progress.evaluate(async () => {
    const view = await chrome.runtime.sendMessage({ type: 'recovery:list' });
    return chrome.runtime.sendMessage({
      type: 'recovery:refresh', expectedConnectionId: view.selection.connectionId,
      expectedSelectionId: '99999999-9999-4999-8999-999999999999',
    });
  });
  expect(reply.ok).toBe(false);
  remote.readGate = null;
  gate.resolve();
  await expect(progress.locator('#recovery-status')).toHaveText('1 recorded accepted; 0 unverified saved entries.');
  await expect(progress.getByRole('button', { name: 'Refresh saved progress' })).toBeEnabled();
});

test('a superseded recovery cannot replace the snapshot from a newer explicit selection', async ({
  extensionContext, progress,
}) => {
  const { destination, target, remote } = await prepareRecovery(extensionContext, progress, savedFiles());
  const gate = Promise.withResolvers<void>();
  remote.readGate = gate.promise;
  await destination.getByRole('button', { name: 'Connect existing repository', exact: true }).click();
  await expect.poll(() => remote.reads.length).toBeGreaterThan(0);
  const replacement = await recoveryFixture(extensionContext, target, {
    files: savedFiles('22222222-2222-4222-8222-222222222222', 'wire'), head: 'c'.repeat(40),
  });
  await destination.getByRole('button', { name: 'Connect existing repository', exact: true }).click();
  await expect(progress.getByRole('heading', { name: 'hdlbits:wire', exact: true })).toBeVisible();
  await expect(progress.getByRole('link', { name: `Repository snapshot ${'c'.repeat(40)}` })).toBeVisible();
  gate.resolve();
  await progress.reload();
  await expect(progress.getByRole('heading', { name: 'hdlbits:wire', exact: true })).toBeVisible();
  await expect(progress.getByRole('heading', { name: 'hdlbits:step_one', exact: true })).toHaveCount(0);
  expect(remote.writes + replacement.writes).toBe(0);
});

test('invalid cached recovery data is reported without retaining a successful display', async ({
  extensionContext, progress,
}) => {
  const { destination } = await prepareRecovery(extensionContext, progress, savedFiles());
  await destination.getByRole('button', { name: 'Connect existing repository', exact: true }).click();
  await expect(progress.getByText('Recorded acceptance from GitHub', { exact: true })).toBeVisible();
  await progress.evaluate(() => new Promise<void>((resolve, reject) => {
    const request = indexedDB.open('progress-sync-recovery', 1);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      const transaction = db.transaction('states', 'readwrite');
      const cursor = transaction.objectStore('states').openCursor();
      cursor.onsuccess = () => {
        if (!cursor.result) {
          transaction.abort();
          reject(new Error('Expected a saved recovery cache.'));
          return;
        }
        cursor.result.update({ schemaVersion: 99 });
      };
      transaction.oncomplete = () => { db.close(); resolve(); };
      transaction.onabort = () => { db.close(); reject(transaction.error); };
    };
  }));
  const worker = extensionContext.serviceWorkers()[0];
  if (!worker) throw new Error('Expected the active extension worker.');
  await worker.evaluate(() => chrome.runtime.sendMessage({ type: 'recovery:changed' }));
  await expect(progress.locator('#recovery-status')).toHaveText('Saved recovery data is invalid. It has not been overwritten.');
  await expect(progress.getByText('Recorded acceptance from GitHub', { exact: true })).toHaveCount(0);
  await expect(progress.getByRole('status')).toContainText('No captured attempts yet.');
});

test('read-only recovery does not retry or confirm an uncertain local delivery job', async ({
  extensionContext, progress, problem,
}) => {
  await githubFixture(extensionContext);
  const target = await destinationFixture(extensionContext);
  const remote = await publicationFixture(extensionContext, target);
  const { destination } = await authorize(extensionContext, progress);
  await destination.getByLabel('I understand this repository will be public').check();
  await destination.getByRole('button', { name: 'Create public repository', exact: true }).click();
  await expect(destination.getByRole('status')).toContainText('Verified destination:');
  remote.loseResponseAt = 'ref';
  await problem.getByRole('textbox', { name: 'Solution' }).fill(submittedSource);
  await problem.getByRole('button', { name: 'Submit', exact: true }).click();
  await expect(progress.getByText('Publication outcome is uncertain.', { exact: false })).toBeVisible();
  const writes = remote.writes.length;
  await progress.getByRole('button', { name: 'Refresh saved progress' }).click();
  await expect(progress.getByText('Recorded acceptance from GitHub', { exact: true })).toBeVisible();
  await expect(progress.getByText('Publication outcome is uncertain.', { exact: false })).toBeVisible();
  await expect(progress.getByText('Saved to GitHub', { exact: true })).toHaveCount(0);
  expect(remote.writes).toHaveLength(writes);
  expect(remote.updates).toBe(1);
});

test('a complete archive larger than the Chrome local-storage quota remains recoverable after reload', async ({
  extensionContext, progress,
}) => {
  test.setTimeout(60_000);
  const source = ' '.repeat(256 * 1024 - submittedBytes.length) + submittedBytes;
  const files = new Map<string, string>();
  for (let index = 1; index <= 41; index++) {
    const id = `${index.toString(16).padStart(8, '0')}-1111-4111-8111-111111111111`;
    for (const [path, content] of savedFiles(id, 'step_one', source)) files.set(path, content);
  }
  const { destination, remote } = await prepareRecovery(extensionContext, progress, files);
  await destination.getByRole('button', { name: 'Connect existing repository', exact: true }).click();
  await expect(progress.getByText('Recorded acceptance from GitHub', { exact: true })).toHaveCount(41, { timeout: 30_000 });
  await progress.reload();
  await expect(progress.getByText('Recorded acceptance from GitHub', { exact: true })).toHaveCount(41);
  expect(await progress.evaluate(() => chrome.storage.local.getBytesInUse(null))).toBeLessThan(10 * 1024 * 1024);
  expect(remote.writes).toBe(0);
});

test('a late manual-refresh error cannot overwrite a newer successful recovery in the UI', async ({
  extensionContext, progress,
}) => {
  const { destination, target, remote } = await prepareRecovery(extensionContext, progress, savedFiles());
  await destination.getByRole('button', { name: 'Connect existing repository', exact: true }).click();
  await expect(progress.locator('#recovery-status')).toHaveText('1 recorded accepted; 0 unverified saved entries.');
  await progress.evaluate(() => {
    const original = chrome.runtime.sendMessage.bind(chrome.runtime);
    chrome.runtime.sendMessage = new Proxy(original, {
      async apply(target, receiver, args) {
        const reply: unknown = await Reflect.apply(target, receiver, args);
        if (args[0]?.type === 'recovery:refresh') Reflect.set(globalThis, 'manualRefreshFinished', true);
        return reply;
      },
    });
  });
  const gate = Promise.withResolvers<void>();
  remote.readGate = gate.promise;
  const reads = remote.reads.length;
  await progress.getByRole('button', { name: 'Refresh saved progress' }).click();
  await expect.poll(() => remote.reads.length).toBeGreaterThan(reads);
  await recoveryFixture(extensionContext, target, {
    files: savedFiles('22222222-2222-4222-8222-222222222222', 'wire'), head: 'c'.repeat(40),
  });
  await destination.getByRole('button', { name: 'Connect existing repository', exact: true }).click();
  await expect(progress.getByRole('heading', { name: 'hdlbits:wire', exact: true })).toBeVisible();
  gate.resolve();
  await expect.poll(() => progress.evaluate(() => Reflect.get(globalThis, 'manualRefreshFinished'))).toBe(true);
  await expect(progress.locator('#recovery-status')).toHaveText('1 recorded accepted; 0 unverified saved entries.');
});
