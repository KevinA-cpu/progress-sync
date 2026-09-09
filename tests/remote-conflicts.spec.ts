import { createHash } from 'node:crypto';
import type { Page } from '@playwright/test';
import type { Browser } from 'wxt/browser';
import { expect, stopExtensionWorker, submittedBytes, submittedSource, test } from './fixtures';
import { CLIENT_ID } from './github-fixture';
import { setup } from './publication-setup';

declare const chrome: typeof Browser;

test.use({ githubClientId: CLIENT_ID });

async function submit(problem: Page) {
  await problem.getByRole('textbox', { name: 'Solution' }).fill(submittedSource);
  await problem.getByRole('button', { name: 'Submit', exact: true }).click();
}

async function delivery(progress: Page) {
  return progress.evaluate(() => chrome.runtime.sendMessage({ type: 'delivery:list' }));
}

async function expectPublication(server: Awaited<ReturnType<typeof setup>>['server'], progress: Page) {
  await expect(progress.getByText('Saved to GitHub', { exact: true })).toBeVisible();
  const view = await delivery(progress);
  expect(view.ok).toBe(true);
  expect(view.jobs).toHaveLength(1);
  const job = view.jobs[0];
  const root = `progress/hdlbits/step_one/${job.id}`;
  expect(server.files.get(`${root}/solution.v`)).toBe(submittedBytes);
  expect(JSON.parse(server.files.get(`${root}/acceptance.json`)!)).toEqual({
    schemaVersion: 1, provider: 'hdlbits', problemId: 'step_one', attemptId: job.id,
    sourceHash: createHash('sha256').update(submittedBytes).digest('hex'),
    submittedAt: job.snapshot.submittedAt, observedAt: job.snapshot.observedAt,
    provenance: { capture: 'browser-post', verdict: 'success' },
  });
  expect(job.receipt.commitSha).toBe(server.head);
  expect(job.candidate.commitSha).toBe(server.head);
  await expect(progress.getByRole('link', { name: `Commit ${server.head}` })).toBeVisible();
  expect(server.requestsValid).toBe(true);
}

test('an advance discovered before the ref write rebuilds from the current tree without losing edited files', async ({
  extensionContext, progress, problem,
}) => {
  const { server } = await setup(extensionContext, progress);
  let advanced = '';
  server.onFirstWrite = async () => {
    advanced = server.commitFiles({ 'README.md': 'Edited remotely.\n', 'notes.txt': 'Concurrent notes.\n' });
  };
  await submit(problem);
  await expectPublication(server, progress);
  expect(server.files.get('README.md')).toBe('Edited remotely.\n');
  expect(server.files.get('notes.txt')).toBe('Concurrent notes.\n');
  expect((await delivery(progress)).jobs[0].candidate.baseCommitSha).toBe(advanced);
  expect(server.writes).toHaveLength(5);
  expect(server.writes.filter(write => write.method === 'PATCH')).toHaveLength(1);
  expect(server.updates).toBe(1);
});

for (const problemId of ['step_one', 'zero']) {
  test(`a competing newer ${problemId} attempt stays intact when older queued work is reapplied`, async ({
    extensionContext, progress, problem,
  }) => {
    const { server } = await setup(extensionContext, progress);
    const gate = Promise.withResolvers<void>();
    server.refGate = gate.promise;
    await submit(problem);
    await expect.poll(() => server.writes.filter(write => write.method === 'PATCH').length).toBe(1);
    const job = (await delivery(progress)).jobs[0];
    const newerId = '11111111-2222-4333-8444-555555555555';
    const root = `progress/hdlbits/${problemId}/${newerId}`;
    const source = `// Newer remote attempt\r\n${submittedBytes}`;
    const newerFiles = {
      [`${root}/solution.v`]: source,
      [`${root}/acceptance.json`]: JSON.stringify({
        schemaVersion: 1, provider: 'hdlbits', problemId, attemptId: newerId,
        sourceHash: createHash('sha256').update(source).digest('hex'),
        submittedAt: new Date(Date.parse(job.snapshot.observedAt) + 1_000).toISOString(),
        observedAt: new Date(Date.parse(job.snapshot.observedAt) + 2_000).toISOString(),
        provenance: { capture: 'browser-post', verdict: 'success' },
      }) + '\n',
    };
    const advanced = server.commitFiles(newerFiles, 'Another browser records a newer accepted attempt');
    gate.resolve();
    await expectPublication(server, progress);
    for (const [path, content] of Object.entries(newerFiles)) expect(server.files.get(path)).toBe(content);
    expect([...server.files.keys()].filter(path => path.startsWith('progress/'))).toHaveLength(4);
    expect((await delivery(progress)).jobs[0].candidate.baseCommitSha).toBe(advanced);
    expect(server.writes).toHaveLength(6);
    expect(server.updates).toBe(1);
  });
}

