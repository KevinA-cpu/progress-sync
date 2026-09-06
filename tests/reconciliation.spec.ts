import { expect, stopExtensionWorker, submittedBytes, submittedSource, test } from './fixtures';
import { CLIENT_ID } from './github-fixture';
import { setup } from './publication-setup';
import type { Page } from '@playwright/test';
import type { Browser } from 'wxt/browser';

declare const chrome: typeof Browser;

test.use({ githubClientId: CLIENT_ID });

test('retry recovers the original complete commit after its reference response is lost', async ({
  extensionContext, progress, problem,
}) => {
  const { server } = await setup(extensionContext, progress);
  server.loseResponseAt = 'ref';
  await problem.getByRole('textbox', { name: 'Solution' }).fill(submittedSource);
  await problem.getByRole('button', { name: 'Submit', exact: true }).click();
  await expect(progress.getByText('Publication outcome is uncertain.', { exact: false })).toBeVisible();
  const originalCommit = server.head;
  const writes = server.writes.length;
  await problem.getByRole('textbox', { name: 'Solution' }).fill('not the accepted snapshot');
  await expect(progress.getByRole('button', { name: 'Check GitHub and retry delivery', exact: true })).toBeVisible();
  await progress.getByRole('button', { name: 'Check GitHub and retry delivery', exact: true }).click();
  await expect(progress.getByRole('region', { name: 'Captured attempts' }).getByText('Saved to GitHub', { exact: true }))
    .toBeVisible();
  await expect(progress.getByRole('link', { name: `Commit ${originalCommit}`, exact: true })).toBeVisible();
  expect(server.updates).toBe(1);
  expect(server.writes).toHaveLength(writes);
  expect([...server.files.values()]).toContain(submittedBytes);
  const view = await progress.evaluate(() => chrome.runtime.sendMessage({ type: 'delivery:list' }));
  expect(view.jobs[0]).toMatchObject({ state: 'saved', receipt: { commitSha: originalCommit }, snapshot: { source: submittedBytes } });
});

for (const scenario of [
  { stage: 'tree', when: 'before' }, { stage: 'tree', when: 'after' },
  { stage: 'commit', when: 'before' }, { stage: 'commit', when: 'after' },
  { stage: 'ref', when: 'before' },
] as const) {
  test(`retry completes an upload lost ${scenario.when} the ${scenario.stage} operation without duplicate publication`, async ({
    extensionContext, progress, problem,
  }) => {
    const { server } = await setup(extensionContext, progress);
    if (scenario.when === 'before') server.loseBeforeAt = scenario.stage;
    else server.loseResponseAt = scenario.stage;
    await problem.getByRole('textbox', { name: 'Solution' }).fill(submittedSource);
    await problem.getByRole('button', { name: 'Submit', exact: true }).click();
    await expect(progress.getByText('Publication outcome is uncertain.', { exact: false })).toBeVisible();
    const before = await progress.evaluate(() => chrome.runtime.sendMessage({ type: 'delivery:list' }));
    const candidate = before.jobs[0].candidate;
    expect(candidate === null).toBe(scenario.stage !== 'ref');
    server.loseBeforeAt = null;
    server.loseResponseAt = null;
    await progress.getByRole('button', { name: 'Check GitHub and retry delivery', exact: true }).click();
    await expect(progress.getByRole('region', { name: 'Captured attempts' }).getByText('Saved to GitHub', { exact: true })).toBeVisible();
    expect(server.updates).toBe(1);
    if (candidate) expect(server.head).toBe(candidate.commitSha);
    expect([...server.files.keys()].filter(path => path.startsWith('progress/'))).toHaveLength(2);
    expect([...server.files.values()]).toContain(submittedBytes);
    const writes = server.writes.length;
    await progress.evaluate(async () => {
      const view = await chrome.runtime.sendMessage({ type: 'delivery:list' });
      await chrome.runtime.sendMessage({
        type: 'delivery:retry', jobId: view.jobs[0].id, expectedConnectionId: view.selection.connectionId,
        expectedSelectionId: view.selection.operationId,
      });
    });
    expect(server.writes).toHaveLength(writes);
  });
}

