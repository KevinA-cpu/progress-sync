import { createHash } from 'node:crypto';
import type { BrowserContext, Page } from '@playwright/test';
import type { Browser } from 'wxt/browser';
import {
  advanceDeliverySchedule, expect, extensionWorker, launchExtensionProfile, stopExtensionWorker, test,
} from './fixtures';
import { CLIENT_ID, githubFixture, openConnection } from './github-fixture';
import { destinationFixture } from './destination-fixture';
import { recoveryFixture } from './recovery-fixture';
import { trackContentScript } from './content-script-fixture';
import { setup } from './publication-setup';
import { publicationFixture } from './publication-fixture';
import {
  editorTemplate, importedSource, importFixture, importPages, openProblemPage, successLabel, type StoredSubmission,
} from './import-fixture';

declare const chrome: typeof Browser;

test.use({ githubClientId: CLIENT_ID });

const DISCOVER = 'Find earlier solutions';
const PUBLISH = 'Publish imported solution to fixture-user/progress-solutions @ learning (public, unverified)';
// A second repository the same installation owns, with its own git store.
const ARCHIVE = { name: 'progress-archive', repositoryId: 202 };
const ARCHIVE_PUBLISH = 'Publish imported solution to fixture-user/progress-archive @ learning (public, unverified)';
const UNVERIFIED = 'Imported - unverified';
const SAVED = 'Imported - unverified, saved to GitHub';
const NO_STORED = 'hdlbits:zero - HDLBits offers no stored successful submission for this problem.';

const digest = (source: string) => createHash('sha256').update(source, 'utf8').digest('hex');
const importRoot = (problemId: string, submissionId: string, source: string) =>
  `imports/hdlbits/${problemId}/${submissionId}/${digest(source).slice(0, 12)}`;

function imports(progress: Page) {
  return progress.getByRole('region', { name: 'Earlier HDLBits solutions' });
}

function record(remote: { files: Map<string, string> }, root: string): Record<string, unknown> {
  return JSON.parse(remote.files.get(`${root}/import.json`) ?? 'null');
}

async function discover(progress: Page): Promise<void> {
  await progress.getByRole('button', { name: DISCOVER, exact: true }).click();
}

async function connect(page: Page, name: string): Promise<void> {
  await page.getByLabel('Repository name', { exact: true }).fill(name);
  await page.getByRole('button', { name: 'Connect existing repository', exact: true }).click();
  await expect(page.getByRole('status'))
    .toHaveText(`Verified destination: fixture-user/${name} @ learning`);
}

async function publishFirst(progress: Page, saved = 1): Promise<void> {
  progress.once('dialog', async dialog => {
    expect(dialog.message()).toContain('imported and unverified');
    await dialog.accept();
  });
  await imports(progress).getByRole('button', { name: PUBLISH, exact: true }).click();
  await expect(imports(progress).getByText(SAVED, { exact: true })).toHaveCount(saved);
}

async function publishAll(progress: Page, total: number): Promise<void> {
  for (let saved = 1; saved <= total; saved += 1) {
    progress.once('dialog', async dialog => { await dialog.accept(); });
    await imports(progress).getByRole('button', { name: PUBLISH, exact: true }).first().click();
    await expect(imports(progress).getByText(SAVED, { exact: true })).toHaveCount(saved);
  }
  await expect(imports(progress).getByRole('button', { name: PUBLISH, exact: true })).toHaveCount(0);
}

// Publishing through the page keeps the request the options page would actually send.
async function publishRecord(
  progress: Page, overrides: Record<string, unknown> = {},
): Promise<{ ok: boolean; error?: string }> {
  return progress.evaluate(async input => {
    const view = await chrome.runtime.sendMessage({ type: 'import:list' });
    const delivery = await chrome.runtime.sendMessage({ type: 'delivery:list' });
    const candidate = view.state.candidates[0];
    return chrome.runtime.sendMessage({
      type: 'import:publish', recordId: candidate.recordId, expectedSourceHash: candidate.sourceHash,
      expectedConnectionId: delivery.selection.connectionId, expectedSelectionId: delivery.selection.operationId,
      publicConfirmed: true, ...input,
    });
  }, overrides);
}

test('an earlier HDLBits solution publishes as an unverified import without touching the editor', async ({
  extensionContext, progress,
}) => {
  const { server } = await setup(extensionContext, progress);
  const baseline = server.writes.length;
  const site = await importFixture(extensionContext, { step_one: { submissionId: '847' }, zero: null });
  const problem = await openProblemPage(extensionContext);
  await problem.getByRole('textbox', { name: 'Solution' }).fill('unsaved editor draft');
  await importPages(progress, 1);

  await discover(progress);
  await expect(progress.locator('#import-status'))
    .toHaveText('1 earlier solution available to import; 1 problem skipped.');
  await expect(imports(progress).getByText(NO_STORED, { exact: true })).toBeVisible();
  await expect(imports(progress).getByText(UNVERIFIED, { exact: true })).toBeVisible();
  await expect(imports(progress).getByRole('heading', { name: 'hdlbits:step_one', exact: true })).toBeVisible();
  await expect(imports(progress).getByRole('textbox', { name: 'Imported source (read-only)' }))
    .toHaveValue(importedSource);
  // Nothing observed this submission being graded, so no report is shown or invented for it.
  await expect(imports(progress).getByRole('heading', { name: 'Submission report', exact: true })).toHaveCount(0);
  expect(server.writes).toHaveLength(baseline);

  await publishFirst(progress);
  const hash = digest(importedSource);
  const root = importRoot('step_one', '847', importedSource);
  expect(server.files.get(`${root}/solution.v`)).toBe(importedSource);
  const record = JSON.parse(server.files.get(`${root}/import.json`) ?? 'null');
  expect(record).toEqual({
    schemaVersion: 1, kind: 'imported', provider: 'hdlbits', problemId: 'step_one', submissionId: '847',
    recordId: expect.any(String), importId: expect.any(String), claim: 'provider-last-success', verified: false,
    sourceHash: hash, sourceBytes: Buffer.byteLength(importedSource, 'utf8'),
    providerLabel: successLabel, providerStatus: 2, discoveredAt: expect.any(String),
    provenance: { capture: 'site-load', origin: 'https://hdlbits.01xz.net' },
  });
  expect([...server.files.keys()].filter(path => path.startsWith('imports/')).sort())
    .toEqual([`${root}/import.json`, `${root}/solution.v`]);
  expect([...server.files.keys()].filter(path => path.startsWith('progress/'))).toEqual([]);
  expect(server.updates).toBe(1);
  expect(server.requestsValid).toBe(true);
  const commit = server.writes.find(write => write.path.endsWith('/git/commits'));
  expect((commit?.body as { message?: string } | undefined)?.message)
    .toBe('Record imported hdlbits:step_one save slot 847 (unverified)');

  // The learner's own page is untouched: no navigation, no editor write, no native state change.
  expect(problem.url()).toBe('https://hdlbits.01xz.net/wiki/step_one');
  await expect(problem.getByRole('textbox', { name: 'Solution' })).toHaveValue('unsaved editor draft');
  await expect(problem.locator('#historical-status')).toHaveText('Solved');
  expect(record.sourceHash).not.toBe(digest(editorTemplate));
  expect(site.credentialHeaders).toEqual([]);
  expect(site.loads).toEqual([{ problemId: 'step_one', submissionId: '847' }]);
  await expect(progress.locator('#status')).toContainText('No captured attempts yet.');
});

