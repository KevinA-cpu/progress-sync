import { expect, stopExtensionWorker, submittedBytes, submittedSource, successPage, test } from './fixtures';
import { CLIENT_ID } from './github-fixture';
import { setup } from './publication-setup';
import type { Browser } from 'wxt/browser';
import { createHash } from 'node:crypto';

declare const chrome: typeof Browser;

test.use({ githubClientId: CLIENT_ID });

test('an accepted guest submission publishes exact source and metadata in one complete commit', async ({
  extensionContext, progress, problem,
}) => {
  const { server } = await setup(extensionContext, progress);
  const gate = Promise.withResolvers<void>();
  server.writeGate = gate.promise;
  await problem.getByRole('textbox', { name: 'Solution' }).fill(submittedSource);
  await problem.getByRole('button', { name: 'Submit', exact: true }).click();
  await expect(progress.getByText('Accepted - awaiting GitHub delivery', { exact: true })).toBeVisible();
  await expect.poll(() => server.writes.length).toBe(1);
  expect([...server.files.keys()].filter(path => path.startsWith('progress/'))).toEqual([]);
  await problem.getByRole('textbox', { name: 'Solution' }).fill('later editor contents');
  gate.resolve();

  await expect(progress.getByText('Saved to GitHub', { exact: true })).toBeVisible();
  expect(server.updates).toBe(1);
  expect(server.requestsValid).toBe(true);
  expect(server.files.get('README.md')).toBe('Keep this learner file.\n');
  const attemptId = await progress.locator('article dd').first().innerText();
  const root = `progress/hdlbits/step_one/${attemptId}`;
  expect(server.files.get(`${root}/solution.v`)).toBe(submittedBytes);
  const metadata = server.files.get(`${root}/acceptance.json`);
  expect(metadata).toBeDefined();
  expect(JSON.parse(metadata!)).toEqual({
    schemaVersion: 1,
    provider: 'hdlbits',
    problemId: 'step_one',
    attemptId,
    sourceHash: 'e792e08eb073133e384987694229526ad3da6b1d3bcff73bada595e5f934dc0d',
    submittedAt: expect.any(String),
    observedAt: expect.any(String),
    provenance: { capture: 'browser-post', verdict: 'success' },
  });

  expect([...server.files.keys()].filter(path => path.startsWith('progress/')).sort()).toEqual([
    `${root}/acceptance.json`, `${root}/solution.v`,
  ]);
  await expect(progress.getByRole('link', { name: `Commit ${server.head}` }))
    .toHaveAttribute('href', `https://github.com/fixture-user/progress-solutions/commit/${server.head}`);
  await stopExtensionWorker(extensionContext, progress);
  await progress.reload();
  await expect(progress.getByText('Saved to GitHub', { exact: true })).toBeVisible();
  await expect(progress.getByRole('link', { name: `Commit ${server.head}` })).toBeVisible();
  expect(server.updates).toBe(1);
});

