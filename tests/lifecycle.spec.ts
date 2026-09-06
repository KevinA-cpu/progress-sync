import { expect, stopExtensionWorker, submittedBytes, submittedSource, test } from './fixtures';
import { CLIENT_ID, credentialSummary } from './github-fixture';
import { setup } from './publication-setup';
import type { Browser } from 'wxt/browser';

declare const chrome: typeof Browser;

test.use({ githubClientId: CLIENT_ID });

test('local discard requires confirmation and removes retained work without deleting remote contents', async ({
  extensionContext, progress, problem,
}) => {
  const { server, connection } = await setup(extensionContext, progress);
  server.loseResponseAt = 'ref';
  await problem.getByRole('textbox', { name: 'Solution' }).fill(submittedSource);
  await problem.getByRole('button', { name: 'Submit', exact: true }).click();
  await expect(progress.getByText('Publication outcome is uncertain.', { exact: false })).toBeVisible();
  const original = await progress.evaluate(() => chrome.runtime.sendMessage({ type: 'delivery:list' }));
  expect(original.jobs[0].snapshot.source).toBe(submittedBytes);
  const files = [...server.files];
  const writes = server.writes.length;
  await connection.getByRole('button', { name: 'Disconnect GitHub' }).click();
  await expect(connection.getByRole('status')).toHaveText('Not connected to GitHub.');
  await expect(progress.getByText('Original GitHub account: fixture-user (ID 42)', { exact: true })).toBeVisible();
  progress.once('dialog', dialog => dialog.dismiss());
  await progress.getByRole('button', { name: 'Discard local attempt', exact: true }).click();
  await expect(progress.getByRole('textbox', { name: 'Submitted source (read-only)' })).toHaveValue(submittedSource);
  progress.once('dialog', async dialog => {
    expect(dialog.message()).toContain('cannot be undone');
    expect(dialog.message()).toContain('does not delete anything on GitHub');
    await dialog.accept();
  });

  await progress.getByRole('button', { name: 'Discard local attempt', exact: true }).click();
  await expect(progress.getByRole('region', { name: 'Captured attempts' }).locator('article')).toHaveCount(0);
  await progress.reload();
  const after = await progress.evaluate(() => chrome.runtime.sendMessage({ type: 'delivery:list' }));
  expect(after.jobs).toEqual([]);
  expect(await progress.evaluate(async () => JSON.stringify(await chrome.storage.local.get(null)).includes('assign one')))
    .toBe(false);
  const stale = await progress.evaluate(async view => chrome.runtime.sendMessage({
    type: 'delivery:publish', attemptId: view.jobs[0].id,
    expectedConnectionId: view.selection.connectionId, expectedSelectionId: view.selection.operationId,
    publicConfirmed: true,
  }), original);
  expect(stale.ok).toBe(false);
  expect(server.writes).toHaveLength(writes);
  expect([...server.files]).toEqual(files);
  expect(await credentialSummary(progress)).toEqual({
    accessInSession: false, refreshInSession: false, deviceInSession: false, leakedOutsideSession: false,
  });
});

test('revoked authorization discovered by publication clears the credential and retains the original job', async ({
  extensionContext, progress, problem,
}) => {
  const { server, connection, auth, page } = await setup(extensionContext, progress);
  server.failAt = 'ref';
  server.failStatus = 401;
  await problem.getByRole('textbox', { name: 'Solution' }).fill(submittedSource);
  await problem.getByRole('button', { name: 'Submit', exact: true }).click();
  await expect(connection.getByRole('status')).toHaveText('GitHub authorization was rejected. Connect again.');
  const before = await progress.evaluate(() => chrome.runtime.sendMessage({ type: 'delivery:list' }));
  expect(before.jobs[0]).toMatchObject({ state: 'blocked', target: { userId: 42, branch: 'learning' } });
  expect((await credentialSummary(progress)).accessInSession).toBe(false);
  await expect(progress.getByRole('button', { name: 'Check GitHub and retry delivery' })).toBeDisabled();
  const writes = server.writes.length;
  const identities = auth.identityRequests;
  await problem.getByRole('button', { name: 'Submit', exact: true }).click();
  await expect(progress.getByRole('status')).toHaveText('2 captured attempts.');
  expect(server.writes).toHaveLength(writes);
  expect(auth.identityRequests).toBe(identities);
  server.failAt = null;
  await connection.getByRole('button', { name: 'Connect GitHub', exact: true }).click();
  await expect(connection.getByRole('status')).toHaveText('Connected as fixture-user');
  await expect(progress.getByRole('button', { name: 'Check GitHub and retry delivery' })).toBeDisabled();
  await page.getByRole('button', { name: 'Refresh installations' }).click();
  await page.getByRole('button', { name: 'Verify pending or saved repository' }).click();
  await expect(page.getByRole('status')).toContainText('Verified destination:');
  await progress.getByRole('button', { name: 'Check GitHub and retry delivery' }).click();
  await expect(progress.getByRole('region', { name: 'Captured attempts' }).getByText('Saved to GitHub', { exact: true }))
    .toHaveCount(1);
  const after = await progress.evaluate(() => chrome.runtime.sendMessage({ type: 'delivery:list' }));
  expect(after.jobs[0].target).toEqual(before.jobs[0].target);
  expect(server.updates).toBe(1);
});