test('the same import identity and bytes never produce a second record or commit', async ({
  extensionContext, progress,
}) => {
  const { server } = await setup(extensionContext, progress);
  await importFixture(extensionContext, { step_one: { submissionId: '847' } });
  await openProblemPage(extensionContext);
  await importPages(progress, 1);
  await discover(progress);
  await publishFirst(progress);
  const writes = server.writes.length;
  const files = [...server.files.keys()].sort();

  await discover(progress);
  await expect(progress.locator('#import-status'))
    .toHaveText('1 earlier solution available to import; 0 problems skipped.');
  await expect(imports(progress).locator('article')).toHaveCount(1);
  await expect(imports(progress).getByText(SAVED, { exact: true })).toBeVisible();
  await expect(imports(progress).getByRole('button', { name: PUBLISH, exact: true })).toHaveCount(0);
  expect(await publishRecord(progress)).toEqual({
    ok: false,
    error: 'This exact import already has a delivery job for this destination. Nothing was published again.',
  });
  expect(server.writes).toHaveLength(writes);
  expect(server.updates).toBe(1);
  expect([...server.files.keys()].sort()).toEqual(files);
});

test('different bytes under the same submission identity become a distinct record, never an overwrite', async ({
  extensionContext, progress,
}) => {
  const { server } = await setup(extensionContext, progress);
  const site = await importFixture(extensionContext, { step_one: { submissionId: '847' } });
  await openProblemPage(extensionContext);
  await importPages(progress, 1);
  await discover(progress);
  await publishFirst(progress);

  const revised = `// Revised stored bytes\n${importedSource}`;
  site.stored.set('step_one', { submissionId: '847', source: revised });
  await discover(progress);
  await expect(imports(progress).locator('article')).toHaveCount(2);
  await publishFirst(progress, 2);

  const original = importRoot('step_one', '847', importedSource);
  const second = importRoot('step_one', '847', revised);
  expect(second).not.toBe(original);
  expect(server.files.get(`${original}/solution.v`)).toBe(importedSource);
  expect(server.files.get(`${second}/solution.v`)).toBe(revised);
  expect([...server.files.keys()].filter(path => path.startsWith('imports/')).sort()).toEqual([
    `${original}/import.json`, `${original}/solution.v`, `${second}/import.json`, `${second}/solution.v`,
  ]);
  expect(server.updates).toBe(2);
  expect(server.requestsValid).toBe(true);
});

test('discovery reports progress, cancels on request, and publishes nothing on its own', async ({
  extensionContext, progress,
}) => {
  const { server } = await setup(extensionContext, progress);
  const baseline = server.writes.length;
  const site = await importFixture(extensionContext, {
    step_one: { submissionId: '1' }, zero: { submissionId: '2' }, vector0: { submissionId: '3' },
  });
  const gate = Promise.withResolvers<void>();
  site.onLoad = problemId => { if (problemId === 'zero') site.loadGate = gate.promise; };
  await openProblemPage(extensionContext);
  await importPages(progress, 1);

  await discover(progress);
  await expect(progress.locator('#import-status')).toHaveText('Reading stored submissions: 1 of 3 problems.');
  await expect(progress.getByRole('button', { name: DISCOVER, exact: true })).toBeDisabled();
  await progress.getByRole('button', { name: 'Cancel discovery', exact: true }).click();
  gate.resolve();
  await expect(progress.locator('#import-status')).toHaveText(
    'Discovery cancelled after 1 problems. 1 available to import.'
    + ' Read 1 of 3 solved problems; find earlier solutions again to continue with the rest.',
  );
  await expect(imports(progress).locator('article')).toHaveCount(1);
  await expect(imports(progress).getByRole('heading', { name: 'hdlbits:step_one', exact: true })).toBeVisible();
  expect(site.loads.map(load => load.problemId)).toEqual(['step_one', 'zero']);
  expect(server.writes).toHaveLength(baseline);
  expect(server.updates).toBe(0);
});

test('a worker restart during discovery fails visibly instead of resuming or publishing', async ({
  extensionContext, progress,
}) => {
  const { server } = await setup(extensionContext, progress);
  const baseline = server.writes.length;
  const site = await importFixture(extensionContext, { step_one: { submissionId: '847' }, zero: { submissionId: '2' } });
  const gate = Promise.withResolvers<void>();
  site.loadGate = gate.promise;
  await openProblemPage(extensionContext);
  await importPages(progress, 1);

  await discover(progress);
  await expect.poll(() => site.loads.length).toBe(1);
  await stopExtensionWorker(extensionContext, progress);
  gate.resolve();
  await expect(progress.locator('#import-status')).toHaveText(
    'Discovery stopped when the extension worker restarted. Nothing was imported or published. Find earlier solutions again.',
  );
  await progress.reload();
  await expect(progress.locator('#import-status')).toContainText('Discovery stopped when the extension worker restarted.');
  await expect(imports(progress).locator('article')).toHaveCount(0);
  expect(server.writes).toHaveLength(baseline);
});

