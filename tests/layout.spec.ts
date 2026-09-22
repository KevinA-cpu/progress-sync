import type { Page } from '@playwright/test';
import type { Browser } from 'wxt/browser';
import { expect, submittedBytes, submittedSource, test } from './fixtures';
import { CLIENT_ID } from './github-fixture';
import { setup } from './publication-setup';
import { importedSource, importFixture, importPages, openProblemPage } from './import-fixture';

declare const chrome: typeof Browser;

test.use({ githubClientId: CLIENT_ID });

const LEGACY_STATE = 'Layout for new saves: provider-first'
  + ' (progress/<provider>/<problem>/<attempt>/ and imports/...). Existing published records are unchanged.';
const PROBLEM_FIRST_STATE = 'Layout for new saves: problem-first, dedicated to hdlbits'
  + ' (<problem>/passed-<attempt>/, <problem>/failed-<attempt>/, <problem>/imported-<record>/).'
  + ' Existing published records are unchanged.';
const PROVIDER_MISMATCH = 'This repository uses the problem-first layout for a different provider.'
  + ' Nothing was sent; choose a destination for this provider instead.';
const PUBLISH_IMPORT = 'Publish imported solution to fixture-user/progress-solutions @ learning (public, unverified)';
const MARKER = '.progress-sync.json';

async function chooseProblemFirst(page: Page): Promise<void> {
  await page.locator('#layout').selectOption('problem-first');
  await page.getByLabel('Apply this layout to records saved from now on').check();
  await page.getByRole('button', { name: 'Save layout choice', exact: true }).click();
  await expect(page.locator('#layout-state')).toHaveText(PROBLEM_FIRST_STATE);
}

function paths(files: Map<string, string>, prefix: string): string[] {
  return [...files.keys()].filter(path => path.startsWith(prefix)).sort();
}

test('a chosen problem-first layout applies to later saves only and rewrites nothing already published', async ({
  extensionContext, progress, problem,
}) => {
  const { server, page } = await setup(extensionContext, progress);
  await expect(page.locator('#layout-state')).toHaveText(LEGACY_STATE);
  await problem.getByRole('textbox', { name: 'Solution' }).fill(submittedSource);
  await problem.getByRole('button', { name: 'Submit', exact: true }).click();
  await expect(progress.getByText('Saved to GitHub', { exact: true })).toHaveCount(1);
  const published = new Map(server.files);
  const legacy = paths(server.files, 'progress/');
  expect(legacy).toHaveLength(3);

  await chooseProblemFirst(page);
  await problem.getByRole('textbox', { name: 'Solution' }).fill(`// Second attempt\n${submittedSource}`);
  await problem.getByRole('button', { name: 'Submit', exact: true }).click();
  await expect(progress.getByText('Saved to GitHub', { exact: true })).toHaveCount(2);

  const written = paths(server.files, 'step_one/');
  const root = written[0]?.slice(0, -'/acceptance.json'.length) ?? '';
  expect(written).toEqual([`${root}/acceptance.json`, `${root}/report.json`, `${root}/solution.v`]);
  const metadata = JSON.parse(server.files.get(`${root}/acceptance.json`) ?? 'null');
  // The folder carries the whole attempt id, and the record still names the provider it came from.
  expect(root).toBe(`step_one/passed-${metadata.attemptId}`);
  expect(metadata.provider).toBe('hdlbits');
  expect(server.files.get(`${root}/solution.v`)).toBe(`// Second attempt\r\n${submittedBytes}`);

  // Nothing published earlier moved, and the compatibility marker was not rewritten.
  for (const [path, content] of published) expect(server.files.get(path)).toBe(content);
  expect(paths(server.files, 'progress/')).toEqual(legacy);
  expect(server.files.get(MARKER)).toBe(published.get(MARKER));
  expect(server.updates).toBe(2);
  expect(server.requestsValid).toBe(true);

  // A repository holding both layouts recovers both records.
  await progress.getByRole('button', { name: 'Refresh saved progress' }).click();
  await expect(progress.locator('#recovery-status'))
    .toHaveText('2 recorded accepted; 0 recorded failed; 0 imported unverified; 0 unverified saved entries.');
});

