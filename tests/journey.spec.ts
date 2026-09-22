import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Page } from '@playwright/test';
import type { Browser } from 'wxt/browser';
import { z } from 'zod';
import {
  advanceDeliverySchedule, deliveryAlarm, expect, launchExtensionProfile, submittedSource, successPage, test,
} from './fixtures';
import {
  ACCESS_TOKEN, CLIENT_ID, DEVICE_CODE, REFRESH_TOKEN, credentialSummary, githubFixture, openConnection,
} from './github-fixture';
import { destinationFixture } from './destination-fixture';
import { publicationFixture } from './publication-fixture';
import { recoveryFixture } from './recovery-fixture';
import { setup } from './publication-setup';
import { deliveryView, observeApi, retryName, submit } from './delivery-view';

declare const chrome: typeof Browser;

test.use({ githubClientId: CLIENT_ID });

type Published = Awaited<ReturnType<typeof publicationFixture>>;
type Auth = Awaited<ReturnType<typeof githubFixture>>;

const sentinels = [ACCESS_TOKEN, REFRESH_TOKEN, DEVICE_CODE];
const noCredentials = {
  accessInSession: false, refreshInSession: false, deviceInSession: false, leakedOutsideSession: false,
};
const connectedCredentials = { ...noCredentials, accessInSession: true };
const verifiedDestination = 'Verified destination: fixture-user/progress-solutions @ learning';
const publishOlderName = 'Publish accepted attempt to fixture-user/progress-solutions @ learning (public)';
const emptyRecovery = '0 recorded accepted; 0 recorded failed; 0 imported unverified; 0 unverified saved entries.';
const placeholderMarker = JSON.stringify({
  kind: 'progress-sync', schemaVersion: 1, initializationId: '12345678-1234-4234-8234-123456789abc',
});

function sourceHash(bytes: string): string {
  return createHash('sha256').update(bytes, 'utf8').digest('hex');
}

function acceptanceRecord(problemId: string, attemptId: string, bytes: string, report: string) {
  return {
    schemaVersion: 1, provider: 'hdlbits', problemId, attemptId, sourceHash: sourceHash(bytes),
    submittedAt: expect.any(String), observedAt: expect.any(String),
    reportHash: sourceHash(report), reportBytes: Buffer.byteLength(report),
    provenance: { capture: 'browser-post', verdict: 'success' },
  };
}

async function savedAttempt(progress: Page, problemId: string, source: string) {
  const bytes = source.replaceAll('\n', '\r\n');
  const job = (await deliveryView(progress)).jobs.find(item => item.snapshot.source === bytes);
  if (!job) throw new Error('Expected a delivery job holding the submitted source.');
  return { id: job.id, problemId, source, bytes, target: job.target, receipt: job.receipt, state: job.state };
}

function expectPublishedFiles(
  published: Published, marker: string, records: Array<{ id: string; problemId: string; bytes: string }>,
): void {
  for (const record of records) {
    const root = `progress/hdlbits/${record.problemId}/${record.id}`;
    expect(published.files.get(`${root}/solution.v`)).toBe(record.bytes);
    const report = published.files.get(`${root}/report.json`);
    expect(report).toBeDefined();
    expect(JSON.parse(published.files.get(`${root}/acceptance.json`) ?? 'null'))
      .toEqual(acceptanceRecord(record.problemId, record.id, record.bytes, report!));
  }
  // Each accepted record is its source, its acceptance metadata, and the report observed with it.
  expect([...published.files.keys()].filter(path => path.startsWith('progress/'))).toHaveLength(records.length * 3);
  expect(published.files.get('README.md')).toBe('Keep this learner file.\n');
  expect(published.files.get('.progress-sync.json')).toBe(marker);
}

function expectNoCredentialTraces(published: Published, auth: Auth): void {
  expect([...published.files.values()].some(content => sentinels.some(value => content.includes(value)))).toBe(false);
  expect(sentinels.some(value => JSON.stringify(published.writes).includes(value))).toBe(false);
  expect(auth.logs.some(line => line.includes('SENSITIVE_FIXTURE_DETAIL')
    || sentinels.some(value => line.includes(value)))).toBe(false);
  expect(auth.requestChecks.every(Boolean)).toBe(true);
}

function expectOnboardingMarker(marker: string): void {
  expect(JSON.parse(marker)).toMatchObject({
    kind: 'progress-sync', schemaVersion: 1,
    initializationId: expect.stringMatching(/^[0-9a-f-]{36}$/),
  });
  expect(marker).not.toBe(placeholderMarker);
}