test('import operations reject page senders, page-shaped messages, and stale authorization', async ({
  extensionContext, progress,
}) => {
  const { server } = await setup(extensionContext, progress);
  const baseline = server.writes.length;
  await importFixture(extensionContext, { step_one: { submissionId: '847' } });
  const problem = await openProblemPage(extensionContext);
  await importPages(progress, 1);
  await discover(progress);
  await expect(imports(progress).getByText(UNVERIFIED, { exact: true })).toBeVisible();

  const observer = await trackContentScript(extensionContext, problem, '/wiki/step_one');
  try {
    const replies = await observer.evaluate(`(async () => Promise.all([
      chrome.runtime.sendMessage({ type: 'import:list' }),
      chrome.runtime.sendMessage({ type: 'import:discover' }),
      chrome.runtime.sendMessage({ type: 'import:cancel' }),
      chrome.runtime.sendMessage({
        type: 'import:publish', recordId: '11111111-1111-4111-8111-111111111111',
        expectedSourceHash: '${'0'.repeat(64)}',
        expectedConnectionId: '11111111-1111-4111-8111-111111111111',
        expectedSelectionId: '11111111-1111-4111-8111-111111111111', publicConfirmed: true
      })
    ]))()`);
    expect(replies).toEqual(Array.from({ length: 4 }, () => ({
      ok: false, error: 'Unsupported import operation or sender.',
    })));
  } finally {
    await observer.close();
  }

  // A trusted page cannot forge the content script's own progress message either.
  const forged = await progress.evaluate(async () => chrome.runtime.sendMessage({
    type: 'import:progress', sessionId: '11111111-1111-4111-8111-111111111111', problemId: 'step_one',
    inventory: 1, source: 'stats', total: 1, scanned: 1,
    result: { found: true, submissionId: '99', providerLabel: 'Last success: forged', providerStatus: 2, source: 'x' },
  }));
  expect(forged).toEqual({ ok: false, proceed: false });

  expect(await publishRecord(progress, { expectedSourceHash: '1'.repeat(64) }))
    .toEqual({ ok: false, error: 'This preview is out of date. Find earlier solutions again before publishing.' });
  expect(await publishRecord(progress, { recordId: '11111111-1111-4111-8111-111111111111' }))
    .toEqual({ ok: false, error: 'This preview is out of date. Find earlier solutions again before publishing.' });
  expect(await publishRecord(progress, { expectedSelectionId: '11111111-1111-4111-8111-111111111111' }))
    .toEqual({ ok: false, error: 'The account or selected destination changed. This job has not been redirected.' });
  expect(server.writes).toHaveLength(baseline);
  await expect(imports(progress).locator('article')).toHaveCount(1);
});

test('unreadable pages, signed-out loads, and malformed payloads are skipped visibly', async ({
  extensionContext, progress,
}) => {
  const { server } = await setup(extensionContext, progress);
  const baseline = server.writes.length;
  const site = await importFixture(extensionContext, {
    step_one: { submissionId: '1' },
    zero: { submissionId: '2', loadType: 'text/html; charset=utf-8', loadBody: '<html><body>Sign in</body></html>' },
    vector0: { submissionId: '3', loadBody: '{"status":2,"data":""}' },
    mux2to1: { submissionId: '4', loadType: 'text/plain', loadBody: 'not json' },
    // A non-success status carrying source-shaped data is still the site reporting a failed load.
    hadd: { submissionId: '5', loadBody: JSON.stringify({ status: 1, error: 'no such submission', data: importedSource }) },
    // The site posts this option value verbatim, so an unaddressable one is never sent.
    notgate: { submissionId: 'DROP 847' },
  });
  site.missingPages.add('step_one');
  const problem = await openProblemPage(extensionContext, 'zero');
  await importPages(progress, 1);

  await discover(progress);
  await expect(progress.locator('#import-status'))
    .toHaveText('0 earlier solutions available to import; 6 problems skipped.');
  for (const [problemId, reason] of [
    ['step_one', 'The problem page could not be read from HDLBits.'],
    ['zero', 'HDLBits answered as a signed-out visitor. Sign in to HDLBits in this browser, then find earlier solutions again.'],
    ['vector0', 'The stored submission was empty, oversized, or not in a supported shape.'],
    ['mux2to1', 'The stored submission was empty, oversized, or not in a supported shape.'],
    ['hadd', 'HDLBits reported a failed load instead of a stored submission (status other than 2).'],
    ['notgate', 'HDLBits offered a stored submission Progress Sync cannot address.'],
  ]) {
    await expect(imports(progress).getByText(`hdlbits:${problemId} - ${reason}`, { exact: true })).toBeVisible();
  }
  await expect(imports(progress).locator('article')).toHaveCount(0);
  expect(site.loads.map(load => load.problemId)).not.toContain('notgate');
  expect(server.writes).toHaveLength(baseline);

  await problem.close();
  await importPages(progress, 0);
  await discover(progress);
  await expect(progress.locator('#import-status')).toHaveText(
    'Open an HDLBits problem page in this browser, then find earlier solutions again. Progress Sync never opens or changes pages for you.',
  );
});