test('a layout change does not move work that was already queued', async ({
  extensionContext, progress, problem,
}) => {
  const { server, page } = await setup(extensionContext, progress);
  const gate = Promise.withResolvers<void>();
  server.writeGate = gate.promise;
  await problem.getByRole('textbox', { name: 'Solution' }).fill(submittedSource);
  await problem.getByRole('button', { name: 'Submit', exact: true }).click();
  await expect.poll(() => server.writes.length).toBe(1);

  await chooseProblemFirst(page);
  gate.resolve();

  await expect(progress.getByText('Saved to GitHub', { exact: true })).toBeVisible();
  expect(paths(server.files, 'progress/hdlbits/step_one/')).toHaveLength(3);
  expect(paths(server.files, 'step_one/')).toEqual([]);
  expect(server.updates).toBe(1);
});

test('a problem-first repository refuses a record from another provider instead of sharing its folders', async ({
  extensionContext, progress, problem,
}) => {
  await problem.getByRole('textbox', { name: 'Solution' }).fill(submittedSource);
  await problem.getByRole('button', { name: 'Submit', exact: true }).click();
  await expect(progress.getByText('Accepted locally - not saved to GitHub', { exact: true })).toBeVisible();
  const { server, page } = await setup(extensionContext, progress);
  await chooseProblemFirst(page);
  // A repository dedicated to another provider, as a future second provider would leave it.
  await progress.evaluate(async () => {
    const stored = (await chrome.storage.local.get('destination-v1:42'))['destination-v1:42'] as Record<string, unknown>;
    await chrome.storage.local.set({ 'destination-v1:42': { ...stored, layoutProvider: 'elsewhere' } });
  });

  await progress.getByRole('button', { name: /^Publish accepted attempt to / }).click();
  await expect(progress.getByRole('alert')).toHaveText(PROVIDER_MISMATCH);
  expect(server.writes).toEqual([]);
  expect(paths(server.files, 'step_one/')).toEqual([]);
});

test('an imported record keeps its timestamp-independent identity under the problem-first layout', async ({
  extensionContext, progress,
}) => {
  const { server, page } = await setup(extensionContext, progress);
  const site = await importFixture(extensionContext, { step_one: { submissionId: '847' } });
  await chooseProblemFirst(page);
  await openProblemPage(extensionContext);
  await importPages(progress, 1);

  await progress.getByRole('button', { name: 'Find earlier solutions', exact: true }).click();
  await expect(progress.locator('#import-status'))
    .toHaveText('1 earlier solution available to import; 0 problems skipped.');
  progress.once('dialog', async dialog => { await dialog.accept(); });
  await progress.getByRole('button', { name: PUBLISH_IMPORT, exact: true }).click();
  await expect(progress.getByText('Imported - unverified, saved to GitHub', { exact: true })).toBeVisible();

  const written = paths(server.files, 'step_one/');
  const root = written[0]?.slice(0, -'/import.json'.length) ?? '';
  expect(written).toEqual([`${root}/import.json`, `${root}/solution.v`]);
  const record = JSON.parse(server.files.get(`${root}/import.json`) ?? 'null');
  // The record id derives from provider, problem, slot, and source hash, so rediscovery resolves here again.
  expect(root).toBe(`step_one/imported-${record.recordId}`);
  expect(record.submissionId).toBe('847');
  expect(server.files.get(`${root}/solution.v`)).toBe(importedSource);
  expect(paths(server.files, 'imports/')).toEqual([]);
  expect(site.loads).toEqual([{ problemId: 'step_one', submissionId: '847' }]);

  await progress.getByRole('button', { name: 'Refresh saved progress' }).click();
  await expect(progress.locator('#recovery-status'))
    .toHaveText('0 recorded accepted; 0 recorded failed; 1 imported unverified; 0 unverified saved entries.');
});