for (const collision of ['edited source', 'inconsistent metadata', 'directory replaced by file']) {
  test(`concurrent ${collision} at the attempt path blocks rebasing without overwriting it`, async ({
    extensionContext, progress, problem,
  }) => {
    const { server } = await setup(extensionContext, progress);
    const gate = Promise.withResolvers<void>();
    server.refGate = gate.promise;
    await submit(problem);
    await expect.poll(() => server.writes.filter(write => write.method === 'PATCH').length).toBe(1);
    const job = (await delivery(progress)).jobs[0];
    const root = `progress/hdlbits/step_one/${job.id}`;
    const path = collision === 'edited source' ? `${root}/solution.v`
      : collision === 'inconsistent metadata' ? `${root}/acceptance.json` : root;
    const head = server.commitFiles({ [path]: 'Manual remote content that must not be overwritten.\n' });
    const files = new Map(server.files);
    gate.resolve();
    await expect(progress.getByText('Delivery blocked: An attempt path already exists', { exact: false })).toBeVisible();
    expect(server.head).toBe(head);
    expect(server.files).toEqual(files);
    expect(server.writes).toHaveLength(3);
    expect(server.updates).toBe(0);
    await expect(progress.getByRole('link', { name: /^Commit / })).toHaveCount(0);
    expect((await delivery(progress)).jobs[0].snapshot).toEqual(job.snapshot);
  });
}

for (const originalWriter of ['this job', 'another writer']) {
  test(`removed records from ${originalWriter} are not recreated by rebasing`, async ({
    extensionContext, progress, problem,
  }) => {
    const { server } = await setup(extensionContext, progress);
    if (originalWriter === 'this job') server.loseResponseAt = 'ref';
    else server.loseBeforeAt = 'ref';
    await submit(problem);
    await expect(progress.getByText('Publication outcome is uncertain.', { exact: false })).toBeVisible();
    const job = (await delivery(progress)).jobs[0];
    const root = `progress/hdlbits/step_one/${job.id}`;
    if (originalWriter === 'another writer') {
      server.commitFiles({
        [`${root}/solution.v`]: 'Manual source.\n',
        [`${root}/acceptance.json`]: '{"manually":"edited"}\n',
      });
    }
    const head = server.commitFiles({
      [`${root}/solution.v`]: null, [`${root}/acceptance.json`]: null, 'keep.txt': 'Keep this deletion.\n',
    });
    const files = new Map(server.files);
    server.loseResponseAt = null;
    server.loseBeforeAt = null;
    await progress.getByRole('button', { name: 'Check GitHub and retry delivery', exact: true }).click();
    await expect(progress.getByText('Delivery blocked: The branch history was replaced or the attempt was removed remotely.',
      { exact: false })).toBeVisible();
    expect(server.head).toBe(head);
    expect(server.files).toEqual(files);
    expect(server.writes).toHaveLength(3);
    await expect(progress.getByRole('link', { name: /^Commit / })).toHaveCount(0);
  });
}

test('a branch reset to an older ancestor blocks rather than republishing on replaced history', async ({
  extensionContext, progress, problem,
}) => {
  const { server } = await setup(extensionContext, progress);
  const initialHead = server.head;
  const initialFiles = new Map(server.files);
  server.commitFiles({ 'retained.txt': 'Original branch work.\n' });
  server.loseBeforeAt = 'ref';
  await submit(problem);
  await expect(progress.getByText('Publication outcome is uncertain.', { exact: false })).toBeVisible();
  server.head = initialHead;
  server.files = initialFiles;
  server.loseBeforeAt = null;
  await progress.getByRole('button', { name: 'Check GitHub and retry delivery', exact: true }).click();
  await expect(progress.getByText('Delivery blocked: The branch history was replaced', { exact: false })).toBeVisible();
  expect(server.head).toBe(initialHead);
  expect(server.writes).toHaveLength(3);
  expect(server.updates).toBe(0);
});