test('a fresh profile recovers an import as unverified and refuses forged acceptance metadata', async ({
  extensionContext, progress,
}, testInfo) => {
  test.setTimeout(60_000); // Publication plus a second persistent profile, as in the recovery suite.
  const { server } = await setup(extensionContext, progress);
  const revised = `// Revised stored bytes\n${importedSource}`;
  await importFixture(extensionContext, {
    step_one: { submissionId: '847' }, vector0: { submissionId: '500', source: revised },
  });
  await openProblemPage(extensionContext);
  await importPages(progress, 1);
  await discover(progress);
  await publishAll(progress, 2);
  const progressUrl = progress.url();
  const remoteFiles = new Map(server.files);
  const remoteHead = server.head;
  await extensionContext.close();

  const forgedRoot = importRoot('zero', '500', importedSource);
  remoteFiles.set(`${forgedRoot}/solution.v`, importedSource);
  remoteFiles.set(`${forgedRoot}/import.json`, JSON.stringify({
    schemaVersion: 1, kind: 'imported', provider: 'hdlbits', problemId: 'zero', submissionId: '500',
    recordId: '11111111-1111-4111-8111-111111111111', importId: '22222222-2222-4222-8222-222222222222',
    claim: 'provider-last-success', verified: true, sourceHash: digest(importedSource),
    sourceBytes: Buffer.byteLength(importedSource, 'utf8'), providerLabel: 'Last success: forged',
    providerStatus: 1, discoveredAt: '2026-01-01T00:00:00.000Z',
    provenance: { capture: 'site-load', origin: 'https://hdlbits.01xz.net', verdict: 'success' },
  }));
  // A published record whose byte count no longer matches its own source is not an import any more.
  const bytesRoot = importRoot('vector0', '500', revised);
  const forgedBytes: unknown = JSON.parse(remoteFiles.get(`${bytesRoot}/import.json`) ?? '{}');
  remoteFiles.set(`${bytesRoot}/import.json`,
    JSON.stringify({ ...forgedBytes as Record<string, unknown>, sourceBytes: 4 }));
  const misplaced = 'progress/hdlbits/zero/33333333-3333-4333-8333-333333333333';
  remoteFiles.set(`${misplaced}/solution.v`, importedSource);
  remoteFiles.set(`${misplaced}/import.json`, JSON.stringify({
    schemaVersion: 1, kind: 'imported', provider: 'hdlbits', problemId: 'zero', submissionId: '500',
    verified: true, provenance: { capture: 'browser-post', verdict: 'success' },
  }));

  const fresh = await launchExtensionProfile(testInfo.outputPath('extension'), testInfo.outputPath('fresh-profile'));
  try {
    await githubFixture(fresh);
    const target = await destinationFixture(fresh);
    target.exists = true;
    target.marker = true;
    const remote = await recoveryFixture(fresh, target, { files: remoteFiles, head: remoteHead });
    const restored = await fresh.newPage();
    await restored.goto(progressUrl);
    const returning = await reconnect(fresh, restored);
    await returning.getByRole('button', { name: 'Connect existing repository', exact: true }).click();
    await expect(returning.getByRole('status')).toContainText('Verified destination:');

    await expect(restored.locator('#recovery-status'))
      .toHaveText('0 recorded accepted; 0 recorded failed; 1 imported unverified; 3 unverified saved entries.');
    await expect(restored.getByText('Imported from HDLBits - unverified, no acceptance was observed', { exact: true }))
      .toHaveCount(1);
    await expect(restored.getByText(
      'Unverified saved file: The record identity derived from the saved source does not match the stored metadata.',
      { exact: true })).toBeVisible();
    await expect(restored.getByText('Recorded acceptance from GitHub', { exact: true })).toHaveCount(0);
    await expect(restored.getByText(digest(importedSource), { exact: true })).toBeVisible();
    await expect(restored.locator('#recovered-entries')).toContainText(`${forgedRoot}/import.json`);
    await expect(restored.locator('#recovered-entries')).toContainText(`${misplaced}/solution.v`);
    expect(remote.writes).toBe(0);
    expect(remote.requestsValid).toBe(true);
  } finally {
    await fresh.close();
  }
});

async function reconnect(context: BrowserContext, page: Page): Promise<Page> {
  const connection = await openConnection(context, page);
  await connection.getByRole('button', { name: 'Connect GitHub', exact: true }).click();
  await expect(connection.getByRole('status')).toHaveText('Connected as fixture-user');
  const [destination] = await Promise.all([
    context.waitForEvent('page'),
    connection.getByRole('link', { name: 'Set up progress repository' }).click(),
  ]);
  await expect(destination.getByText('Owner: fixture-user', { exact: true })).toBeVisible();
  return destination;
}

test('a fresh profile adopts an import already published to the same destination', async ({
  extensionContext, progress,
}, testInfo) => {
  test.setTimeout(60_000); // Publication plus a second persistent profile, as in the recovery suite.
  const { server } = await setup(extensionContext, progress);
  await importFixture(extensionContext, { step_one: { submissionId: '847' } });
  await openProblemPage(extensionContext);
  await importPages(progress, 1);
  await discover(progress);
  await publishFirst(progress);
  const root = importRoot('step_one', '847', importedSource);
  const record = server.files.get(`${root}/import.json`);
  expect(record).toBeDefined();
  const progressUrl = progress.url();
  await extensionContext.close();

  const fresh = await launchExtensionProfile(testInfo.outputPath('extension'), testInfo.outputPath('fresh-profile'));
  try {
    await githubFixture(fresh);
    const target = await destinationFixture(fresh);
    target.exists = true;
    target.marker = true;
    const remote = await publicationFixture(fresh, target);
    const receipt = remote.commitFiles(
      { [`${root}/solution.v`]: importedSource, [`${root}/import.json`]: record ?? '' },
      'Record imported hdlbits:step_one save slot 847 (unverified)',
    );
    await importFixture(fresh, { step_one: { submissionId: '847' } });
    const restored = await fresh.newPage();
    await restored.goto(progressUrl);
    const returning = await reconnect(fresh, restored);
    await returning.getByRole('button', { name: 'Connect existing repository', exact: true }).click();
    await expect(returning.getByRole('status')).toContainText('Verified destination:');

    await openProblemPage(fresh);
    await importPages(restored, 1);
    await discover(restored);
    await publishFirst(restored);
    // Rediscovery happens later and says so, but the first published record stays exactly as it was.
    await expect(restored.getByRole('link', { name: `Commit ${receipt}`, exact: true })).toBeVisible();
    expect(remote.writes).toEqual([]);
    expect(remote.updates).toBe(0);
    expect(remote.head).toBe(receipt);
    expect(remote.files.get(`${root}/import.json`)).toBe(record);
    expect(remote.requestsValid).toBe(true);
  } finally {
    await fresh.close();
  }
});