async function removeCheckpoint(progress: Page) {
  await progress.evaluate(async () => {
    const stored: unknown = (await chrome.storage.local.get('delivery-jobs-v1'))['delivery-jobs-v1'];
    if (!Array.isArray(stored) || stored.length !== 1) throw new Error('Expected one retained delivery job.');
    const legacy = { ...stored[0] };
    delete legacy.candidate;
    await chrome.storage.local.set({ 'delivery-jobs-v1': [legacy] });
  });
}

test('a later unrelated commit does not replace the original publication receipt', async ({
  extensionContext, progress, problem,
}) => {
  const { server } = await setup(extensionContext, progress);
  server.loseResponseAt = 'ref';
  await problem.getByRole('textbox', { name: 'Solution' }).fill(submittedSource);
  await problem.getByRole('button', { name: 'Submit', exact: true }).click();
  await expect(progress.getByText('Publication outcome is uncertain.', { exact: false })).toBeVisible();
  const original = server.head;
  const advanced = server.commitFiles({ 'notes.txt': 'Unrelated later work\n' });
  const writes = server.writes.length;
  await progress.getByRole('button', { name: 'Check GitHub and retry delivery', exact: true }).click();
  await expect(progress.getByRole('link', { name: `Commit ${original}`, exact: true })).toBeVisible();
  expect(server.head).toBe(advanced);
  expect(server.files.get('notes.txt')).toBe('Unrelated later work\n');
  expect(server.writes).toHaveLength(writes);
});

test('legacy jobs recover the atomic introduction through paginated history without following its URLs', async ({
  extensionContext, progress, problem,
}) => {
  const { server } = await setup(extensionContext, progress);
  server.loseResponseAt = 'ref';
  await problem.getByRole('textbox', { name: 'Solution' }).fill(submittedSource);
  await problem.getByRole('button', { name: 'Submit', exact: true }).click();
  await expect(progress.getByText('Publication outcome is uncertain.', { exact: false })).toBeVisible();
  const original = server.head;
  const metadata = [...server.files].find(([path]) => path.endsWith('/acceptance.json'));
  if (!metadata) throw new Error('Expected published metadata.');
  server.commitFiles({ [metadata[0]]: metadata[1] + ' ' }, 'Reformat metadata');
  server.commitFiles({ [metadata[0]]: metadata[1] }, 'Restore metadata formatting');
  server.historyPageSize = 1;
  server.historyLinkUrl = 'https://unexpected.invalid/history';
  let redirected = 0;
  await extensionContext.route('https://unexpected.invalid/**', route => {
    redirected++;
    return route.abort();
  });
  await removeCheckpoint(progress);
  const writes = server.writes.length;
  await progress.getByRole('button', { name: 'Check GitHub and retry delivery', exact: true }).click();
  await expect(progress.getByRole('link', { name: `Commit ${original}`, exact: true })).toBeVisible();
  expect(server.reads.filter(read => read.path.endsWith('/commits') && read.page !== null).map(read => read.page))
    .toEqual([1, 2, 3]);
  expect(server.writes).toHaveLength(writes);
  expect(redirected).toBe(0);
});

test('a legacy job with no remote record or history can retry safely from the inspected head', async ({
  extensionContext, progress, problem,
}) => {
  const { server } = await setup(extensionContext, progress);
  server.loseBeforeAt = 'tree';
  await problem.getByRole('textbox', { name: 'Solution' }).fill(submittedSource);
  await problem.getByRole('button', { name: 'Submit', exact: true }).click();
  await expect(progress.getByText('Publication outcome is uncertain.', { exact: false })).toBeVisible();
  await removeCheckpoint(progress);
  server.loseBeforeAt = null;
  await progress.getByRole('button', { name: 'Check GitHub and retry delivery', exact: true }).click();
  await expect(progress.getByRole('region', { name: 'Captured attempts' }).getByText('Saved to GitHub', { exact: true })).toBeVisible();
  expect(server.updates).toBe(1);
  expect(server.reads.some(read => read.path.endsWith('/commits'))).toBe(true);
});