for (const checkpoint of ['prepared', 'legacy', 'unprepared']) {
  test(`removed source-only attempt history blocks ${checkpoint} retries`, async ({
    extensionContext, progress, problem,
  }) => {
    const { server } = await setup(extensionContext, progress);
    server.loseBeforeAt = checkpoint === 'unprepared' ? 'tree' : 'ref';
    await submit(problem);
    await expect(progress.getByText('Publication outcome is uncertain.', { exact: false })).toBeVisible();
    const job = (await delivery(progress)).jobs[0];
    const path = `progress/hdlbits/step_one/${job.id}/solution.v`;
    server.commitFiles({ [path]: 'Manual partial attempt.\n' });
    const head = server.commitFiles({ [path]: null });
    if (checkpoint === 'legacy') {
      await progress.evaluate(async () => {
        const stored = (await chrome.storage.local.get('delivery-jobs-v1'))['delivery-jobs-v1'];
        if (!Array.isArray(stored) || stored.length !== 1) throw new Error('Expected one stored job.');
        const legacyJob = { ...stored[0] };
        delete legacyJob.candidate;
        await chrome.storage.local.set({ 'delivery-jobs-v1': [legacyJob] });
      });
    }
    server.loseBeforeAt = null;
    await progress.getByRole('button', { name: 'Check GitHub and retry delivery', exact: true }).click();
    await expect(progress.getByText(checkpoint === 'legacy' ? 'Delivery blocked: Remote history does not establish a safe retry'
      : 'Delivery blocked: The branch history was replaced or the attempt was removed remotely.', { exact: false })).toBeVisible();
    expect(server.head).toBe(head);
    expect(server.files.has(path)).toBe(false);
    expect(server.writes).toHaveLength(checkpoint === 'unprepared' ? 1 : 3);
    expect(server.updates).toBe(0);
  });
}

test('repeated branch advancement stops after two rebases and retains an actionable retry', async ({
  extensionContext, progress, problem,
}) => {
  const { server } = await setup(extensionContext, progress);
  let advances = 0;
  server.onRefUpdate = () => {
    advances++;
    server.commitFiles({ [`writer-${advances}.txt`]: `Remote work ${advances}.\n` });
  };
  await submit(problem);
  await expect(progress.getByText('Delivery blocked: The branch kept advancing.', { exact: false })).toBeVisible();
  expect(advances).toBe(3);
  expect(server.writes).toHaveLength(9);
  expect(server.updates).toBe(0);
  const job = (await delivery(progress)).jobs[0];
  expect(job.candidate).not.toBeNull();
  expect(job.receipt).toBeNull();
  expect(job.snapshot.source).toBe(submittedBytes);
  await expect(progress.getByRole('button', { name: 'Check GitHub and retry delivery', exact: true })).toBeEnabled();
  const files = new Map(server.files);
  server.onRefUpdate = null;
  await progress.getByRole('button', { name: 'Check GitHub and retry delivery', exact: true }).click();
  await expectPublication(server, progress);
  for (const [path, content] of files) expect(server.files.get(path)).toBe(content);
  expect(server.updates).toBe(1);
  expect((await delivery(progress)).jobs[0].target).toEqual(job.target);
});

for (const status of [409, 422]) {
  test(`a ${status} ref rejection without a head advance does not trigger conflict retries`, async ({
    extensionContext, progress, problem,
  }) => {
    const { server } = await setup(extensionContext, progress);
    server.failAt = 'ref';
    server.failStatus = status;
    await submit(problem);
    await expect(progress.getByText('Delivery blocked: GitHub rejected publication.', { exact: false })).toBeVisible();
    expect(server.writes).toHaveLength(3);
    expect(server.updates).toBe(0);
    expect((await delivery(progress)).jobs[0].receipt).toBeNull();
  });
}

test('a 409 reference rejection with a verified head advance safely rebuilds once', async ({
  extensionContext, progress, problem,
}) => {
  const { server } = await setup(extensionContext, progress);
  let references = 0;
  server.onRefUpdate = () => {
    if (references++ === 0) {
      server.commitFiles({ 'concurrent.txt': 'Keep remote work.\n' });
      server.failAt = 'ref';
      server.failStatus = 409;
    } else {
      server.failAt = null;
    }
  };
  await submit(problem);
  await expectPublication(server, progress);
  expect(server.files.get('concurrent.txt')).toBe('Keep remote work.\n');
  expect(references).toBe(2);
  expect(server.writes).toHaveLength(6);
  expect(server.updates).toBe(1);
});

for (const stage of ['tree', 'commit'] as const) {
  test(`a 422 ${stage} rejection cannot be mistaken for a reference conflict`, async ({
    extensionContext, progress, problem,
  }) => {
    const { server } = await setup(extensionContext, progress);
    server.onFirstWrite = async () => { server.commitFiles({ 'concurrent.txt': 'Keep remote work.\n' }); };
    server.failAt = stage;
    server.failStatus = 422;
    await submit(problem);
    await expect(progress.getByText('Delivery blocked: GitHub rejected publication.', { exact: false })).toBeVisible();
    expect(server.writes).toHaveLength(stage === 'tree' ? 1 : 2);
    expect(server.updates).toBe(0);
    expect(server.files.get('concurrent.txt')).toBe('Keep remote work.\n');
  });
}

