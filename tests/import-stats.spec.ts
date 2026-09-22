import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { CLIENT_ID } from './github-fixture';
import { setup } from './publication-setup';
import { importFixture, importPages, openProblemPage, type StoredSubmission } from './import-fixture';

test.use({ githubClientId: CLIENT_ID });

const DISCOVER = 'Find earlier solutions';
const FROM_STATS = 'Problems came from your HDLBits statistics page.';
const FROM_NAVIGATION = 'Problems came from the solved list on the open HDLBits page;'
  + ' your statistics page could not be read, so problems outside that list were not looked at.';

function imports(progress: Page) {
  return progress.getByRole('region', { name: 'Earlier HDLBits solutions' });
}

async function discover(progress: Page): Promise<void> {
  await progress.getByRole('button', { name: DISCOVER, exact: true }).click();
}

test('the statistics page decides which problems are read, and rows with no success are not imported', async ({
  extensionContext, progress,
}) => {
  const { server } = await setup(extensionContext, progress);
  const baseline = server.writes.length;
  const site = await importFixture(extensionContext, {
    step_one: { submissionId: '847' }, vector0: { submissionId: '0' }, always_block: { submissionId: '5' },
  });
  // The open page only links to one of them; the statistics table lists the learner's whole history.
  site.solved = ['step_one'];
  site.stats = [
    { problemId: 'step_one', successes: 2, failures: 1 },
    { problemId: 'vector0', successes: 1 },
    // Attempted many times, never passed: it must not be read as a success.
    { problemId: 'always_block', successes: 0, failures: 9 },
  ];
  await openProblemPage(extensionContext);
  await importPages(progress, 1);

  await discover(progress);
  await expect(progress.locator('#import-status'))
    .toHaveText('2 earlier solutions available to import; 0 problems skipped.');
  await expect(progress.locator('#import-source')).toHaveText(FROM_STATS);
  expect(site.statsReads).toBeGreaterThanOrEqual(1);
  await expect(imports(progress).getByRole('heading', { name: 'hdlbits:step_one', exact: true })).toBeVisible();
  await expect(imports(progress).getByRole('heading', { name: 'hdlbits:vector0', exact: true })).toBeVisible();
  await expect(imports(progress).getByRole('heading', { name: 'hdlbits:always_block', exact: true }))
    .toHaveCount(0);
  expect(site.loads.map(load => load.problemId).sort()).toEqual(['step_one', 'vector0']);
  expect(server.writes).toHaveLength(baseline);
});

test('save slot 0 is an ordinary slot and is labelled as one', async ({ extensionContext, progress }) => {
  await setup(extensionContext, progress);
  const site = await importFixture(extensionContext, { vector0: { submissionId: '0' } });
  site.solved = [];
  site.stats = [{ problemId: 'vector0', successes: 1 }];
  await openProblemPage(extensionContext, 'vector0');
  await importPages(progress, 1);

  await discover(progress);
  await expect(progress.locator('#import-status'))
    .toHaveText('1 earlier solution available to import; 0 problems skipped.');
  await expect(imports(progress).locator('dt', { hasText: 'Provider save slot' })).toBeVisible();
  // The slot is shown as the site's own value; 0 is not treated as missing.
  await expect(imports(progress).locator('dl > dd').nth(1)).toHaveText('0');
  expect(site.loads).toEqual([{ problemId: 'vector0', submissionId: '0' }]);
});

test('a statistics page without a readable success table falls back to the solved list', async ({
  extensionContext, progress,
}) => {
  const { server } = await setup(extensionContext, progress);
  const site = await importFixture(extensionContext, { step_one: { submissionId: '847' } });
  // A table with a header row but no column this can read, and a rate column that is not a count.
  site.statsMarkup = `<!doctype html><html lang="en"><body><h1>Statistics</h1>
    <table><tr><th>Problem</th><th>Success rate</th></tr>
    <tr><td><a href="/wiki/step_one">step_one</a></td><td>67%</td></tr></table></body></html>`;
  await openProblemPage(extensionContext);
  await importPages(progress, 1);

  await discover(progress);
  await expect(progress.locator('#import-status'))
    .toHaveText('1 earlier solution available to import; 0 problems skipped.');
  await expect(progress.locator('#import-source')).toHaveText(FROM_NAVIGATION);
  expect(site.statsReads).toBeGreaterThanOrEqual(1);
  expect(site.loads).toEqual([{ problemId: 'step_one', submissionId: '847' }]);
  expect(server.updates).toBe(0);
});

test('a signed-out statistics page is reported as the solved list, not as an empty history', async ({
  extensionContext, progress,
}) => {
  await setup(extensionContext, progress);
  const site = await importFixture(extensionContext, { step_one: { submissionId: '847' } });
  // HDLBits answers its own sign-in page rather than the learner's table.
  site.statsMarkup = `<!doctype html><html lang="en"><body><h1>Log in</h1>
    <form action="/wiki/Special:VlgLogin" method="post"><input name="user"><button>Log in</button></form>
    </body></html>`;
  await openProblemPage(extensionContext);
  await importPages(progress, 1);

  await discover(progress);
  await expect(progress.locator('#import-status'))
    .toHaveText('1 earlier solution available to import; 0 problems skipped.');
  await expect(progress.locator('#import-source')).toHaveText(FROM_NAVIGATION);
});

test('a continuation stops instead of counting its offset against a different list', async ({
  extensionContext, progress,
}) => {
  test.slow(); // A first pass over more problems than one preview batch reads.
  await setup(extensionContext, progress);
  const catalogue: Record<string, StoredSubmission | null> = {};
  for (let index = 0; index < 105; index += 1) catalogue[`f${index}`] = null;
  const site = await importFixture(extensionContext, catalogue);
  site.solved = ['f0'];
  site.stats = Object.keys(catalogue).map(problemId => ({ problemId, successes: 1 }));
  await openProblemPage(extensionContext, 'f0');
  await importPages(progress, 1);

  await discover(progress);
  await expect(progress.locator('#import-status')).toHaveText(
    '0 earlier solutions available to import; 100 problems skipped.'
    + ' Read 100 of 105 solved problems; find earlier solutions again to continue with the rest.',
    { timeout: 60_000 });
  await expect(progress.locator('#import-source')).toHaveText(FROM_STATS);

  // The statistics page goes away mid-continuation: the remaining five problems are counted against it, so
  // falling back to the one-entry solved list would silently step over them.
  site.stats = null;
  await discover(progress);
  await expect(progress.locator('#import-status')).toHaveText(
    'Your HDLBits statistics page could not be read again, so this pass could not continue the list the earlier'
    + ' one was counted against. Nothing was imported. Find earlier solutions again to start a new pass.',
  );
  await expect(progress.locator('#imports > p')).toHaveCount(100);
});