test('duplicate publication events and concurrent retries converge on one visible commit', async ({
  extensionContext, progress, problem,
}) => {
  const { server } = await setup(extensionContext, progress);
  server.loseBeforeAt = 'ref';
  await problem.getByRole('textbox', { name: 'Solution' }).fill(submittedSource);
  await problem.getByRole('button', { name: 'Submit', exact: true }).click();
  await expect(progress.getByText('Publication outcome is uncertain.', { exact: false })).toBeVisible();
  const writes = server.writes.length;
  await progress.evaluate(async () => {
    const view = await chrome.runtime.sendMessage({ type: 'delivery:list' });
    await Promise.all([1, 2].map(() => chrome.runtime.sendMessage({
      type: 'delivery:publish', attemptId: view.jobs[0].id, publicConfirmed: true,
      expectedConnectionId: view.selection.connectionId, expectedSelectionId: view.selection.operationId,
    })));
  });
  expect(server.writes).toHaveLength(writes);
  server.loseBeforeAt = null;
  const replies = await progress.evaluate(async () => {
    const view = await chrome.runtime.sendMessage({ type: 'delivery:list' });
    return Promise.all([1, 2].map(() => chrome.runtime.sendMessage({
      type: 'delivery:retry', jobId: view.jobs[0].id,
      expectedConnectionId: view.selection.connectionId, expectedSelectionId: view.selection.operationId,
    })));
  });
  expect(replies.every(reply => reply.ok && reply.jobs[0].state === 'saved')).toBe(true);
  expect(server.updates).toBe(1);
  expect(server.writes.filter(write => write.path.endsWith('/git/commits'))).toHaveLength(1);
});

test('a late original reference and a retry after worker restart use the same prepared commit', async ({
  extensionContext, progress, problem,
}) => {
  const { server } = await setup(extensionContext, progress);
  const gate = Promise.withResolvers<void>();
  server.refGate = gate.promise;
  await problem.getByRole('textbox', { name: 'Solution' }).fill(submittedSource);
  await problem.getByRole('button', { name: 'Submit', exact: true }).click();
  await expect.poll(() => server.writes.filter(write => write.method === 'PATCH').length).toBe(1);
  const view = await progress.evaluate(() => chrome.runtime.sendMessage({ type: 'delivery:list' }));
  const candidate = view.jobs[0].candidate;
  expect(candidate).toMatchObject({ baseCommitSha: 'a'.repeat(40), commitSha: expect.any(String) });
  await stopExtensionWorker(extensionContext, progress);
  await progress.reload();
  await expect(progress.getByText('Publication was interrupted.', { exact: false })).toBeVisible();
  await progress.getByRole('button', { name: 'Check GitHub and retry delivery', exact: true }).click();
  await expect(progress.getByRole('link', { name: `Commit ${candidate.commitSha}`, exact: true })).toBeVisible();
  gate.resolve();
  await expect.poll(() => server.refCompletions).toBe(2);
  expect(server.updates).toBe(1);
  expect(server.head).toBe(candidate.commitSha);
  expect(server.writes.filter(write => write.path.endsWith('/git/commits'))).toHaveLength(1);
});

for (const change of ['missing metadata', 'different metadata', 'different source']) {
  test(`${change} is blocked without claiming a duplicate or overwriting remote work`, async ({
    extensionContext, progress, problem,
  }) => {
    const { server } = await setup(extensionContext, progress);
    server.loseResponseAt = 'ref';
    await problem.getByRole('textbox', { name: 'Solution' }).fill(submittedSource);
    await problem.getByRole('button', { name: 'Submit', exact: true }).click();
    await expect(progress.getByText('Publication outcome is uncertain.', { exact: false })).toBeVisible();
    const source = [...server.files.keys()].find(path => path.endsWith('/solution.v'));
    const metadata = [...server.files.keys()].find(path => path.endsWith('/acceptance.json'));
    if (!source || !metadata) throw new Error('Expected the complete remote pair.');
    const changes: Record<string, string | null> = {};
    switch (change) {
      case 'different source':
        changes[source] = 'Newer learner work\n';
        break;
      case 'missing metadata':
        changes[metadata] = null;
        break;
      case 'different metadata':
        changes[metadata] = '{"schemaVersion":2}\n';
        break;
      default:
        throw new Error('Unsupported inconsistency scenario.');
    }
    const head = server.commitFiles(changes);
    const files = new Map(server.files);
    const writes = server.writes.length;
    await progress.getByRole('button', { name: 'Check GitHub and retry delivery', exact: true }).click();
    await expect(progress.getByText('Delivery blocked: An attempt path already exists', { exact: false })).toBeVisible();
    await expect(progress.getByRole('link', { name: /^Commit / })).toHaveCount(0);
    expect(server.head).toBe(head);
    expect(server.files).toEqual(files);
    expect(server.writes).toHaveLength(writes);
  });
}