test('disconnect during durable intake does not poison later guest capture', async ({
  extensionContext, progress, problem,
}) => {
  const { server, connection } = await setup(extensionContext, progress);
  const progressUrl = progress.url();
  await progress.close();
  const worker = extensionContext.serviceWorkers()[0];
  if (!worker) throw new Error('Expected the active extension worker.');
  await worker.evaluate(() => {
    const original = chrome.storage.local.get.bind(chrome.storage.local);
    chrome.storage.local.get = new Proxy(original, {
      async apply(target, receiver, args) {
        const stored: unknown = await Reflect.apply(target, receiver, args);
        if (args[0] === 'destination-v1:42') {
          chrome.storage.local.get = original;
          await new Promise<void>(resolve => { Reflect.set(globalThis, 'releaseIntakeRead', resolve); });
        }
        return stored;
      },
    });
  });
  await problem.getByRole('textbox', { name: 'Solution' }).fill(submittedSource);
  await problem.getByRole('button', { name: 'Submit', exact: true }).click();
  await expect.poll(() => worker.evaluate(() => Reflect.has(globalThis, 'releaseIntakeRead'))).toBe(true);
  await connection.getByRole('button', { name: 'Disconnect GitHub' }).click();
  await expect(connection.getByRole('status')).toHaveText('Not connected to GitHub.');
  await worker.evaluate(() => {
    const release: unknown = Reflect.get(globalThis, 'releaseIntakeRead');
    if (typeof release !== 'function') throw new Error('Missing intake storage gate.');
    release();
  });
  const restored = await extensionContext.newPage();
  await restored.goto(progressUrl);
  await expect(restored.getByText('Accepted locally - delivery assignment blocked.', { exact: false })).toBeVisible();
  await problem.getByRole('button', { name: 'Submit', exact: true }).click();
  await expect(restored.getByRole('status')).toHaveText('2 captured attempts.');
  await expect(restored.getByText('Accepted locally - not saved to GitHub', { exact: true })).toHaveCount(1);
  expect(server.writes).toEqual([]);
});

test('an older local attempt requires an explicit public destination selection', async ({
  extensionContext, progress, problem,
}) => {
  await problem.getByRole('textbox', { name: 'Solution' }).fill(submittedSource);
  await problem.getByRole('button', { name: 'Submit', exact: true }).click();
  await expect(progress.getByText('Accepted locally - not saved to GitHub', { exact: true })).toBeVisible();
  const { server } = await setup(extensionContext, progress);
  await progress.reload();
  await expect(progress.getByText('Accepted locally - not saved to GitHub', { exact: true })).toBeVisible();
  expect(server.writes).toEqual([]);
  await progress.getByRole('button', {
    name: 'Publish accepted attempt to fixture-user/progress-solutions @ learning (public)', exact: true,
  }).click();
  await expect(progress.getByText('Saved to GitHub', { exact: true })).toBeVisible();
  expect(server.updates).toBe(1);
});

test('a job is durable before the first write and survives interrupted publication without retry', async ({
  extensionContext, progress, problem,
}) => {
  const { server } = await setup(extensionContext, progress);
  const gate = Promise.withResolvers<void>();
  server.writeGate = gate.promise;
  await problem.getByRole('textbox', { name: 'Solution' }).fill(submittedSource);
  await problem.getByRole('button', { name: 'Submit', exact: true }).click();
  await expect.poll(() => server.writes.length).toBe(1);
  await stopExtensionWorker(extensionContext, progress);
  await progress.reload();
  await expect(progress.getByText('Publication was interrupted.', { exact: false })).toBeVisible();
  gate.resolve();
  await progress.getByRole('button', { name: 'Refresh progress' }).click();
  await expect(progress.getByText('Publication was interrupted.', { exact: false })).toBeVisible();
  await expect(progress.getByRole('textbox', { name: 'Submitted source' })).toHaveValue(submittedSource);
  const reply = await progress.evaluate(() => chrome.runtime.sendMessage({ type: 'delivery:list' }));
  expect(reply).toMatchObject({ ok: true, jobs: [{
    schemaVersion: 1, state: 'uncertain', receipt: null,
    snapshot: { state: 'accepted', source: submittedBytes },
    target: { userId: 42, owner: 'fixture-user', name: 'progress-solutions', installationId: 77,
      appId: 99, repositoryId: 101, branch: 'learning', clientId: CLIENT_ID },
  }] });
  expect(reply.jobs[0].id).toBe(reply.jobs[0].snapshot.id);
  expect(server.writes).toHaveLength(1);
  expect(server.updates).toBe(0);
});