test('an active delivery rejects local discard without disabling subsequent capture', async ({
  extensionContext, progress, problem,
}) => {
  const { server } = await setup(extensionContext, progress);
  const gate = Promise.withResolvers<void>();
  server.refGate = gate.promise;
  await problem.getByRole('textbox', { name: 'Solution' }).fill(submittedSource);
  await problem.getByRole('button', { name: 'Submit', exact: true }).click();
  await expect.poll(() => server.writes.some(write => write.method === 'PATCH')).toBe(true);
  const before = await progress.evaluate(() => chrome.runtime.sendMessage({ type: 'delivery:list' }));
  const result = await progress.evaluate(jobId => chrome.runtime.sendMessage({
    type: 'delivery:discard', jobId, localConfirmed: true,
  }), before.jobs[0].id);
  expect(result).toMatchObject({ ok: false });
  expect(result.error).toContain('Delivery is still active');
  await expect(progress.getByRole('button', { name: 'Discard local attempt' })).toBeDisabled();
  gate.resolve();
  await expect(progress.getByText('Saved to GitHub', { exact: true })).toBeVisible();
  await problem.getByRole('button', { name: 'Submit', exact: true }).click();
  await expect(progress.getByRole('status')).toHaveText('2 captured attempts.');
  await expect(progress.getByText('Saved to GitHub', { exact: true })).toHaveCount(2);
});

test('discard storage failure retains both source and job and can be retried without breaking capture', async ({
  extensionContext, progress, problem,
}) => {
  const { server } = await setup(extensionContext, progress);
  server.loseBeforeAt = 'ref';
  await problem.getByRole('textbox', { name: 'Solution' }).fill(submittedSource);
  await problem.getByRole('button', { name: 'Submit', exact: true }).click();
  await expect(progress.getByText('Publication outcome is uncertain.', { exact: false })).toBeVisible();
  const worker = extensionContext.serviceWorkers()[0];
  if (!worker) throw new Error('Expected active extension worker.');
  await worker.evaluate(() => {
    const original = chrome.storage.local.set.bind(chrome.storage.local);
    chrome.storage.local.set = async items => {
      if (Object.hasOwn(items, 'discarded-deliveries-v1')) {
        chrome.storage.local.set = original;
        throw new Error('SYNTHETIC_PRIVATE_DISCARD_FAILURE');
      }
      return original(items);
    };
  });
  progress.once('dialog', dialog => dialog.accept());
  await progress.getByRole('button', { name: 'Discard local attempt' }).click();
  await expect(progress.getByRole('alert')).toHaveText('Progress Sync: delivery operation did not complete.');
  const before = await progress.evaluate(() => chrome.runtime.sendMessage({ type: 'delivery:list' }));
  expect(before.jobs[0].snapshot.source).toBe(submittedBytes);
  await expect(progress.getByRole('textbox', { name: 'Submitted source (read-only)' })).toHaveValue(submittedSource);
  progress.once('dialog', dialog => dialog.accept());
  await progress.getByRole('button', { name: 'Discard local attempt' }).click();
  await expect(progress.getByRole('status')).toHaveText('No captured attempts yet. Submit using the in-page HDLBits editor.');
  server.loseBeforeAt = null;
  await problem.getByRole('button', { name: 'Submit', exact: true }).click();
  await expect(progress.getByText('Saved to GitHub', { exact: true })).toBeVisible();
  expect(server.updates).toBe(1);
});