test('a legacy retry pinned to the inspected head cannot duplicate a late original publication', async ({
  extensionContext, progress, problem,
}) => {
  const { server } = await setup(extensionContext, progress);
  server.uniqueCommitIds = true;
  const originalGate = Promise.withResolvers<void>();
  server.refGate = originalGate.promise;
  await problem.getByRole('textbox', { name: 'Solution' }).fill(submittedSource);
  await problem.getByRole('button', { name: 'Submit', exact: true }).click();
  await expect.poll(() => server.writes.filter(write => write.method === 'PATCH').length).toBe(1);
  const original = (await progress.evaluate(() => chrome.runtime.sendMessage({ type: 'delivery:list' }))).jobs[0].candidate.commitSha;
  await removeCheckpoint(progress);
  await stopExtensionWorker(extensionContext, progress);
  await progress.reload();
  await expect(progress.getByText('Publication was interrupted.', { exact: false })).toBeVisible();
  const retryGate = Promise.withResolvers<void>();
  server.refGate = retryGate.promise;
  await progress.getByRole('button', { name: 'Check GitHub and retry delivery', exact: true }).click();
  await expect.poll(() => server.writes.filter(write => write.method === 'PATCH').length).toBe(2);
  const replacement = (await progress.evaluate(() => chrome.runtime.sendMessage({ type: 'delivery:list' }))).jobs[0].candidate.commitSha;
  expect(replacement).not.toBe(original);
  originalGate.resolve();
  await expect.poll(() => server.refCompletions).toBe(1);
  retryGate.resolve();
  await expect(progress.getByText('Publication outcome is uncertain.', { exact: false })).toBeVisible();
  await progress.getByRole('button', { name: 'Check GitHub and retry delivery', exact: true }).click();
  await expect(progress.getByRole('link', { name: `Commit ${original}`, exact: true })).toBeVisible();
  expect(server.updates).toBe(1);
  expect(server.head).toBe(original);
});

test('repeated reconciliation read failures remain visible and retain the same job', async ({
  extensionContext, progress, problem,
}) => {
  const { server } = await setup(extensionContext, progress);
  server.loseBeforeAt = 'ref';
  await problem.getByRole('textbox', { name: 'Solution' }).fill(submittedSource);
  await problem.getByRole('button', { name: 'Submit', exact: true }).click();
  await expect(progress.getByText('Publication outcome is uncertain.', { exact: false })).toBeVisible();
  const before = await progress.evaluate(() => chrome.runtime.sendMessage({ type: 'delivery:list' }));
  await extensionContext.route('https://api.github.com/repos/fixture-user/progress-solutions/git/commits/*', route =>
    route.fulfill({ status: 503, json: { message: 'SYNTHETIC_PRIVATE_DIAGNOSTIC' } }));
  const writes = server.writes.length;
  for (let attempt = 0; attempt < 2; attempt++) {
    await progress.evaluate(async () => {
      const view = await chrome.runtime.sendMessage({ type: 'delivery:list' });
      await chrome.runtime.sendMessage({
        type: 'delivery:retry', jobId: view.jobs[0].id, expectedConnectionId: view.selection.connectionId,
        expectedSelectionId: view.selection.operationId,
      });
    });
    await expect(progress.getByText('Publication outcome is uncertain.', { exact: false })).toBeVisible();
  }
  const after = await progress.evaluate(() => chrome.runtime.sendMessage({ type: 'delivery:list' }));
  expect(after.jobs[0]).toMatchObject({ id: before.jobs[0].id, snapshot: before.jobs[0].snapshot, target: before.jobs[0].target, receipt: null });
  expect(server.writes).toHaveLength(writes);
  await expect(progress.getByText('SYNTHETIC_PRIVATE_DIAGNOSTIC')).toHaveCount(0);
});