for (const status of [401, 403, 429]) {
  test(`a ${status} ref rejection is not retried even if a competing writer advances the branch`, async ({
    extensionContext, progress, problem,
  }) => {
    const { server } = await setup(extensionContext, progress);
    server.onRefUpdate = () => { server.commitFiles({ 'concurrent.txt': 'Keep remote work.\n' }); };
    server.failAt = 'ref';
    server.failStatus = status;
    await submit(problem);
    await expect(progress.getByText('Delivery blocked: GitHub rejected publication.', { exact: false })).toBeVisible();
    expect(server.writes).toHaveLength(3);
    expect(server.updates).toBe(0);
    expect(server.files.get('concurrent.txt')).toBe('Keep remote work.\n');
  });
}

for (const stage of ['commit', 'ref'] as const) {
  test(`a lost rebased ${stage} response stays uncertain until reconciliation and publishes only once`, async ({
    extensionContext, progress, problem,
  }) => {
    const { server } = await setup(extensionContext, progress);
    server.onRefUpdate = () => {
      server.onRefUpdate = null;
      server.commitFiles({ 'concurrent.txt': 'Keep remote work.\n' });
      server.loseResponseAt = stage;
    };
    await submit(problem);
    await expect(progress.getByText('Publication outcome is uncertain.', { exact: false })).toBeVisible();
    await expect(progress.getByRole('link', { name: /^Commit / })).toHaveCount(0);
    const updates = stage === 'ref' ? 1 : 0;
    expect(server.updates).toBe(updates);
    const job = (await delivery(progress)).jobs[0];
    server.loseResponseAt = null;
    const writes = server.writes.length;
    const replies = await progress.evaluate(async () => {
      const view = await chrome.runtime.sendMessage({ type: 'delivery:list' });
      const input = {
        type: 'delivery:retry', jobId: view.jobs[0].id, expectedConnectionId: view.selection.connectionId,
        expectedSelectionId: view.selection.operationId,
      };
      return Promise.all([1, 2].map(() => chrome.runtime.sendMessage(input)));
    });
    expect(replies.every(reply => reply.ok && reply.jobs[0].state === 'saved')).toBe(true);
    await expectPublication(server, progress);
    expect(server.updates).toBe(1);
    if (stage === 'ref') expect(server.writes).toHaveLength(writes);
    expect(server.files.get('concurrent.txt')).toBe('Keep remote work.\n');
    expect((await delivery(progress)).jobs[0].target).toEqual(job.target);
  });
}

test('a worker-restarted retry rebases safely while the old reference request is still outstanding', async ({
  extensionContext, progress, problem,
}) => {
  const { server } = await setup(extensionContext, progress);
  const originalGate = Promise.withResolvers<void>();
  server.refGate = originalGate.promise;
  await submit(problem);
  await expect.poll(() => server.writes.filter(write => write.method === 'PATCH').length).toBe(1);
  const original = (await delivery(progress)).jobs[0];
  await stopExtensionWorker(extensionContext, progress);
  await progress.reload();
  await expect(progress.getByText('Publication was interrupted.', { exact: false })).toBeVisible();
  server.commitFiles({ 'concurrent.txt': 'Keep remote work.\n' });
  await progress.getByRole('button', { name: 'Check GitHub and retry delivery', exact: true }).click();
  await expectPublication(server, progress);
  const published = server.head;
  const lateRef = Promise.withResolvers<void>();
  server.onRefUpdate = () => lateRef.resolve();
  originalGate.resolve();
  await lateRef.promise;
  expect(server.head).toBe(published);
  expect(server.head).not.toBe(original.candidate.commitSha);
  expect(server.updates).toBe(1);
  expect(server.files.get('concurrent.txt')).toBe('Keep remote work.\n');
  expect(server.writes).toHaveLength(6);
});

test('rebasing rechecks repository identity instead of sending work to a replacement destination', async ({
  extensionContext, progress, problem,
}) => {
  const { server, target } = await setup(extensionContext, progress);
  const gate = Promise.withResolvers<void>();
  server.refGate = gate.promise;
  await submit(problem);
  await expect.poll(() => server.writes.filter(write => write.method === 'PATCH').length).toBe(1);
  const job = (await delivery(progress)).jobs[0];
  server.commitFiles({ 'concurrent.txt': 'Keep remote work.\n' });
  target.repositoryId = 999;
  gate.resolve();
  await expect(progress.getByText('Publication outcome is uncertain.', { exact: false })).toBeVisible();
  expect(server.writes).toHaveLength(3);
  expect(server.updates).toBe(0);
  expect((await delivery(progress)).jobs[0].target).toEqual(job.target);
});