test('a retained delivery remains discoverable if its redundant capture entry is absent', async ({
  extensionContext, progress, problem,
}) => {
  const { server, connection } = await setup(extensionContext, progress);
  server.loseBeforeAt = 'ref';
  await problem.getByRole('textbox', { name: 'Solution' }).fill(submittedSource);
  await problem.getByRole('button', { name: 'Submit', exact: true }).click();
  await expect(progress.getByText('Publication outcome is uncertain.', { exact: false })).toBeVisible();
  await connection.getByRole('button', { name: 'Disconnect GitHub' }).click();
  await progress.evaluate(() => chrome.storage.local.remove('attempts-v1'));
  await stopExtensionWorker(extensionContext, progress);
  await progress.reload();
  expect(await progress.evaluate(() => chrome.runtime.sendMessage({ type: 'progress:list' })))
    .toMatchObject({ ok: true, attempts: [] });
  await expect(progress.getByText('Original GitHub account: fixture-user (ID 42)', { exact: true })).toBeVisible();
  await expect(progress.getByRole('textbox', { name: 'Submitted source (read-only)' })).toHaveValue(submittedSource);
});

test('lost installation access pauses eligibility until explicit destination verification', async ({
  extensionContext, progress, problem,
}) => {
  const { server, target, page } = await setup(extensionContext, progress);
  target.contentsWrite = false;
  await problem.getByRole('textbox', { name: 'Solution' }).fill(submittedSource);
  await problem.getByRole('button', { name: 'Submit', exact: true }).click();
  await expect(progress.getByText('Delivery blocked:', { exact: false })).toBeVisible();
  await expect(progress.getByRole('button', { name: 'Check GitHub and retry delivery' })).toBeDisabled();
  const before = await progress.evaluate(() => chrome.runtime.sendMessage({ type: 'delivery:list' }));
  expect(before.selection).toBeNull();
  expect(server.writes).toEqual([]);
  target.contentsWrite = true;
  await progress.reload();
  await expect(progress.getByRole('button', { name: 'Check GitHub and retry delivery' })).toBeDisabled();
  await page.getByRole('button', { name: 'Verify pending or saved repository' }).click();
  await expect(page.getByRole('status')).toContainText('Verified destination:');
  await progress.getByRole('button', { name: 'Check GitHub and retry delivery' }).click();
  await expect(progress.getByRole('region', { name: 'Captured attempts' }).getByText('Saved to GitHub', { exact: true }))
    .toHaveCount(1);
  expect(server.updates).toBe(1);
});

test('discarding a queued attempt prevents its later publication and preserves another in-flight job', async ({
  extensionContext, progress, problem,
}) => {
  const { server } = await setup(extensionContext, progress);
  const gate = Promise.withResolvers<void>();
  server.refGate = gate.promise;
  await problem.getByRole('textbox', { name: 'Solution' }).fill(submittedSource);
  await problem.getByRole('button', { name: 'Submit', exact: true }).click();
  await expect.poll(() => server.writes.some(write => write.method === 'PATCH')).toBe(true);
  await problem.getByRole('textbox', { name: 'Solution' }).fill(`// Second snapshot\n${submittedSource}`);
  await problem.getByRole('button', { name: 'Submit', exact: true }).click();
  await expect(progress.getByRole('status')).toHaveText('2 captured attempts.');
  await expect(progress.getByText('Accepted - awaiting GitHub delivery', { exact: true })).toHaveCount(2);
  const before = await progress.evaluate(() => chrome.runtime.sendMessage({ type: 'delivery:list' }));
  const queued = before.jobs.find((job: { state: string }) => job.state === 'pending');
  expect(queued).toBeDefined();
  const discarded = await progress.evaluate(jobId => chrome.runtime.sendMessage({
    type: 'delivery:discard', jobId, localConfirmed: true,
  }), queued.id);
  expect(discarded.ok).toBe(true);
  gate.resolve();
  await expect(progress.getByText('Saved to GitHub', { exact: true })).toBeVisible();
  await expect(progress.getByRole('status')).toHaveText('1 captured attempt.');
  expect(server.updates).toBe(1);
  expect([...server.files.values()].some(value => value.includes('Second snapshot'))).toBe(false);
  await stopExtensionWorker(extensionContext, progress);
  await progress.reload();
  await expect(progress.getByText('Saved to GitHub', { exact: true })).toBeVisible();
  const after = await progress.evaluate(() => chrome.runtime.sendMessage({ type: 'delivery:list' }));
  expect(after.jobs).toHaveLength(1);
  expect(after.jobs[0].id).not.toBe(queued.id);
});