test('a renewed same-account session can retry without changing the original destination binding', async ({
  extensionContext, progress, problem,
}) => {
  const { server, connection, page } = await setup(extensionContext, progress);
  server.loseBeforeAt = 'ref';
  await problem.getByRole('textbox', { name: 'Solution' }).fill(submittedSource);
  await problem.getByRole('button', { name: 'Submit', exact: true }).click();
  await expect(progress.getByText('Publication outcome is uncertain.', { exact: false })).toBeVisible();
  const original = (await progress.evaluate(() => chrome.runtime.sendMessage({ type: 'delivery:list' }))).jobs[0].target;
  await connection.getByRole('button', { name: 'Disconnect GitHub' }).click();
  await expect(connection.getByRole('status')).toHaveText('Not connected to GitHub.');
  await connection.getByRole('button', { name: 'Connect GitHub', exact: true }).click();
  await expect(connection.getByRole('status')).toHaveText('Connected as fixture-user');
  await page.getByRole('button', { name: 'Refresh installations' }).click();
  await page.getByRole('button', { name: 'Verify pending or saved repository' }).click();
  await expect(page.getByRole('status')).toContainText('Verified destination:');
  server.loseBeforeAt = null;
  await progress.getByRole('button', { name: 'Check GitHub and retry delivery', exact: true }).click();
  await expect(progress.getByRole('region', { name: 'Captured attempts' }).getByText('Saved to GitHub', { exact: true })).toBeVisible();
  const after = await progress.evaluate(() => chrome.runtime.sendMessage({ type: 'delivery:list' }));
  expect(after.jobs[0].target).toEqual(original);
  expect(after.selection.connectionId).not.toBe(original.connectionId);
  expect(server.updates).toBe(1);
});

test('an unavailable prepared-checkpoint write prevents any reference update', async ({
  extensionContext, progress, problem,
}) => {
  const { server } = await setup(extensionContext, progress);
  const worker = extensionContext.serviceWorkers()[0];
  if (!worker) throw new Error('Expected an active extension worker.');
  await worker.evaluate(() => {
    const original = chrome.storage.local.set.bind(chrome.storage.local);
    chrome.storage.local.set = async items => {
      const jobs: unknown = Reflect.get(items, 'delivery-jobs-v1');
      if (Array.isArray(jobs) && jobs.some(job => job.state === 'publishing' && job.candidate)) {
        chrome.storage.local.set = original;
        throw new Error('Synthetic checkpoint storage failure');
      }
      return original(items);
    };
  });
  await problem.getByRole('textbox', { name: 'Solution' }).fill(submittedSource);
  await problem.getByRole('button', { name: 'Submit', exact: true }).click();
  await expect(progress.getByText('Publication outcome is uncertain.', { exact: false })).toBeVisible();
  expect(server.writes.filter(write => write.method === 'PATCH')).toHaveLength(0);
  await progress.getByRole('button', { name: 'Check GitHub and retry delivery', exact: true }).click();
  await expect(progress.getByRole('region', { name: 'Captured attempts' }).getByText('Saved to GitHub', { exact: true })).toBeVisible();
  expect(server.updates).toBe(1);
});