test('an imported job stays with the destination it was published to', async ({ extensionContext, progress }) => {
  const { target, server, page } = await setup(extensionContext, progress, ARCHIVE);
  const archive = await publicationFixture(extensionContext, target, ARCHIVE.name);
  await importFixture(extensionContext, { step_one: { submissionId: '847' } });
  await openProblemPage(extensionContext);
  await importPages(progress, 1);
  await discover(progress);
  await publishFirst(progress);
  const root = importRoot('step_one', '847', importedSource);
  const files = [...server.files.keys()].sort();
  const head = server.head;
  const updates = server.updates;
  const previous = await progress.evaluate(async () =>
    (await chrome.runtime.sendMessage({ type: 'delivery:list' })).selection.operationId);

  await connect(page, ARCHIVE.name);
  await expect(imports(progress).getByText(SAVED, { exact: true })).toHaveCount(1);
  await expect(imports(progress).getByRole('button', { name: ARCHIVE_PUBLISH, exact: true })).toHaveCount(1);
  // The previous selection is a real one, and it is still not somewhere this job may be redirected.
  expect(await publishRecord(progress, { expectedSelectionId: previous })).toEqual({
    ok: false, error: 'The account or selected destination changed. This job has not been redirected.',
  });

  // A genuinely separate repository with its own git store: an explicit second publication, not a path collision.
  progress.once('dialog', async dialog => { await dialog.accept(); });
  await imports(progress).getByRole('button', { name: ARCHIVE_PUBLISH, exact: true }).click();
  await expect(imports(progress).getByText(SAVED, { exact: true })).toHaveCount(2);
  await expect(imports(progress).locator('article')).toHaveCount(2);
  await expect(imports(progress).getByRole('link', { name: /^Commit / })).toHaveCount(2);
  expect(archive.files.get(`${root}/solution.v`)).toBe(importedSource);
  // The same import identity and bytes, recorded under this destination's own job id.
  const first = record(server, root);
  const second = record(archive, root);
  expect(second).toEqual({ ...first, importId: expect.any(String) });
  expect(second.importId).not.toBe(first.importId);
  expect(archive.updates).toBe(1);
  expect(archive.requestsValid).toBe(true);
  // Nothing in the first destination moved: same files, same head, no further write.
  expect([...server.files.keys()].sort()).toEqual(files);
  expect(server.updates).toBe(updates);
  expect(server.head).toBe(head);
  expect(server.writes.filter(write => write.path.startsWith('/repos/fixture-user/progress-archive'))).toEqual([]);
  expect(archive.writes.filter(write => write.path.startsWith('/repos/fixture-user/progress-solutions'))).toEqual([]);

  await connect(page, 'progress-solutions');
  await expect(imports(progress).getByText(SAVED, { exact: true })).toHaveCount(2);
  await expect(imports(progress).getByRole('button', { name: PUBLISH, exact: true })).toHaveCount(0);
  await expect(imports(progress).locator('article')).toHaveCount(2);
  expect(server.updates).toBe(updates);
  expect(archive.updates).toBe(1);
});

test('a record published to one destination still publishes to another after a new preview list', async ({
  extensionContext, progress,
}) => {
  const { target, server, page } = await setup(extensionContext, progress, ARCHIVE);
  const archive = await publicationFixture(extensionContext, target, ARCHIVE.name);
  const site = await importFixture(extensionContext, { step_one: { submissionId: '847' } });
  const problem = await openProblemPage(extensionContext);
  await importPages(progress, 1);
  await discover(progress);
  await publishFirst(progress);

  // A later pass over a different solved list replaces the preview entirely; the published record is cached only.
  site.solved = ['zero'];
  site.stored = new Map([['zero', { submissionId: '12' }]]);
  await openProblemPage(extensionContext, 'zero');
  await problem.close();
  await importPages(progress, 1);
  await discover(progress);
  await expect(progress.locator('#import-status'))
    .toHaveText('1 earlier solution available to import; 0 problems skipped.');
  await expect(imports(progress).getByRole('heading', { name: 'hdlbits:step_one', exact: true })).toBeVisible();
  await expect(imports(progress).getByRole('heading', { name: 'hdlbits:zero', exact: true })).toBeVisible();

  await connect(page, ARCHIVE.name);
  await expect(imports(progress).getByRole('button', { name: ARCHIVE_PUBLISH, exact: true })).toHaveCount(2);
  const stale = imports(progress).locator('article')
    .filter({ has: progress.getByRole('heading', { name: 'hdlbits:step_one', exact: true }) });
  progress.once('dialog', async dialog => { await dialog.accept(); });
  await stale.getByRole('button', { name: ARCHIVE_PUBLISH, exact: true }).click();
  await expect(imports(progress).getByText(SAVED, { exact: true })).toHaveCount(2);
  await expect(imports(progress).getByText('This preview is out of date.', { exact: false })).toHaveCount(0);

  const root = importRoot('step_one', '847', importedSource);
  expect(archive.files.get(`${root}/solution.v`)).toBe(importedSource);
  expect(record(archive, root)).toEqual({ ...record(server, root), importId: expect.any(String) });
  expect(archive.updates).toBe(1);
  expect(server.updates).toBe(1);
  expect(archive.requestsValid).toBe(true);
  expect(site.loads.filter(load => load.problemId === 'step_one')).toHaveLength(1);
});

test('a discarded import says so instead of offering a button that cannot work', async ({
  extensionContext, progress,
}) => {
  const { server } = await setup(extensionContext, progress);
  server.failAt = 'tree';
  server.failStatus = 422; // A rejected write that leaves the connection and the selected destination in place.
  await importFixture(extensionContext, { step_one: { submissionId: '847' } });
  await openProblemPage(extensionContext);
  await importPages(progress, 1);
  await discover(progress);
  progress.once('dialog', async dialog => { await dialog.accept(); });
  await imports(progress).getByRole('button', { name: PUBLISH, exact: true }).click();
  await expect(imports(progress).getByText('Delivery blocked:', { exact: false })).toBeVisible();
  const writes = server.writes.length;

  progress.once('dialog', async dialog => {
    expect(dialog.message()).toContain('does not delete anything on GitHub');
    await dialog.accept();
  });
  await imports(progress).getByRole('button', { name: 'Discard local attempt', exact: true }).click();
  await expect(imports(progress).getByText(
    'This import was discarded in this browser profile. It cannot be published to this destination again from here;'
    + ' nothing was deleted from GitHub.', { exact: true })).toBeVisible();
  await expect(imports(progress).getByRole('button', { name: PUBLISH, exact: true })).toHaveCount(0);
  expect(server.writes).toHaveLength(writes);
  expect([...server.files.keys()].filter(path => path.startsWith('imports/'))).toEqual([]);
});