test('discard requests require explicit confirmation and cannot inject a destination or erase saved receipts', async ({
  extensionContext, progress, problem,
}) => {
  const { server } = await setup(extensionContext, progress);
  server.loseBeforeAt = 'ref';
  await problem.getByRole('textbox', { name: 'Solution' }).fill(submittedSource);
  await problem.getByRole('button', { name: 'Submit', exact: true }).click();
  await expect(progress.getByText('Publication outcome is uncertain.', { exact: false })).toBeVisible();
  const before = await progress.evaluate(() => chrome.runtime.sendMessage({ type: 'delivery:list' }));
  for (const extra of [{}, { localConfirmed: false }, { localConfirmed: true, target: before.jobs[0].target }]) {
    const result = await progress.evaluate(input => chrome.runtime.sendMessage(input), {
      type: 'delivery:discard', jobId: before.jobs[0].id, ...extra,
    });
    expect(result.ok).toBe(false);
  }
  const retained = await progress.evaluate(() => chrome.runtime.sendMessage({ type: 'delivery:list' }));
  expect(retained.jobs).toEqual(before.jobs);
  server.loseBeforeAt = null;
  await progress.getByRole('button', { name: 'Check GitHub and retry delivery' }).click();
  await expect(progress.getByText('Saved to GitHub', { exact: true })).toBeVisible();
  const rejected = await progress.evaluate(jobId => chrome.runtime.sendMessage({
    type: 'delivery:discard', jobId, localConfirmed: true,
  }), before.jobs[0].id);
  expect(rejected.ok).toBe(false);
  await expect(progress.getByRole('link', { name: /^Commit / })).toBeVisible();
  expect(server.updates).toBe(1);
});

test('a rejected identity read pauses publication without logging credentials or provider diagnostics', async ({
  extensionContext, progress, problem,
}) => {
  const { server, auth, connection } = await setup(extensionContext, progress);
  auth.identityStatus = 401;
  await problem.getByRole('textbox', { name: 'Solution' }).fill(submittedSource);
  await problem.getByRole('button', { name: 'Submit', exact: true }).click();
  await expect(connection.getByRole('status')).toHaveText('GitHub authorization was rejected. Connect again.');
  await expect(progress.getByRole('button', { name: 'Check GitHub and retry delivery' })).toBeDisabled();
  const view = await progress.evaluate(() => chrome.runtime.sendMessage({ type: 'delivery:list' }));
  expect(view.jobs[0]).toMatchObject({ state: 'blocked', target: { userId: 42 }, snapshot: { source: submittedBytes } });
  expect(server.writes).toEqual([]);
  expect(await credentialSummary(progress)).toEqual({
    accessInSession: false, refreshInSession: false, deviceInSession: false, leakedOutsideSession: false,
  });
  expect(auth.logs.some(line => line.includes('SENSITIVE_FIXTURE_DETAIL') || line.includes('assign one'))).toBe(false);
});

test('recovery discovering revoked authorization pauses retained delivery and clears the rejected credential', async ({
  extensionContext, progress, problem,
}) => {
  const { server, auth, connection } = await setup(extensionContext, progress);
  server.loseBeforeAt = 'ref';
  await problem.getByRole('textbox', { name: 'Solution' }).fill(submittedSource);
  await problem.getByRole('button', { name: 'Submit', exact: true }).click();
  await expect(progress.getByText('Publication outcome is uncertain.', { exact: false })).toBeVisible();
  const before = await progress.evaluate(() => chrome.runtime.sendMessage({ type: 'delivery:list' }));
  auth.identityStatus = 401;
  await progress.getByRole('button', { name: 'Refresh saved progress' }).click();
  await expect(connection.getByRole('status')).toHaveText('GitHub authorization was rejected. Connect again.');
  await expect(progress.getByRole('button', { name: 'Check GitHub and retry delivery' })).toBeDisabled();
  expect((await credentialSummary(progress)).accessInSession).toBe(false);
  const after = await progress.evaluate(() => chrome.runtime.sendMessage({ type: 'delivery:list' }));
  expect(after.jobs).toEqual(before.jobs);
  expect(after.selection).toBeNull();
});