test('retry cannot redirect a retained job to a different selected branch', async ({
  extensionContext, progress, problem,
}) => {
  const { server, target, page } = await setup(extensionContext, progress);
  server.loseBeforeAt = 'ref';
  await problem.getByRole('textbox', { name: 'Solution' }).fill(submittedSource);
  await problem.getByRole('button', { name: 'Submit', exact: true }).click();
  await expect(progress.getByText('Publication outcome is uncertain.', { exact: false })).toBeVisible();
  const original = (await progress.evaluate(() => chrome.runtime.sendMessage({ type: 'delivery:list' }))).jobs[0].target;
  target.defaultBranch = 'different-branch';
  await page.getByRole('button', { name: 'Connect existing repository', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('@ different-branch');
  const writes = server.writes.length;
  await expect(progress.getByRole('button', { name: 'Check GitHub and retry delivery', exact: true })).toBeDisabled();
  await progress.evaluate(async () => {
    const view = await chrome.runtime.sendMessage({ type: 'delivery:list' });
    await chrome.runtime.sendMessage({
      type: 'delivery:retry', jobId: view.jobs[0].id, expectedConnectionId: view.selection.connectionId,
      expectedSelectionId: view.selection.operationId,
    });
  });
  await expect(progress.getByText('Delivery blocked: The account or selected destination changed.', { exact: false })).toBeVisible();
  const view = await progress.evaluate(() => chrome.runtime.sendMessage({ type: 'delivery:list' }));
  expect(view.jobs[0].target).toEqual(original);
  expect(view.jobs[0].receipt).toBeNull();
  expect(server.writes).toHaveLength(writes);
});

test('legacy reconciliation does not recreate records removed by a later remote commit', async ({
  extensionContext, progress, problem,
}) => {
  const { server } = await setup(extensionContext, progress);
  server.loseResponseAt = 'ref';
  await problem.getByRole('textbox', { name: 'Solution' }).fill(submittedSource);
  await problem.getByRole('button', { name: 'Submit', exact: true }).click();
  await expect(progress.getByText('Publication outcome is uncertain.', { exact: false })).toBeVisible();
  const removed: Record<string, null> = {};
  for (const path of server.files.keys()) if (path.startsWith('progress/')) removed[path] = null;
  const head = server.commitFiles(removed, 'Remove this saved attempt');
  await removeCheckpoint(progress);
  const writes = server.writes.length;
  await progress.getByRole('button', { name: 'Check GitHub and retry delivery', exact: true }).click();
  await expect(progress.getByText('Delivery blocked: Remote history does not establish a safe retry', { exact: false })).toBeVisible();
  expect(server.head).toBe(head);
  expect(server.writes).toHaveLength(writes);
  expect([...server.files.keys()].filter(path => path.startsWith('progress/'))).toHaveLength(0);
});

test('retry messages cannot supply another source, destination, checkpoint, or nonexistent job', async ({
  extensionContext, progress, problem,
}) => {
  const { server, connection } = await setup(extensionContext, progress);
  server.loseBeforeAt = 'ref';
  await problem.getByRole('textbox', { name: 'Solution' }).fill(submittedSource);
  await problem.getByRole('button', { name: 'Submit', exact: true }).click();
  await expect(progress.getByText('Publication outcome is uncertain.', { exact: false })).toBeVisible();
  const writes = server.writes.length;
  const replies = await progress.evaluate(async () => {
    const view = await chrome.runtime.sendMessage({ type: 'delivery:list' });
    const input = {
      type: 'delivery:retry', jobId: view.jobs[0].id, expectedConnectionId: view.selection.connectionId,
      expectedSelectionId: view.selection.operationId,
    };
    return Promise.all([
      chrome.runtime.sendMessage({ ...input, source: 'not observed' }),
      chrome.runtime.sendMessage({ ...input, owner: 'another-user', branch: 'main' }),
      chrome.runtime.sendMessage({ ...input, candidate: { commitSha: '0'.repeat(40) } }),
      chrome.runtime.sendMessage({ ...input, jobId: '../../arbitrary' }),
      chrome.runtime.sendMessage({ ...input, jobId: '99999999-9999-4999-8999-999999999999' }),
    ]);
  });
  expect(replies).toEqual(Array(5).fill({ ok: false, error: 'Unsupported delivery operation or sender.' }));
  expect(await connection.evaluate(() => chrome.runtime.sendMessage({
    type: 'delivery:retry', jobId: '99999999-9999-4999-8999-999999999999',
    expectedConnectionId: '99999999-9999-4999-8999-999999999999',
    expectedSelectionId: '99999999-9999-4999-8999-999999999999',
  }))).toEqual({ ok: false, error: 'Unsupported delivery operation or sender.' });
  expect(server.writes).toHaveLength(writes);
});

test('a prepared retry never rebases over unrelated newer work', async ({
  extensionContext, progress, problem,
}) => {
  const { server } = await setup(extensionContext, progress);
  server.loseBeforeAt = 'ref';
  await problem.getByRole('textbox', { name: 'Solution' }).fill(submittedSource);
  await problem.getByRole('button', { name: 'Submit', exact: true }).click();
  await expect(progress.getByText('Publication outcome is uncertain.', { exact: false })).toBeVisible();
  const head = server.commitFiles({ 'newer.txt': 'Preserve this concurrent edit\n' });
  server.loseBeforeAt = null;
  const writes = server.writes.length;
  await progress.getByRole('button', { name: 'Check GitHub and retry delivery', exact: true }).click();
  await expect(progress.getByText('Delivery blocked: The branch changed during publication.', { exact: false })).toBeVisible();
  expect(server.head).toBe(head);
  expect(server.files.get('newer.txt')).toBe('Preserve this concurrent edit\n');
  expect(server.writes).toHaveLength(writes);
});

test('repeated history pages fail visibly instead of looping or assuming a receipt', async ({
  extensionContext, progress, problem,
}) => {
  const { server } = await setup(extensionContext, progress);
  server.loseResponseAt = 'ref';
  await problem.getByRole('textbox', { name: 'Solution' }).fill(submittedSource);
  await problem.getByRole('button', { name: 'Submit', exact: true }).click();
  await expect(progress.getByText('Publication outcome is uncertain.', { exact: false })).toBeVisible();
  await removeCheckpoint(progress);
  let pages = 0;
  await extensionContext.route(url => url.hostname === 'api.github.com'
    && url.pathname === '/repos/fixture-user/progress-solutions/commits', route => {
    pages++;
    return route.fulfill({
      json: [{ sha: server.head }], headers: { link: '<https://unexpected.invalid/next>; rel="next"' },
    });
  });
  const writes = server.writes.length;
  await progress.getByRole('button', { name: 'Check GitHub and retry delivery', exact: true }).click();
  await expect(progress.getByText('GitHub inspection failed or was interrupted.', { exact: false })).toBeVisible();
  expect(pages).toBe(2);
  expect(server.writes).toHaveLength(writes);
  await expect(progress.getByRole('link', { name: /^Commit / })).toHaveCount(0);
});

test('a modified retained snapshot cannot be promoted by a retry', async ({
  extensionContext, progress, problem,
}) => {
  const { server } = await setup(extensionContext, progress);
  server.loseResponseAt = 'ref';
  await problem.getByRole('textbox', { name: 'Solution' }).fill(submittedSource);
  await problem.getByRole('button', { name: 'Submit', exact: true }).click();
  await expect(progress.getByText('Publication outcome is uncertain.', { exact: false })).toBeVisible();
  await progress.evaluate(async () => {
    const stored: unknown = (await chrome.storage.local.get('delivery-jobs-v1'))['delivery-jobs-v1'];
    if (!Array.isArray(stored) || stored.length !== 1) throw new Error('Expected one retained job.');
    await chrome.storage.local.set({
      'delivery-jobs-v1': [{ ...stored[0], snapshot: { ...stored[0].snapshot, source: 'not the accepted snapshot' } }],
    });
  });
  const writes = server.writes.length;
  await progress.getByRole('button', { name: 'Check GitHub and retry delivery', exact: true }).click();
  await expect(progress.getByText('Delivery blocked: Only a complete, validated accepted snapshot can be published.', { exact: true }))
    .toBeVisible();
  expect(server.writes).toHaveLength(writes);
  await expect(progress.getByRole('link', { name: /^Commit / })).toHaveCount(0);
});

test('harmless metadata formatting changes do not hide the original complete publication', async ({
  extensionContext, progress, problem,
}) => {
  const { server } = await setup(extensionContext, progress);
  server.loseResponseAt = 'ref';
  await problem.getByRole('textbox', { name: 'Solution' }).fill(submittedSource);
  await problem.getByRole('button', { name: 'Submit', exact: true }).click();
  await expect(progress.getByText('Publication outcome is uncertain.', { exact: false })).toBeVisible();
  const original = server.head;
  const metadata = [...server.files].find(([path]) => path.endsWith('/acceptance.json'));
  if (!metadata) throw new Error('Expected published metadata.');
  const value = JSON.parse(metadata[1]);
  const formatted = JSON.stringify(Object.fromEntries(Object.entries(value).reverse()), null, 4) + '\n';
  const latest = server.commitFiles({ [metadata[0]]: formatted }, 'Format metadata without changing its values');
  const writes = server.writes.length;
  await progress.getByRole('button', { name: 'Check GitHub and retry delivery', exact: true }).click();
  await expect(progress.getByRole('link', { name: `Commit ${original}`, exact: true })).toBeVisible();
  expect(server.head).toBe(latest);
  expect(server.files.get(metadata[0])).toBe(formatted);
  expect(server.writes).toHaveLength(writes);
});