test('an uncertain import publication reconciles to its own commit after a worker restart', async ({
  extensionContext, progress,
}) => {
  const { server } = await setup(extensionContext, progress);
  server.loseResponseAt = 'ref';
  await importFixture(extensionContext, { step_one: { submissionId: '847' } });
  await openProblemPage(extensionContext);
  await importPages(progress, 1);
  await discover(progress);
  progress.once('dialog', async dialog => { await dialog.accept(); });
  await imports(progress).getByRole('button', { name: PUBLISH, exact: true }).click();
  await expect(progress.getByText('Publication outcome is uncertain.', { exact: false })).toBeVisible();
  const receipt = server.head;
  const writes = server.writes.length;
  expect(server.updates).toBe(1);

  await stopExtensionWorker(extensionContext, progress);
  server.loseResponseAt = null;
  await progress.reload();
  await advanceDeliverySchedule(extensionContext, 61_000);
  await expect(imports(progress).getByText(SAVED, { exact: true })).toBeVisible();
  await expect(progress.getByRole('link', { name: `Commit ${receipt}`, exact: true })).toBeVisible();
  expect(server.updates).toBe(1);
  expect(server.writes).toHaveLength(writes);
});

test('a cancelled confirmation publishes nothing and a lost connection retries the original target', async ({
  extensionContext, progress,
}) => {
  const { server, page } = await setup(extensionContext, progress);
  const baseline = server.writes.length;
  await importFixture(extensionContext, { step_one: { submissionId: '847' } });
  await openProblemPage(extensionContext);
  await importPages(progress, 1);
  await discover(progress);

  progress.once('dialog', async dialog => { await dialog.dismiss(); });
  await imports(progress).getByRole('button', { name: PUBLISH, exact: true }).click();
  await expect(imports(progress).getByText(UNVERIFIED, { exact: true })).toBeVisible();
  await expect(imports(progress).getByRole('button', { name: PUBLISH, exact: true })).toBeEnabled();
  expect(server.writes).toHaveLength(baseline);

  // An authorization failure drops the verified destination; the job waits for the original one to return.
  server.failAt = 'tree';
  progress.once('dialog', async dialog => { await dialog.accept(); });
  await imports(progress).getByRole('button', { name: PUBLISH, exact: true }).click();
  await expect(imports(progress).getByText('Reconnect GitHub with the original account and App', { exact: false }))
    .toBeVisible();
  expect(server.updates).toBe(0);

  server.failAt = null;
  await page.getByRole('button', { name: 'Verify pending or saved repository', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Verified destination:');
  await imports(progress).getByRole('button', { name: 'Check GitHub and retry delivery', exact: true }).click();
  await expect(imports(progress).getByText(SAVED, { exact: true })).toBeVisible();
  await expect(imports(progress).getByText('Destination: fixture-user/progress-solutions @ learning', { exact: true }))
    .toBeVisible();
  const root = importRoot('step_one', '847', importedSource);
  expect(server.files.get(`${root}/solution.v`)).toBe(importedSource);
  expect(server.updates).toBe(1);
});

test('a preview batch stops at its limit and the next pass continues from the problem it could not hold', async ({
  extensionContext, progress,
}) => {
  test.slow(); // Two passes over more solved problems than one preview batch holds.
  const { server } = await setup(extensionContext, progress);
  const baseline = server.writes.length;
  const catalogue: Record<string, StoredSubmission> = {};
  for (let index = 0; index < 101; index += 1) catalogue[`p${index}`] = { submissionId: `${index}` };
  const site = await importFixture(extensionContext, catalogue);
  await openProblemPage(extensionContext, 'p0');
  await importPages(progress, 1);

  await discover(progress);
  await expect(progress.locator('#import-status')).toHaveText(
    '100 earlier solutions available to import; 0 problems skipped.'
    + ' Stopped at the preview limit after 100 of 101 solved problems.'
    + ' Publish what you want to keep; finding earlier solutions again starts a new preview list from where this one'
    + ' stopped.', { timeout: 60_000 });
  await expect(imports(progress).locator('article')).toHaveCount(100);
  const read = site.loads.length;

  await discover(progress);
  await expect(progress.locator('#import-status'))
    .toHaveText('1 earlier solution available to import; 0 problems skipped.');
  await expect(imports(progress).locator('article')).toHaveCount(1);
  await expect(imports(progress).getByRole('heading', { name: 'hdlbits:p100', exact: true })).toBeVisible();
  expect(site.loads.slice(read).map(load => load.problemId)).toEqual(['p100']);
  expect(server.writes).toHaveLength(baseline);
});

test('a stalled load is abandoned on cancel and an oversized reply is skipped, not imported', async ({
  extensionContext, progress,
}) => {
  const { server } = await setup(extensionContext, progress);
  const baseline = server.writes.length;
  const site = await importFixture(extensionContext, { step_one: { submissionId: '1' }, zero: { submissionId: '2' } });
  const stall = Promise.withResolvers<void>();
  site.loadGate = stall.promise;
  await openProblemPage(extensionContext);
  await importPages(progress, 1);

  await discover(progress);
  await expect.poll(() => site.loads.length).toBe(1);
  // The stalled response is still held here: cancellation may not wait for HDLBits to answer.
  await progress.getByRole('button', { name: 'Cancel discovery', exact: true }).click();
  await expect(progress.locator('#import-status')).toContainText('Discovery cancelled after 0 problems.');
  await expect(progress.getByRole('button', { name: DISCOVER, exact: true })).toBeEnabled();
  await expect(imports(progress).locator('article')).toHaveCount(0);

  site.loadGate = null;
  site.stored.set('step_one', {
    submissionId: '1', loadBody: JSON.stringify({ status: 2, data: 'x'.repeat(400_000) }),
  });
  await discover(progress);
  await expect(progress.locator('#import-status'))
    .toHaveText('1 earlier solution available to import; 1 problem skipped.');
  await expect(imports(progress).getByText(
    'hdlbits:step_one - The stored submission was empty, oversized, or not in a supported shape.',
    { exact: true })).toBeVisible();
  await expect(imports(progress).getByRole('heading', { name: 'hdlbits:zero', exact: true })).toBeVisible();
  expect(server.writes).toHaveLength(baseline);
  stall.resolve();
});

test('a discovery that cannot save what it read stops visibly and overwrites nothing', async ({
  extensionContext, progress,
}) => {
  const { server } = await setup(extensionContext, progress);
  const baseline = server.writes.length;
  const site = await importFixture(extensionContext, { step_one: { submissionId: '1' }, zero: { submissionId: '2' } });
  const gate = Promise.withResolvers<void>();
  site.loadGate = gate.promise;
  await openProblemPage(extensionContext);
  await importPages(progress, 1);

  await discover(progress);
  await expect.poll(() => site.loads.length).toBe(1);
  await progress.evaluate(key => chrome.storage.local.set({ [key]: 'not a discovery state' }), 'import-discovery-v1');
  gate.resolve();

  await expect(progress.locator('#import-status'))
    .toHaveText('Saved import data is invalid. It has not been overwritten.');
  await expect(imports(progress).locator('article')).toHaveCount(0);
  expect(await progress.evaluate(key => chrome.storage.local.get(key), 'import-discovery-v1'))
    .toEqual({ 'import-discovery-v1': 'not a discovery state' });
  expect(server.writes).toHaveLength(baseline);
});

test('navigating the scanning page ends that pass instead of continuing somewhere else', async ({
  extensionContext, progress,
}) => {
  const { server } = await setup(extensionContext, progress);
  const site = await importFixture(extensionContext, { step_one: { submissionId: '1' }, zero: { submissionId: '2' } });
  const gate = Promise.withResolvers<void>();
  site.loadGate = gate.promise;
  const problem = await openProblemPage(extensionContext);
  await importPages(progress, 1);

  await discover(progress);
  await expect.poll(() => site.loads.length).toBe(1);
  await problem.goto('https://hdlbits.01xz.net/wiki/zero');
  gate.resolve();
  await expect(progress.locator('#import-status')).toHaveText(
    'Open an HDLBits problem page in this browser, then find earlier solutions again.'
    + ' Progress Sync never opens or changes pages for you.');
  await expect(imports(progress).locator('article')).toHaveCount(0);
  expect(server.writes).toEqual([]);

  // The document that replaced it is a page of its own and can be scanned on its own.
  await importPages(progress, 1);
  await discover(progress);
  await expect(progress.locator('#import-status'))
    .toHaveText('2 earlier solutions available to import; 0 problems skipped.');
});

test('problem pages register independently and an unreachable one is dropped, not scanned', async ({
  extensionContext, progress,
}) => {
  await setup(extensionContext, progress);
  await importFixture(extensionContext, { step_one: { submissionId: '847' } });
  await openProblemPage(extensionContext);
  await openProblemPage(extensionContext, 'zero');
  await importPages(progress, 2);

  // A page that is gone cannot answer, and discovery must not keep addressing it.
  await progress.evaluate(async key => {
    const stored = await chrome.storage.session.get(key);
    const pages: unknown = stored[key];
    await chrome.storage.session.set({
      [key]: [{ tabId: 987654, documentId: 'f'.repeat(32) }, ...Array.isArray(pages) ? pages : []],
    });
  }, 'import-pages-v1');
  await importPages(progress, 3);

  await discover(progress);
  await expect(progress.locator('#import-status'))
    .toHaveText('1 earlier solution available to import; 0 problems skipped.');
  await importPages(progress, 2);
});

test('every skipped problem stays listed across a continuation, not just the last batch', async ({
  extensionContext, progress,
}) => {
  test.slow(); // Two passes over more solved problems than one preview batch reads.
  const { server } = await setup(extensionContext, progress);
  const baseline = server.writes.length;
  const catalogue: Record<string, StoredSubmission | null> = {};
  for (let index = 0; index < 102; index += 1) catalogue[`f${index}`] = null;
  for (let index = 0; index < 3; index += 1) catalogue[`s${index}`] = { submissionId: `${index}` };
  await importFixture(extensionContext, catalogue);
  await openProblemPage(extensionContext, 'f0');
  await importPages(progress, 1);

  await discover(progress);
  await expect(progress.locator('#import-status')).toHaveText(
    '0 earlier solutions available to import; 100 problems skipped.'
    + ' Read 100 of 105 solved problems; find earlier solutions again to continue with the rest.',
    { timeout: 60_000 });
  await expect(imports(progress).locator('article')).toHaveCount(0);
  await expect(progress.locator('#imports > p')).toHaveCount(100);

  // The second pass carries every earlier skip rather than keeping only the most recent hundred.
  await discover(progress);
  await expect(progress.locator('#import-status'))
    .toHaveText('3 earlier solutions available to import; 102 problems skipped.', { timeout: 60_000 });
  await expect(progress.locator('#imports > p')).toHaveCount(102);
  for (const problemId of ['f0', 'f99', 'f100', 'f101']) {
    await expect(imports(progress).getByText(
      `hdlbits:${problemId} - HDLBits offers no stored successful submission for this problem.`,
      { exact: true })).toBeVisible();
  }
  await expect(imports(progress).locator('article')).toHaveCount(3);
  expect(server.writes).toHaveLength(baseline);

  // Publishing from that continuation still works, and the skipped list is not disturbed by it.
  progress.once('dialog', async dialog => { await dialog.accept(); });
  await imports(progress).getByRole('button', { name: PUBLISH, exact: true }).first().click();
  await expect(imports(progress).getByText(SAVED, { exact: true })).toHaveCount(1);
  await expect(progress.locator('#imports > p')).toHaveCount(102);
  await expect(progress.locator('#import-status'))
    .toHaveText('3 earlier solutions available to import; 102 problems skipped.');
  expect([...server.files.keys()].filter(path => path.startsWith('imports/'))).toHaveLength(2);
});

test('a rejected persistence write ends discovery visibly instead of leaving it running', async ({
  extensionContext, progress,
}) => {
  const { server } = await setup(extensionContext, progress);
  const baseline = server.writes.length;
  const site = await importFixture(extensionContext, {
    step_one: { submissionId: '1' }, zero: { submissionId: '2' },
  });
  await openProblemPage(extensionContext);
  await importPages(progress, 1);
  // One real rejected write, not a stored value corrupted behind the service's back.
  await extensionWorker(extensionContext).evaluate(key => {
    const original = chrome.storage.local.set.bind(chrome.storage.local);
    chrome.storage.local.set = async items => {
      const state: unknown = Reflect.get(items, key);
      if (state !== null && typeof state === 'object' && Reflect.get(state, 'scanned') === 1) {
        chrome.storage.local.set = original;
        throw Object.assign(new Error('SYNTHETIC_LOCAL_FAILURE'), { status: 507 });
      }
      return original(items);
    };
  }, 'import-discovery-v1');

  await discover(progress);
  await expect(progress.locator('#import-status'))
    .toHaveText('What discovery read could not be saved, so it stopped. Nothing was imported or published.');
  await expect(progress.getByRole('button', { name: DISCOVER, exact: true })).toBeEnabled();
  await expect(imports(progress).locator('article')).toHaveCount(0);
  expect(site.loads.length).toBeLessThan(2);
  expect(server.writes).toHaveLength(baseline);

  // The next pass writes normally and reports what it actually read.
  await discover(progress);
  await expect(progress.locator('#import-status'))
    .toHaveText('2 earlier solutions available to import; 0 problems skipped.');
});

test('a corrupted persisted import is rejected before anything is written to GitHub', async ({
  extensionContext, progress,
}) => {
  const { server } = await setup(extensionContext, progress);
  server.failAt = 'tree';
  server.failStatus = 422; // Blocks the first attempt without touching the connection or the destination.
  await importFixture(extensionContext, { step_one: { submissionId: '847' } });
  await openProblemPage(extensionContext);
  await importPages(progress, 1);
  await discover(progress);
  progress.once('dialog', async dialog => { await dialog.accept(); });
  await imports(progress).getByRole('button', { name: PUBLISH, exact: true }).click();
  await expect(imports(progress).getByText('Delivery blocked:', { exact: false })).toBeVisible();
  const writes = server.writes.length;

  // Nothing stands in the way of a successful write now, so only validation can stop one.
  server.failAt = null;
  const corrupt = async (patch: Record<string, string>) => {
    await progress.evaluate(async input => {
      const stored = await chrome.storage.local.get(input.key);
      const jobs = stored[input.key] as Array<{ snapshot: Record<string, unknown> }>;
      for (const job of jobs) if (job.snapshot.kind === 'imported') Object.assign(job.snapshot, input.patch);
      await chrome.storage.local.set({ [input.key]: jobs });
    }, { key: 'delivery-jobs-v1', patch });
    await imports(progress).getByRole('button', { name: 'Check GitHub and retry delivery', exact: true }).click();
    await expect(imports(progress).getByText(
      'Delivery blocked: Only a complete, validated import record can be published.', { exact: true })).toBeVisible();
    expect(server.writes).toHaveLength(writes);
    expect([...server.files.keys()].filter(path => path.startsWith('imports/'))).toEqual([]);
    expect(server.updates).toBe(0);
  };

  // Same byte count and same recorded identity: only the bytes behind the stored hash changed.
  const corrupted = importedSource.replace("1'b1", "1'b0");
  expect(Buffer.byteLength(corrupted, 'utf8')).toBe(Buffer.byteLength(importedSource, 'utf8'));
  await corrupt({ source: corrupted });

  // Bytes that do match their stored hash still have to match the identity derived from them.
  await corrupt({ source: importedSource, recordId: '11111111-2222-4333-8444-555555555555' });
});

const deliveryReads = (progress: Page) =>
  progress.evaluate(() => (Reflect.get(window, 'deliveryReads') as string[] | undefined)?.length ?? 0);

// The reply this page receives changes without any storage change, so only a fresh read can show it.
const notice = (progress: Page, detail: string) =>
  progress.evaluate(text => { Object.assign(window, { deliveryNotice: text }); }, detail);

test('an explicit refresh re-reads delivery state instead of serving the shared cached view', async ({ progress }) => {
  await expect(progress.locator('#status')).toContainText('No captured attempts yet.');
  await progress.evaluate(() => {
    const counted: string[] = [];
    Object.assign(window, { deliveryReads: counted });
    const send = chrome.runtime.sendMessage.bind(chrome.runtime) as (message: unknown) => Promise<unknown>;
    chrome.runtime.sendMessage = (async (message: unknown) => {
      const reply = await send(message);
      const type = message !== null && typeof message === 'object' ? Reflect.get(message, 'type') : null;
      if (type !== 'delivery:list') return reply;
      counted.push(String(type));
      return {
        ...reply as object,
        scheduling: {
          schemaVersion: 1, failedAt: '2026-01-01T00:00:00.000Z', detail: Reflect.get(window, 'deliveryNotice'),
        },
      };
    }) as unknown as typeof chrome.runtime.sendMessage;
  });

  // One automatic reload leaves the shared read fulfilled and both sections showing the same reply.
  await notice(progress, 'Controlled scheduling notice.');
  await progress.evaluate(key => chrome.storage.local.set({ [key]: {} }), 'delivery-throttle-v1');
  await expect(progress.getByText('Controlled scheduling notice.', { exact: true })).toBeVisible();
  expect(await deliveryReads(progress)).toBe(1);

  await notice(progress, 'Later scheduling notice.');
  await progress.getByRole('button', { name: 'Refresh progress' }).click();
  await expect(progress.getByText('Later scheduling notice.', { exact: true })).toBeVisible();
  expect(await deliveryReads(progress)).toBe(2);

  // Every explicit refresh asks again; the cache is not restored behind the button.
  await notice(progress, 'Last scheduling notice.');
  await progress.getByRole('button', { name: 'Refresh progress' }).click();
  await expect(progress.getByText('Last scheduling notice.', { exact: true })).toBeVisible();
  expect(await deliveryReads(progress)).toBe(3);
});