test('the guest journey reaches accepted publication and is restored in a fresh browser', async ({
  extensionContext, progress, problem,
}, testInfo) => {
  test.setTimeout(120_000);
  const guestSource = `// Captured before connecting GitHub\n${submittedSource}`;
  const connectedSource = `// Captured after the destination was verified\n${submittedSource}`;
  await submit(problem, guestSource);
  await expect(progress.getByText('Accepted locally - not saved to GitHub', { exact: true })).toBeVisible();

  const auth = await githubFixture(extensionContext);
  const target = await destinationFixture(extensionContext);
  const published = await publicationFixture(extensionContext, target);
  const connection = await openConnection(extensionContext, progress);
  await connection.getByRole('button', { name: 'Connect GitHub', exact: true }).click();
  await expect(connection.getByRole('status')).toHaveText('Connected as fixture-user');
  const [destination] = await Promise.all([
    extensionContext.waitForEvent('page'),
    connection.getByRole('link', { name: 'Set up progress repository' }).click(),
  ]);
  await destination.getByLabel('I understand this repository will be public').check();
  await destination.getByRole('button', { name: 'Create public repository', exact: true }).click();
  await expect(destination.getByRole('status')).toHaveText(verifiedDestination);
  expect(auth.deviceRequests).toBe(1);
  expect(target.creations).toBe(1);
  expect(target.initializations).toBe(1);
  expect(target.requestsValid).toBe(true);
  const marker = target.markerContent;
  expectOnboardingMarker(marker);
  // The read-only scan of the new repository also snapshots its remote tree before any publication.
  await progress.getByRole('button', { name: 'Refresh saved progress' }).click();
  await expect(progress.locator('#recovery-status')).toHaveText(emptyRecovery);
  expect(published.files.get('.progress-sync.json')).toBe(marker);
  expect(await credentialSummary(progress)).toEqual(connectedCredentials);
  expectNoCredentialTraces(published, auth);

  await submit(problem, connectedSource);
  await expect(progress.getByText('Saved to GitHub', { exact: true })).toBeVisible();
  await expect(progress.getByText('Accepted locally - not saved to GitHub', { exact: true })).toHaveCount(1);
  expect(published.updates).toBe(1);
  await progress.reload();
  await progress.getByRole('button', { name: publishOlderName, exact: true }).click();
  await expect(progress.getByText('Saved to GitHub', { exact: true })).toHaveCount(2);

  const records = [
    await savedAttempt(progress, 'step_one', guestSource),
    await savedAttempt(progress, 'step_one', connectedSource),
  ];
  expect(records.map(record => record.state)).toEqual(['saved', 'saved']);
  expect(new Set(records.map(record => record.id)).size).toBe(2);
  expect(new Set(records.map(record => record.receipt?.commitSha)).size).toBe(2);
  expectPublishedFiles(published, marker, records);
  expect(published.updates).toBe(2);
  expect(published.requestsValid).toBe(true);
  expect(await credentialSummary(progress)).toEqual(connectedCredentials);
  expectNoCredentialTraces(published, auth);

  const remoteFiles = new Map(published.files);
  const remoteHead = published.head;
  const progressUrl = progress.url();
  await extensionContext.close();

  const fresh = await launchExtensionProfile(testInfo.outputPath('extension'), testInfo.outputPath('fresh-profile'));
  try {
    const freshAuth = await githubFixture(fresh);
    const freshTarget = await destinationFixture(fresh);
    freshTarget.exists = true;
    freshTarget.marker = true;
    freshTarget.markerContent = marker;
    expect(remoteFiles.get('.progress-sync.json')).toBe(marker);
    const remote = await recoveryFixture(fresh, freshTarget, { files: remoteFiles, head: remoteHead });
    const restored = await fresh.newPage();
    await restored.goto(progressUrl);
    await expect(restored.getByRole('status')).toContainText('No captured attempts yet.');
    expect(await credentialSummary(restored)).toEqual(noCredentials);
    const guest = await fresh.newPage();
    await guest.goto('https://hdlbits.01xz.net/wiki/Step_one');
    await guest.getByRole('textbox', { name: 'Solution' }).fill('draft that must survive recovery');

    const freshConnection = await openConnection(fresh, restored);
    await freshConnection.getByRole('button', { name: 'Connect GitHub', exact: true }).click();
    await expect(freshConnection.getByRole('status')).toHaveText('Connected as fixture-user');
    const [freshDestination] = await Promise.all([
      fresh.waitForEvent('page'),
      freshConnection.getByRole('link', { name: 'Set up progress repository' }).click(),
    ]);
    await freshDestination.getByRole('button', { name: 'Connect existing repository', exact: true }).click();
    await expect(freshDestination.getByRole('status')).toHaveText(verifiedDestination);

    await expect(restored.locator('#recovery-status')).toHaveText('2 recorded accepted; 0 recorded failed; 0 imported unverified; 0 unverified saved entries.');
    for (const record of records) {
      const entry = restored.locator('#recovered-entries article').filter({ hasText: record.id });
      await expect(entry.getByRole('heading', { name: `hdlbits:${record.problemId}`, exact: true })).toBeVisible();
      await expect(entry.getByText('Recorded acceptance from GitHub', { exact: true })).toBeVisible();
      await expect(entry.getByRole('textbox', { name: 'Recovered source (read-only)' })).toHaveValue(record.source);
      await expect(entry.getByText(sourceHash(record.bytes), { exact: true })).toBeVisible();
    }
    await expect(restored.getByRole('link', { name: `Repository snapshot ${remoteHead}` }))
      .toHaveAttribute('href', `https://github.com/fixture-user/progress-solutions/commit/${remoteHead}`);
    await expect(restored.getByRole('status')).toContainText('No captured attempts yet.');
    await expect(guest.getByRole('textbox', { name: 'Solution' })).toHaveValue('draft that must survive recovery');
    await expect(guest.locator('#historical-status')).toHaveText('Not solved');
    expect(freshAuth.deviceRequests).toBe(1);
    expect(freshAuth.requestChecks.every(Boolean)).toBe(true);
    expect(freshAuth.logs.some(line => line.includes('SENSITIVE_FIXTURE_DETAIL')
      || sentinels.some(value => line.includes(value)))).toBe(false);
    expect(freshTarget.creations).toBe(0);
    expect(freshTarget.initializations).toBe(0);
    expect(freshTarget.markerContent).toBe(marker);
    expect(remote.writes).toBe(0);
    expect(remote.requestsValid).toBe(true);
    expect(await credentialSummary(restored)).toEqual(connectedCredentials);
  } finally {
    await fresh.close();
  }
});