test('Unicode source keeps its submitted UTF-8 bytes on a nonstandard branch', async ({
  extensionContext, progress, problem,
}) => {
  const { server, target, page } = await setup(extensionContext, progress);
  target.defaultBranch = 'practice/verilog';
  await page.getByRole('button', { name: 'Connect existing repository', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('Verified destination: fixture-user/progress-solutions @ practice/verilog');
  const source = `// ${String.fromCodePoint(0x03bb, 0x1f680)}\n${submittedSource}`;
  await problem.locator('#codeform').evaluate((form: HTMLFormElement) => { form.acceptCharset = 'UTF-8'; });
  await problem.getByRole('textbox', { name: 'Solution' }).fill(source);
  await problem.getByRole('button', { name: 'Submit', exact: true }).click();
  await expect(progress.getByText('Saved to GitHub', { exact: true })).toBeVisible();
  const sourceEntry = [...server.files].find(([path]) => path.endsWith('/solution.v'));
  expect(sourceEntry?.[1]).toBe(source.replaceAll('\n', '\r\n'));
  const metadata = [...server.files].find(([path]) => path.endsWith('/acceptance.json'));
  expect(JSON.parse(metadata![1]).sourceHash).toBe(createHash('sha256').update(source.replaceAll('\n', '\r\n')).digest('hex'));
  expect(server.requestsValid).toBe(true);
  await expect(progress.getByRole('region', { name: 'Captured attempts' })
    .getByText('Destination: fixture-user/progress-solutions @ practice/verilog')).toBeVisible();
});

test('delivery messages reject arbitrary targets, forged snapshots, and stale selection consent', async ({
  extensionContext, progress, problem,
}) => {
  await problem.getByRole('textbox', { name: 'Solution' }).fill(submittedSource);
  await problem.getByRole('button', { name: 'Submit', exact: true }).click();
  await expect(progress.getByText('Accepted locally - not saved to GitHub', { exact: true })).toBeVisible();
  const { server, connection } = await setup(extensionContext, progress);
  const attemptId = await progress.locator('article dd').first().innerText();
  const replies = await progress.evaluate(async attemptId => {
    const view = await chrome.runtime.sendMessage({ type: 'delivery:list' });
    const input = {
      type: 'delivery:publish', attemptId, publicConfirmed: true,
      expectedConnectionId: view.selection.connectionId, expectedSelectionId: view.selection.operationId,
    };
    const extraFields = [
      { owner: 'attacker', repository: 'arbitrary', branch: 'main' },
      { path: '../../README.md' }, { source: 'unobserved source', state: 'accepted' },
      { url: 'https://unexpected.invalid/', method: 'DELETE' },
    ];
    return {
      malformed: await Promise.all(extraFields.map(extra => chrome.runtime.sendMessage({ ...input, ...extra }))),
      invalidId: await chrome.runtime.sendMessage({ ...input, attemptId: '../../elsewhere' }),
      stale: await chrome.runtime.sendMessage({ ...input, expectedSelectionId: '11111111-1111-4111-8111-111111111111' }),
      unknown: await chrome.runtime.sendMessage({ type: 'delivery:request', method: 'DELETE' }),
      unconfirmed: await chrome.runtime.sendMessage({ ...input, publicConfirmed: false }),
    };
  }, attemptId);
  expect(replies.malformed).toEqual(Array(4).fill({ ok: false, error: 'Unsupported delivery operation or sender.' }));
  expect(replies.invalidId).toEqual({ ok: false, error: 'Unsupported delivery operation or sender.' });
  expect(replies.unknown).toEqual(replies.invalidId);
  expect(replies.unconfirmed).toEqual(replies.invalidId);
  expect(replies.stale).toEqual({
    ok: false, error: 'The account or selected destination changed. This job has not been redirected.',
  });
  expect(await connection.evaluate(() => chrome.runtime.sendMessage({ type: 'delivery:list' })))
    .toEqual({ ok: false, error: 'Unsupported delivery operation or sender.' });
  expect(server.writes).toEqual([]);
});

test('failed grading cannot be promoted to an accepted upload through the privileged action', async ({
  extensionContext, progress, problem,
}) => {
  const { server } = await setup(extensionContext, progress);
  await extensionContext.route('**/runsim.php', route => route.fulfill({
    contentType: 'text/html',
    body: '<html><title>step_one: Simulation - HDLBits</title><h2>step_one - Compile and simulate</h2><h2>Status: Incorrect</h2></html>',
  }));
  await problem.getByRole('textbox', { name: 'Solution' }).fill(submittedSource);
  await problem.getByRole('button', { name: 'Submit', exact: true }).click();
  await expect(progress.getByText('Unverified:', { exact: false })).toBeVisible();
  const attemptId = await progress.locator('article dd').first().innerText();
  const reply = await progress.evaluate(async attemptId => {
    const view = await chrome.runtime.sendMessage({ type: 'delivery:list' });
    return chrome.runtime.sendMessage({
      type: 'delivery:publish', attemptId, expectedConnectionId: view.selection.connectionId,
      expectedSelectionId: view.selection.operationId, publicConfirmed: true,
    });
  }, attemptId);
  expect(reply).toEqual({ ok: false, error: 'Only a complete, validated accepted snapshot can be published.' });
  expect(server.writes).toEqual([]);
});

test('a truncated remote tree is blocked before any publication write', async ({
  extensionContext, progress, problem,
}) => {
  const { server } = await setup(extensionContext, progress);
  await extensionContext.route('https://api.github.com/repos/fixture-user/progress-solutions/git/trees/*', route =>
    route.fulfill({ json: { sha: 'b'.repeat(40), truncated: true, tree: [] } }));
  await problem.getByRole('textbox', { name: 'Solution' }).fill(submittedSource);
  await problem.getByRole('button', { name: 'Submit', exact: true }).click();
  await expect(progress.getByText('Delivery blocked: GitHub returned an unsupported publication response.', { exact: true }))
    .toBeVisible();
  expect(server.writes).toEqual([]);
});

test('a changed snapshot hash is rejected rather than publishing unverified bytes', async ({
  extensionContext, progress, problem,
}) => {
  await problem.getByRole('textbox', { name: 'Solution' }).fill(submittedSource);
  await problem.getByRole('button', { name: 'Submit', exact: true }).click();
  await expect(progress.getByText('Accepted locally - not saved to GitHub', { exact: true })).toBeVisible();
  const { server } = await setup(extensionContext, progress);
  await progress.evaluate(async () => {
    const stored = (await chrome.storage.local.get('attempts-v1'))['attempts-v1'];
    if (!Array.isArray(stored) || stored.length !== 1) throw new Error('Expected one stored attempt.');
    await chrome.storage.local.set({ 'attempts-v1': [{ ...stored[0], sourceHash: '0'.repeat(64) }] });
  });
  await progress.getByRole('button', { name: /^Publish accepted attempt to / }).click();
  await expect(progress.getByRole('alert')).toHaveText('Only a complete, validated accepted snapshot can be published.');
  expect(server.writes).toEqual([]);
});

test('a tree response without the complete intended files cannot produce a saved receipt', async ({
  extensionContext, progress, problem,
}) => {
  const { server } = await setup(extensionContext, progress);
  await extensionContext.route('https://api.github.com/repos/fixture-user/progress-solutions/git/trees', route =>
    route.fulfill({ status: 201, json: { sha: 'b'.repeat(40), truncated: false, tree: [] } }));
  await problem.getByRole('textbox', { name: 'Solution' }).fill(submittedSource);
  await problem.getByRole('button', { name: 'Submit', exact: true }).click();
  await expect(progress.getByText('Publication outcome is uncertain.', { exact: false })).toBeVisible();
  expect(server.updates).toBe(0);
  await expect(progress.getByRole('link', { name: /^Commit / })).toHaveCount(0);
});

for (const stage of ['tree', 'commit', 'ref'] as const) {
  for (const outcome of ['rejected', 'lost'] as const) {
    test(`${outcome} ${stage} publication never fabricates a receipt or retries the job`, async ({
      extensionContext, progress, problem,
    }) => {
      const { server } = await setup(extensionContext, progress);
      if (outcome === 'rejected') server.failAt = stage;
      else server.loseResponseAt = stage;
      await problem.getByRole('textbox', { name: 'Solution' }).fill(submittedSource);
      await problem.getByRole('button', { name: 'Submit', exact: true }).click();
      await expect(progress.getByText(outcome === 'rejected'
        ? 'Delivery blocked: GitHub rejected publication.' : 'Publication outcome is uncertain.', { exact: false })).toBeVisible();
      expect(server.updates).toBe(outcome === 'lost' && stage === 'ref' ? 1 : 0);
      expect([...server.files.keys()].filter(path => path.startsWith('progress/')))
        .toHaveLength(outcome === 'lost' && stage === 'ref' ? 2 : 0);
      expect(server.files.get('README.md')).toBe('Keep this learner file.\n');
      await expect(progress.getByRole('link', { name: /^Commit / })).toHaveCount(0);
      await expect(progress.getByText('SYNTHETIC_PRIVATE_DIAGNOSTIC', { exact: false })).toHaveCount(0);
      const before = server.writes.length;
      await progress.reload();
      await progress.evaluate(async () => {
        const view = await chrome.runtime.sendMessage({ type: 'delivery:list' });
        await chrome.runtime.sendMessage({
          type: 'delivery:publish', attemptId: view.jobs[0].id, expectedConnectionId: view.jobs[0].target.connectionId,
          expectedSelectionId: view.jobs[0].target.operationId, publicConfirmed: true,
        });
      });
      expect(server.writes).toHaveLength(before);
      await expect(progress.getByRole('textbox', { name: 'Submitted source' })).toHaveValue(submittedSource);
    });
  }
}

test('an explicit rate-limit rejection is blocked rather than confused with a lost response', async ({
  extensionContext, progress, problem,
}) => {
  const { server } = await setup(extensionContext, progress);
  server.failAt = 'ref';
  server.failStatus = 429;
  await problem.getByRole('textbox', { name: 'Solution' }).fill(submittedSource);
  await problem.getByRole('button', { name: 'Submit', exact: true }).click();
  await expect(progress.getByText('Delivery blocked: GitHub rejected publication.', { exact: false })).toBeVisible();
  expect(server.updates).toBe(0);
  await expect(progress.getByRole('link', { name: /^Commit / })).toHaveCount(0);
});

for (const status of [408, 503]) {
  test(`a ${status} write response stays uncertain and is not retried`, async ({
    extensionContext, progress, problem,
  }) => {
    const { server } = await setup(extensionContext, progress);
    server.failAt = 'ref';
    server.failStatus = status;
    await problem.getByRole('textbox', { name: 'Solution' }).fill(submittedSource);
    await problem.getByRole('button', { name: 'Submit', exact: true }).click();
    await expect(progress.getByText('Publication outcome is uncertain.', { exact: false })).toBeVisible();
    const count = server.writes.length;
    await progress.reload();
    await expect(progress.getByText('Publication outcome is uncertain.', { exact: false })).toBeVisible();
    expect(server.writes).toHaveLength(count);
    await expect(progress.getByRole('link', { name: /^Commit / })).toHaveCount(0);
  });
}

test('a local receipt error with an HTTP-like status cannot prove that GitHub rejected the write', async ({
  extensionContext, progress, problem,
}) => {
  const { server } = await setup(extensionContext, progress);
  const worker = extensionContext.serviceWorkers()[0];
  if (!worker) throw new Error('Expected the active extension worker.');
  await worker.evaluate(() => {
    const original = chrome.storage.local.set.bind(chrome.storage.local);
    chrome.storage.local.set = async items => {
      const jobs: unknown = Reflect.get(items, 'delivery-jobs-v1');
      if (Array.isArray(jobs) && jobs.some(job => job.state === 'saved')) {
        chrome.storage.local.set = original;
        throw Object.assign(new Error('SYNTHETIC_LOCAL_FAILURE'), { status: 403 });
      }
      return original(items);
    };
  });
  await problem.getByRole('textbox', { name: 'Solution' }).fill(submittedSource);
  await problem.getByRole('button', { name: 'Submit', exact: true }).click();
  await expect(progress.getByText('Publication outcome is uncertain.', { exact: false })).toBeVisible();
  expect(server.updates).toBe(1);
  await expect(progress.getByRole('link', { name: /^Commit / })).toHaveCount(0);
  await expect(progress.getByText('SYNTHETIC_LOCAL_FAILURE', { exact: false })).toHaveCount(0);
});

test('a later read rejection is not mistaken for a rejection of the earlier mutation', async ({
  extensionContext, progress, problem,
}) => {
  const { server } = await setup(extensionContext, progress);
  await extensionContext.route('https://api.github.com/repos/fixture-user/progress-solutions/git/trees/*',
    route => new URL(route.request().url()).pathname.endsWith(`/${'b'.repeat(40)}`)
      ? route.fallback()
      : route.fulfill({ status: 403, json: { message: 'SYNTHETIC_READ_FAILURE' } }));
  await problem.getByRole('textbox', { name: 'Solution' }).fill(submittedSource);
  await problem.getByRole('button', { name: 'Submit', exact: true }).click();
  await expect(progress.getByText('Publication outcome is uncertain.', { exact: false })).toBeVisible();
  expect(server.writes).toHaveLength(1);
  expect(server.updates).toBe(0);
  await expect(progress.getByRole('link', { name: /^Commit / })).toHaveCount(0);
});

test('a concurrent branch advance is preserved by the non-force update', async ({
  extensionContext, progress, problem,
}) => {
  const { server } = await setup(extensionContext, progress);
  server.advanceBeforeUpdate = true;
  await problem.getByRole('textbox', { name: 'Solution' }).fill(submittedSource);
  await problem.getByRole('button', { name: 'Submit', exact: true }).click();
  await expect(progress.getByText('Delivery blocked: GitHub rejected publication.', { exact: false })).toBeVisible();
  expect(server.files.get('concurrent.txt')).toBe('Another writer.\n');
  expect(server.files.get('README.md')).toBe('Keep this learner file.\n');
  expect(server.updates).toBe(0);
  expect([...server.files.keys()].filter(path => path.startsWith('progress/'))).toEqual([]);
  await expect(progress.getByRole('link', { name: /^Commit / })).toHaveCount(0);
});

test('a later accepted attempt preserves the previously published progress', async ({
  extensionContext, progress, problem,
}) => {
  const { server } = await setup(extensionContext, progress);
  await problem.getByRole('textbox', { name: 'Solution' }).fill(submittedSource);
  await problem.getByRole('button', { name: 'Submit', exact: true }).click();
  await expect(progress.getByText('Saved to GitHub', { exact: true })).toHaveCount(1);
  const previousFiles = new Map(server.files);
  await problem.getByRole('textbox', { name: 'Solution' }).fill(`// Another accepted attempt\n${submittedSource}`);
  await problem.getByRole('button', { name: 'Submit', exact: true }).click();
  await expect(progress.getByText('Saved to GitHub', { exact: true })).toHaveCount(2);
  for (const [path, content] of previousFiles) expect(server.files.get(path)).toBe(content);
  expect(server.updates).toBe(2);
  expect([...server.files.keys()].filter(path => path.startsWith('progress/'))).toHaveLength(4);
});

test('a second accepted attempt becomes durable while an earlier upload is still outstanding', async ({
  extensionContext, progress, problem,
}) => {
  const { server } = await setup(extensionContext, progress);
  const gate = Promise.withResolvers<void>();
  server.writeGate = gate.promise;
  await problem.getByRole('textbox', { name: 'Solution' }).fill(submittedSource);
  await problem.getByRole('button', { name: 'Submit', exact: true }).click();
  await expect.poll(() => server.writes.length).toBe(1);
  await problem.getByRole('textbox', { name: 'Solution' }).fill(`// Second snapshot\n${submittedSource}`);
  await problem.getByRole('button', { name: 'Submit', exact: true }).click();
  await expect(progress.getByText('Accepted - awaiting GitHub delivery', { exact: true })).toHaveCount(2);
  await stopExtensionWorker(extensionContext, progress);
  await progress.reload();
  await expect(progress.getByText('Publication was interrupted.', { exact: false })).toHaveCount(1);
  await expect(progress.getByText('Accepted - awaiting GitHub delivery', { exact: true })).toHaveCount(1);
  const reply = await progress.evaluate(() => chrome.runtime.sendMessage({ type: 'delivery:list' }));
  expect(reply.jobs).toHaveLength(2);
  expect(reply.jobs.map((job: { state: string }) => job.state).sort()).toEqual(['pending', 'uncertain']);
  expect(reply.jobs[1]).toMatchObject({
    target: { userId: 42, repositoryId: 101, installationId: 77, branch: 'learning' },
    snapshot: { source: `// Second snapshot\r\n${submittedBytes}` },
  });
  gate.resolve();
  expect(server.writes).toHaveLength(1);
});

test('a delivery-intake failure remains visible without disabling local capture', async ({
  extensionContext, progress, problem,
}) => {
  const { server } = await setup(extensionContext, progress);
  const worker = extensionContext.serviceWorkers()[0];
  if (!worker) throw new Error('Expected the active extension worker.');
  await worker.evaluate(() => {
    const original = chrome.storage.local.set.bind(chrome.storage.local);
    chrome.storage.local.set = async items => {
      if (Object.hasOwn(items, 'delivery-jobs-v1')) {
        chrome.storage.local.set = original;
        throw new Error('Synthetic delivery-only storage failure');
      }
      return original(items);
    };
  });
  await problem.getByRole('textbox', { name: 'Solution' }).fill(submittedSource);
  await problem.getByRole('button', { name: 'Submit', exact: true }).click();
  await expect(progress.getByText('Accepted locally - delivery assignment blocked.', { exact: false })).toBeVisible();
  expect(server.writes).toEqual([]);
  await progress.reload();
  await expect(progress.getByText('Accepted locally - delivery assignment blocked.', { exact: false })).toBeVisible();
  await problem.getByRole('button', { name: 'Submit', exact: true }).click();
  await expect(progress.getByRole('status')).toHaveText('2 captured attempts.');
  await expect(progress.getByText('Saved to GitHub', { exact: true })).toHaveCount(1);
  await expect(progress.getByText('Accepted locally - delivery assignment blocked.', { exact: false })).toHaveCount(1);
  expect(server.updates).toBe(1);
});

for (const phase of ['grading', 'publishing']) {
  test(`re-verifying the same connection and destination during ${phase} does not change consent`, async ({
    extensionContext, progress, problem,
  }) => {
    const { server, connection, page } = await setup(extensionContext, progress);
    const gate = Promise.withResolvers<void>();
    const submitted = Promise.withResolvers<void>();
    if (phase === 'grading') {
      await extensionContext.route('**/runsim.php', async route => {
        submitted.resolve();
        await gate.promise;
        await route.fulfill({ contentType: 'text/html', body: successPage });
      });
    } else {
      server.writeGate = gate.promise;
    }
    await problem.getByRole('textbox', { name: 'Solution' }).fill(submittedSource);
    await problem.getByRole('button', { name: 'Submit', exact: true }).click();
    if (phase === 'grading') await submitted.promise;
    else await expect.poll(() => server.writes.length).toBe(1);
    await connection.getByRole('button', { name: 'Check connection', exact: true }).click();
    await expect(connection.getByRole('status')).toHaveText('Connected as fixture-user');
    await page.getByRole('button', { name: 'Refresh installations', exact: true }).click();
    await page.getByRole('button', { name: 'Verify pending or saved repository' }).click();
    await expect(page.getByRole('status')).toHaveText('Verified destination: fixture-user/progress-solutions @ learning');
    gate.resolve();
    await expect(progress.getByText('Saved to GitHub', { exact: true })).toBeVisible();
    expect(server.updates).toBe(1);
  });
}

for (const conflict of ['source-only', 'ancestor-file']) {
  test(`a remote ${conflict} cannot be overwritten or mistaken for a complete delivery`, async ({
    extensionContext, progress, problem,
  }) => {
    await problem.getByRole('textbox', { name: 'Solution' }).fill(submittedSource);
    await problem.getByRole('button', { name: 'Submit', exact: true }).click();
    await expect(progress.getByText('Accepted locally - not saved to GitHub', { exact: true })).toBeVisible();
    const attemptId = await progress.locator('article dd').first().innerText();
    const { server } = await setup(extensionContext, progress);
    const path = conflict === 'source-only'
      ? `progress/hdlbits/step_one/${attemptId}/solution.v` : 'progress/hdlbits';
    server.seedFiles({ [path]: submittedBytes });
    await progress.getByRole('button', { name: /^Publish accepted attempt to / }).click();
    await expect(progress.getByText('Delivery blocked: An attempt path already exists', { exact: false })).toBeVisible();
    expect(server.files.get(path)).toBe(submittedBytes);
    expect(server.writes).toEqual([]);
    await expect(progress.getByRole('link', { name: /^Commit / })).toHaveCount(0);
  });
}

test('publication rechecks permissions and repository identity after onboarding', async ({
  extensionContext, progress, problem,
}) => {
  const { server, target, page } = await setup(extensionContext, progress);
  target.contentsWrite = false;
  await problem.getByRole('textbox', { name: 'Solution' }).fill(submittedSource);
  await problem.getByRole('button', { name: 'Submit', exact: true }).click();
  await expect(progress.getByText('Delivery blocked: Repository writing', { exact: false })).toBeVisible();
  expect(server.writes).toEqual([]);
  await expect(progress.getByRole('textbox', { name: 'Submitted source' })).toHaveValue(submittedSource);

  target.contentsWrite = true;
  await page.getByRole('button', { name: 'Verify pending or saved repository' }).click();
  await expect(page.getByRole('status')).toContainText('Verified destination:');
  target.repositoryId = 202;
  await problem.getByRole('button', { name: 'Submit', exact: true }).click();
  await expect(progress.getByText('Delivery blocked: The repository identity, owner, or visibility changed.', { exact: false })).toBeVisible();
  expect(server.writes).toEqual([]);
});

test('disconnect during publication retains the original job without sending later writes', async ({
  extensionContext, progress, problem,
}) => {
  const { server, connection } = await setup(extensionContext, progress);
  const gate = Promise.withResolvers<void>();
  server.writeGate = gate.promise;
  await problem.getByRole('textbox', { name: 'Solution' }).fill(submittedSource);
  await problem.getByRole('button', { name: 'Submit', exact: true }).click();
  await expect.poll(() => server.writes.length).toBe(1);
  await connection.getByRole('button', { name: 'Disconnect GitHub' }).click();
  await expect(connection.getByRole('status')).toHaveText('Not connected to GitHub.');
  gate.resolve();
  await expect(progress.getByText('Publication outcome is uncertain.', { exact: false })).toBeVisible();
  await expect(progress.getByText('Destination: fixture-user/progress-solutions @ learning', { exact: true })).toBeVisible();
  expect(server.writes).toHaveLength(1);
  expect(server.updates).toBe(0);
});