for (const mutation of ['creation', 'initialization'] as const) {
  test(`a rejected ${mutation} credential cannot stay authorized while original delivery work is retained`, async ({
    extensionContext, progress, problem,
  }) => {
    const { server, target, page, connection } = await setup(extensionContext, progress);
    server.loseBeforeAt = 'ref';
    await problem.getByRole('textbox', { name: 'Solution' }).fill(submittedSource);
    await problem.getByRole('button', { name: 'Submit', exact: true }).click();
    await expect(progress.getByText('Publication outcome is uncertain.', { exact: false })).toBeVisible();
    const before = await progress.evaluate(() => chrome.runtime.sendMessage({ type: 'delivery:list' }));
    switch (mutation) {
      case 'creation':
        target.exists = false;
        await extensionContext.route('https://api.github.com/user/repos', route =>
          route.fulfill({ status: 401, json: { message: 'SYNTHETIC_REJECTED_CREDENTIAL' } }));
        await page.getByRole('button', { name: 'Create public repository', exact: true }).click();
        break;
      case 'initialization':
        target.empty = true;
        target.marker = false;
        await extensionContext.route('https://api.github.com/repos/fixture-user/progress-solutions/contents/.progress-sync.json',
          route => route.request().method() === 'PUT'
            ? route.fulfill({ status: 401, json: { message: 'SYNTHETIC_REJECTED_CREDENTIAL' } }) : route.fallback());
        await page.getByLabel('Initialize this empty or previously requested repository with a Progress Sync marker').check();
        await page.getByRole('button', { name: 'Connect existing repository', exact: true }).click();
        break;
    }
    await expect(connection.getByRole('status')).toHaveText('GitHub authorization was rejected. Connect again.');
    expect((await credentialSummary(progress)).accessInSession).toBe(false);
    const after = await progress.evaluate(() => chrome.runtime.sendMessage({ type: 'delivery:list' }));
    expect(after.jobs).toEqual(before.jobs);
    expect(after.selection).toBeNull();
  });
}

test('recovery discovering lost repository access pauses delivery until access is verified again', async ({
  extensionContext, progress, problem,
}) => {
  const { server, target, page } = await setup(extensionContext, progress);
  server.loseBeforeAt = 'ref';
  await problem.getByRole('textbox', { name: 'Solution' }).fill(submittedSource);
  await problem.getByRole('button', { name: 'Submit', exact: true }).click();
  await expect(progress.getByText('Publication outcome is uncertain.', { exact: false })).toBeVisible();
  const before = await progress.evaluate(() => chrome.runtime.sendMessage({ type: 'delivery:list' }));
  target.included = false;
  await progress.getByRole('button', { name: 'Refresh saved progress' }).click();
  await expect(progress.getByRole('button', { name: 'Check GitHub and retry delivery' })).toBeDisabled();
  const paused = await progress.evaluate(() => chrome.runtime.sendMessage({ type: 'delivery:list' }));
  expect(paused.jobs).toEqual(before.jobs);
  expect(paused.selection).toBeNull();
  target.included = true;
  await page.getByRole('button', { name: 'Verify pending or saved repository' }).click();
  await expect(page.getByRole('status')).toContainText('Verified destination:');
  await expect(progress.getByRole('button', { name: 'Check GitHub and retry delivery' })).toBeEnabled();
});

test('failed explicit destination verification pauses previously eligible pending work', async ({
  extensionContext, progress, problem,
}) => {
  const { server, target, page } = await setup(extensionContext, progress);
  server.loseBeforeAt = 'ref';
  await problem.getByRole('textbox', { name: 'Solution' }).fill(submittedSource);
  await problem.getByRole('button', { name: 'Submit', exact: true }).click();
  await expect(progress.getByText('Publication outcome is uncertain.', { exact: false })).toBeVisible();
  const before = await progress.evaluate(() => chrome.runtime.sendMessage({ type: 'delivery:list' }));
  target.included = false;
  await page.getByRole('button', { name: 'Verify pending or saved repository' }).click();
  await expect(page.getByRole('status')).toHaveText(
    'The repository is not accessible to the selected App installation. Select it on GitHub, then verify again.',
  );
  await expect(progress.getByRole('button', { name: 'Check GitHub and retry delivery' })).toBeDisabled();
  const paused = await progress.evaluate(() => chrome.runtime.sendMessage({ type: 'delivery:list' }));
  expect(paused.jobs).toEqual(before.jobs);
  expect(paused.selection).toBeNull();
  target.included = true;
  await page.getByRole('button', { name: 'Verify pending or saved repository' }).click();
  await expect(page.getByRole('status')).toContainText('Verified destination:');
  await expect(progress.getByRole('button', { name: 'Check GitHub and retry delivery' })).toBeEnabled();
});