test('interrupted, reconnected, duplicated, and rebased deliveries keep one effective publication per attempt', async ({
  extensionContext, progress, problem,
}) => {
  test.setTimeout(120_000);
  const { auth, target, server, connection, page } = await setup(extensionContext, progress);
  const marker = target.markerContent;
  expectOnboardingMarker(marker);
  const firstSource = `// First tab\n${submittedSource}`;
  const secondSource = `// Zero tab\n${submittedSource}`;
  const firstGrading = Promise.withResolvers<void>();
  const secondGrading = Promise.withResolvers<void>();
  await extensionContext.route('**/runsim.php', async route => {
    const zero = (route.request().postData() ?? '').includes('// Zero tab');
    await (zero ? secondGrading : firstGrading).promise;
    await route.fulfill({
      contentType: 'text/html', body: zero ? successPage.replaceAll('step_one', 'zero') : successPage,
    });
  });
  const second = await extensionContext.newPage();
  await second.goto('https://hdlbits.01xz.net/wiki/Zero');

  const gate = Promise.withResolvers<void>();
  try {
    await submit(problem, firstSource);
    await expect(progress.getByText('Waiting for the result - not saved to GitHub', { exact: true })).toHaveCount(1);
    await submit(second, secondSource);
    await expect(progress.getByText('Waiting for the result - not saved to GitHub', { exact: true })).toHaveCount(2);
    await problem.getByRole('textbox', { name: 'Solution' }).fill('first tab edited while grading');
    await second.getByRole('textbox', { name: 'Solution' }).fill('second tab edited while grading');

    // The later submission is graded first and loses the response to its reference update.
    server.loseResponseAt = 'ref';
    secondGrading.resolve();
    await expect(progress.getByText('Publication outcome is uncertain.', { exact: false })).toHaveCount(1);
    server.loseResponseAt = null;
    expect(server.updates).toBe(1);

    server.refGate = gate.promise;
    firstGrading.resolve();
    await expect.poll(() => server.writes.filter(write => write.method === 'PATCH').length).toBe(2);
    server.commitFiles({ 'notes.txt': 'Another writer keeps notes.\n' });
    gate.resolve();
    await expect(progress.getByText('Saved to GitHub', { exact: true })).toHaveCount(1);
  } finally {
    firstGrading.resolve();
    secondGrading.resolve();
    gate.resolve();
  }
  await expect(progress.getByText('Publication outcome is uncertain.', { exact: false })).toHaveCount(1);
  expect(server.files.get('notes.txt')).toBe('Another writer keeps notes.\n');
  expect(server.updates).toBe(2);
  const interrupted = await savedAttempt(progress, 'zero', secondSource);
  expect(interrupted.state).toBe('uncertain');
  expect(interrupted.receipt).toBeNull();
  await expect(problem.getByRole('textbox', { name: 'Solution' })).toHaveValue('first tab edited while grading');
  await expect(second.getByRole('textbox', { name: 'Solution' })).toHaveValue('second tab edited while grading');

  const captured = await progress.evaluate(() => chrome.runtime.sendMessage({ type: 'progress:list' }));
  expect(captured.ok).toBe(true);
  expect(captured.attempts.map((attempt: { source: string }) => attempt.source).sort())
    .toEqual([firstSource, secondSource].map(source => source.replaceAll('\n', '\r\n')).sort());
  expect(captured.attempts.every((attempt: { state: string }) => attempt.state === 'accepted')).toBe(true);
  for (const key of ['tabId', 'requestId', 'resultDocumentId'] as const) {
    expect(new Set(captured.attempts.map((attempt: { provenance: Record<string, unknown> }) =>
      attempt.provenance[key])).size).toBe(2);
  }
  expect(await credentialSummary(progress)).toEqual(connectedCredentials);
  expectNoCredentialTraces(server, auth);

  await connection.getByRole('button', { name: 'Disconnect GitHub' }).click();
  await expect(connection.getByRole('status')).toHaveText('Not connected to GitHub.');
  await expect(progress.getByRole('button', { name: retryName })).toBeDisabled();
  expect((await deliveryView(progress)).selection).toBeNull();
  const requests = await observeApi(extensionContext);
  await advanceDeliverySchedule(extensionContext, 61_000);
  await expect.poll(() => deliveryAlarm(extensionContext)).toBeNull();
  await expect(progress.getByText('Saved to GitHub', { exact: true })).toHaveCount(1);
  expect(requests).toEqual([]);
  expect(await credentialSummary(progress)).toEqual(noCredentials);

  await connection.getByRole('button', { name: 'Connect GitHub', exact: true }).click();
  await expect(connection.getByRole('status')).toHaveText('Connected as fixture-user');
  await page.getByRole('button', { name: 'Refresh installations' }).click();
  await page.getByRole('button', { name: 'Verify pending or saved repository' }).click();
  await expect(page.getByRole('status')).toHaveText(verifiedDestination);
  await expect(progress.getByText('Saved to GitHub', { exact: true })).toHaveCount(2);
  expect(await credentialSummary(progress)).toEqual(connectedCredentials);
  // Two publications plus the candidate abandoned by the rebase; reconciliation adds none.
  const commits = server.writes.filter(write => write.path.endsWith('/git/commits')).length;
  expect(commits).toBe(3);

  const replies = await progress.evaluate(async jobId => {
    const view = await chrome.runtime.sendMessage({ type: 'delivery:list' });
    const input = {
      type: 'delivery:retry', jobId,
      expectedConnectionId: view.selection.connectionId, expectedSelectionId: view.selection.operationId,
    };
    return Promise.all([1, 2].map(() => chrome.runtime.sendMessage(input)));
  }, interrupted.id);
  expect(replies.every((reply: { ok: boolean }) => reply.ok)).toBe(true);
  await advanceDeliverySchedule(extensionContext, 61_000);
  await advanceDeliverySchedule(extensionContext, 1000);

  await expect(progress.getByText('Saved to GitHub', { exact: true })).toHaveCount(2);
  const records = [
    await savedAttempt(progress, 'zero', secondSource),
    await savedAttempt(progress, 'step_one', firstSource),
  ];
  expect(records.map(record => record.state)).toEqual(['saved', 'saved']);
  expect(records[0]?.id).toBe(interrupted.id);
  expect(records[0]?.target).toEqual(interrupted.target);
  expect(new Set(records.map(record => record.receipt?.commitSha)).size).toBe(2);
  expectPublishedFiles(server, marker, records);
  expect(server.files.get('notes.txt')).toBe('Another writer keeps notes.\n');
  expect(server.writes.filter(write => write.path.endsWith('/git/commits'))).toHaveLength(commits);
  expect(server.writes.filter(write => write.method === 'PATCH')).toHaveLength(3);
  expect(server.updates).toBe(2);
  expect(server.refCompletions).toBe(2);
  expect(server.requestsValid).toBe(true);
  expectNoCredentialTraces(server, auth);
  await expect(progress.getByRole('region', { name: 'Captured attempts' }).locator('article')).toHaveCount(2);
});

test('the packaged App configuration matches the bundled source and carries no credential value', async () => {
  const schema = z.strictObject({ clientId: z.string().min(1).nullable() });
  const [packaged, bundled] = await Promise.all([
    readFile(resolve('.output', 'chrome-mv3', 'github-app.json'), 'utf8'),
    readFile(resolve('public', 'github-app.json'), 'utf8'),
  ]);
  const configuration = schema.parse(JSON.parse(packaged));
  expect(configuration).toEqual(schema.parse(JSON.parse(bundled)));
  expect(configuration.clientId ?? '').not.toMatch(/gh[pousr]_|-----BEGIN|secret|private[_-]?key/i);
});
