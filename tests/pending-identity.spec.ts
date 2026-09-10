import type { BrowserContext, Page, Route } from '@playwright/test';
import type { Browser } from 'wxt/browser';
import { z } from 'zod';
import { expect, launchExtensionProfile, submittedBytes, submittedSource, test } from './fixtures';
import { ACCESS_TOKEN, CLIENT_ID, REFRESH_TOKEN, credentialSummary, githubFixture, openConnection } from './github-fixture';
import { destinationFixture } from './destination-fixture';
import { publicationFixture } from './publication-fixture';
import { setup } from './publication-setup';

declare const chrome: typeof Browser;

test.use({ githubClientId: CLIENT_ID });

const retryName = 'Check GitHub and retry delivery';
const tokenResponse = {
  access_token: ACCESS_TOKEN, refresh_token: REFRESH_TOKEN, token_type: 'bearer', scope: '',
  expires_in: 28_800, refresh_token_expires_in: 15_811_200,
};
const noCredentials = {
  accessInSession: false, refreshInSession: false, deviceInSession: false, leakedOutsideSession: false,
};
const shaSchema = z.string().regex(/^[0-9a-f]{40}$/);
const destinationTargetSchema = z.object({
  operationId: z.uuid(), connectionId: z.uuid(), userId: z.int().positive(),
  owner: z.string().min(1), name: z.string().min(1), branch: z.string().min(1),
  clientId: z.string().min(1), appId: z.int().positive(), installationId: z.int().positive(),
  repositoryId: z.int().positive(), selectedAt: z.iso.datetime(),
});
const deliveryJobSchema = z.object({
  id: z.uuid(), createdAt: z.iso.datetime(), target: destinationTargetSchema,
  snapshot: z.object({
    id: z.uuid(), provider: z.literal('hdlbits'), problemId: z.string().min(1),
    source: z.string(), sourceHash: z.string().regex(/^[0-9a-f]{64}$/),
    submittedAt: z.iso.datetime(), observedAt: z.iso.datetime(), state: z.literal('accepted'),
  }),
  state: z.enum(['pending', 'publishing', 'reconciling', 'uncertain', 'blocked', 'saved']),
  detail: z.string().nullable(),
  candidate: z.object({ baseCommitSha: shaSchema, treeSha: shaSchema, commitSha: shaSchema }).nullable(),
  receipt: z.object({ commitSha: shaSchema }).nullable(),
});
const deliveryReplySchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), jobs: z.array(deliveryJobSchema), selection: destinationTargetSchema.nullable() }),
  z.object({ ok: z.literal(false), error: z.string() }),
]);
type DeliveryJob = z.infer<typeof deliveryJobSchema>;
type DestinationTarget = z.infer<typeof destinationTargetSchema>;

async function retainedDelivery(progress: Page) {
  const reply = deliveryReplySchema.parse(
    await progress.evaluate(() => chrome.runtime.sendMessage({ type: 'delivery:list' })),
  );
  if (!reply.ok) throw new Error(reply.error);
  const [job] = reply.jobs;
  if (!job || reply.jobs.length !== 1) throw new Error('Expected exactly one retained delivery.');
  return { job, selection: reply.selection };
}

async function captureUncertain(problem: Page, progress: Page): Promise<DeliveryJob> {
  await problem.getByRole('textbox', { name: 'Solution' }).fill(submittedSource);
  await problem.getByRole('button', { name: 'Submit', exact: true }).click();
  await expect(progress.getByText('Publication outcome is uncertain.', { exact: false })).toBeVisible();
  return (await retainedDelivery(progress)).job;
}

async function expectOriginalJob(progress: Page, original: DeliveryJob) {
  const current = await retainedDelivery(progress);
  expect(current.job).toMatchObject({
    id: original.id, snapshot: original.snapshot, target: original.target,
    createdAt: original.createdAt, candidate: original.candidate,
  });
  expect(current.job.snapshot.source).toBe(submittedBytes);
  const captured = progress.getByRole('region', { name: 'Captured attempts' });
  await expect(captured.getByText('Original GitHub account: fixture-user (ID 42)', { exact: true })).toBeVisible();
  await expect(captured.getByText('Destination: fixture-user/progress-solutions @ learning', { exact: true })).toBeVisible();
  await expect(captured.getByRole('textbox', { name: 'Submitted source (read-only)' })).toHaveValue(submittedSource);
  return current;
}

async function observeApi(context: BrowserContext) {
  const requests: Array<{ method: string; path: string }> = [];
  await context.route('https://api.github.com/**', async route => {
    requests.push({ method: route.request().method(), path: new URL(route.request().url()).pathname });
    await route.fallback();
  });
  return requests;
}

async function retryMessage(progress: Page, job: DeliveryJob, selection: DestinationTarget) {
  return deliveryReplySchema.parse(await progress.evaluate(input => chrome.runtime.sendMessage(input), {
    type: 'delivery:retry', jobId: job.id,
    expectedConnectionId: selection.connectionId, expectedSelectionId: selection.operationId,
  }));
}

async function verifyOriginalDestination(destination: Page) {
  await destination.getByRole('button', { name: 'Refresh installations' }).click();
  await destination.getByRole('button', { name: 'Verify pending or saved repository' }).click();
  await expect(destination.getByRole('status'))
    .toHaveText('Verified destination: fixture-user/progress-solutions @ learning');
}

test('expiration before retry clears credentials without sending or redirecting the retained job', async ({
  extensionContext, progress, problem,
}) => {
  const { server, connection } = await setup(extensionContext, progress);
  server.loseBeforeAt = 'ref';
  const original = await captureUncertain(problem, progress);
  const requests = await observeApi(extensionContext);
  const writes = server.writes.length;
  await expect(progress.getByRole('button', { name: retryName })).toBeEnabled();
  const worker = extensionContext.serviceWorkers()[0];
  if (!worker) throw new Error('Expected an active extension worker.');
  await worker.evaluate(now => { Date.now = () => now; }, Date.now() + 9 * 60 * 60 * 1000);

  await progress.getByRole('button', { name: retryName }).click();

  await expect(connection.getByRole('status')).toHaveText('The GitHub session expired. Connect again.');
  await expect(progress.getByRole('button', { name: retryName })).toBeDisabled();
  expect(await credentialSummary(progress)).toEqual(noCredentials);
  const after = await expectOriginalJob(progress, original);
  expect(after.selection).toBeNull();
  expect(after.job.receipt).toBeNull();
  expect(requests).toEqual([]);
  expect(server.writes).toHaveLength(writes);
  expect(server.updates).toBe(0);
});

test('a different account cannot inherit pending work and returning to the original account needs explicit verification', async ({
  extensionContext, progress, problem,
}) => {
  const { server, connection, page } = await setup(extensionContext, progress);
  server.loseBeforeAt = 'ref';
  const original = await captureUncertain(problem, progress);
  await connection.getByRole('button', { name: 'Disconnect GitHub' }).click();
  await expect(connection.getByRole('status')).toHaveText('Not connected to GitHub.');

  const otherAccessToken = 'ghu_SYNTHETIC_OTHER_ACCOUNT_NOT_REAL';
  const otherToken = (route: Route) => route.fulfill({ headers: { date: new Date().toUTCString() }, json: {
    ...tokenResponse, access_token: otherAccessToken, refresh_token: 'ghr_SYNTHETIC_OTHER_ACCOUNT_NOT_REAL',
  } });
  const otherIdentity = async (route: Route) => {
    expect((await route.request().allHeaders()).authorization).toBe(`token ${otherAccessToken}`);
    await route.fulfill({ json: { id: 84, login: 'other-fixture-user' } });
  };
  await extensionContext.route('https://github.com/login/oauth/access_token', otherToken);
  await extensionContext.route('https://api.github.com/user', otherIdentity);
  await connection.getByRole('button', { name: 'Connect GitHub', exact: true }).click();
  await expect(connection.getByRole('status')).toHaveText('Connected as other-fixture-user');
  await expect(progress.getByRole('button', { name: retryName })).toBeDisabled();
  const requests = await observeApi(extensionContext);
  const writes = server.writes.length;
  const other = await expectOriginalJob(progress, original);
  expect(other.selection).toBeNull();
  expect(other.job.receipt).toBeNull();
  await retryMessage(progress, original, original.target);
  expect(requests).toEqual([]);
  expect(server.writes).toHaveLength(writes);

  await connection.getByRole('button', { name: 'Disconnect GitHub' }).click();
  await expect(connection.getByRole('status')).toHaveText('Not connected to GitHub.');
  await extensionContext.unroute('https://github.com/login/oauth/access_token', otherToken);
  await extensionContext.unroute('https://api.github.com/user', otherIdentity);
  await connection.getByRole('button', { name: 'Connect GitHub', exact: true }).click();
  await expect(connection.getByRole('status')).toHaveText('Connected as fixture-user');
  await expect(progress.getByRole('button', { name: retryName })).toBeDisabled();
  await page.getByRole('button', { name: 'Refresh installations' }).click();
  await expect(page.getByText('Saved setup:', { exact: false })).toContainText('fixture-user/progress-solutions');
  expect((await expectOriginalJob(progress, original)).selection).toBeNull();
  expect(server.writes).toHaveLength(writes);

  await page.getByRole('button', { name: 'Verify pending or saved repository' }).click();
  await expect(page.getByRole('status')).toHaveText('Verified destination: fixture-user/progress-solutions @ learning');
  await expect(progress.getByRole('button', { name: retryName })).toBeEnabled();
  const verified = await expectOriginalJob(progress, original);
  expect(verified.selection?.connectionId).not.toBe(original.target.connectionId);
  expect(verified.job.receipt).toBeNull();
  expect(server.writes).toHaveLength(writes);
  server.loseBeforeAt = null;
  await progress.getByRole('button', { name: retryName }).click();
  await expect(progress.getByRole('region', { name: 'Captured attempts' }).getByText('Saved to GitHub', { exact: true }))
    .toBeVisible();
  expect((await expectOriginalJob(progress, original)).job.receipt?.commitSha).toBe(original.candidate?.commitSha);
  expect(server.updates).toBe(1);
  expect(server.writes.filter(write => write.path.endsWith('/git/commits'))).toHaveLength(1);
});

for (const change of ['repository', 'branch'] as const) {
  test(`switching the selected ${change} blocks retry until the original destination is explicitly restored`, async ({
    extensionContext, progress, problem,
  }) => {
    const { server, page } = await setup(extensionContext, progress);
    server.loseBeforeAt = 'ref';
    const original = await captureUncertain(problem, progress);
    let selectedName = original.target.name;
    let selectedBranch = original.target.branch;
    let selectedRepositoryId = original.target.repositoryId;
    switch (change) {
      case 'repository': {
        selectedName = 'progress-archive';
        selectedRepositoryId = 202;
        const repository = {
          id: selectedRepositoryId, name: selectedName, owner: { id: 42, login: 'fixture-user', type: 'User' },
          private: false, archived: false, disabled: false, default_branch: 'learning',
          permissions: { push: true, admin: true },
        };
        const base = '/repos/fixture-user/progress-archive';
        await extensionContext.route(url => url.origin === 'https://api.github.com'
          && (url.pathname === '/user/installations/77/repositories'
            || url.pathname === base || url.pathname.startsWith(`${base}/`)), async route => {
          expect(route.request().method()).toBe('GET');
          expect((await route.request().allHeaders()).authorization).toBe(`token ${ACCESS_TOKEN}`);
          const url = new URL(route.request().url());
          switch (url.pathname) {
            case '/user/installations/77/repositories':
              return route.fulfill({ json: {
                total_count: 2, repositories: [{ id: original.target.repositoryId }, repository],
              } });
            case base:
              return route.fulfill({ json: repository });
            case `${base}/branches`:
              return route.fulfill({ json: [{ name: 'learning' }] });
            case `${base}/branches/learning`:
              return route.fulfill({ json: {
                name: 'learning', commit: { sha: 'c'.repeat(40) }, protected: false,
              } });
            case `${base}/contents/.progress-sync.json`:
              expect(['learning', 'c'.repeat(40)]).toContain(url.searchParams.get('ref'));
              return route.fulfill({ json: {
                type: 'file', encoding: 'base64',
                content: Buffer.from(JSON.stringify({
                  kind: 'progress-sync', schemaVersion: 1,
                  initializationId: '87654321-4321-4321-8321-cba987654321',
                })).toString('base64'),
              } });
            default:
              throw new Error(`Unexpected alternate repository request: ${url.pathname}`);
          }
        });
        break;
      }
      case 'branch':
        selectedBranch = 'practice/verilog';
        await extensionContext.route(url => url.origin === 'https://api.github.com'
          && decodeURIComponent(url.pathname) === '/repos/fixture-user/progress-solutions/branches/practice/verilog',
        async route => {
          expect(route.request().method()).toBe('GET');
          expect((await route.request().allHeaders()).authorization).toBe(`token ${ACCESS_TOKEN}`);
          await route.fulfill({ json: {
            name: 'practice/verilog', commit: { sha: 'c'.repeat(40) }, protected: false,
          } });
        });
        break;
    }
    const selectedBase = `/repos/fixture-user/${selectedName}`;
    await extensionContext.route(url => url.origin === 'https://api.github.com'
      && (url.pathname === `${selectedBase}/git/commits/${'c'.repeat(40)}`
        || url.pathname === `${selectedBase}/git/trees/${'d'.repeat(40)}`), async route => {
      expect(route.request().method()).toBe('GET');
      const commit = new URL(route.request().url()).pathname.includes('/git/commits/');
      await route.fulfill({ json: commit
        ? { sha: 'c'.repeat(40), tree: { sha: 'd'.repeat(40) }, parents: [] }
        : { sha: 'd'.repeat(40), tree: [], truncated: false } });
    });
    const requests = await observeApi(extensionContext);
    const writes = server.writes.length;
    await page.getByLabel('Repository name', { exact: true }).fill(selectedName);
    await page.getByLabel('Branch (optional)', { exact: true }).fill(selectedBranch);
    await page.getByRole('button', { name: 'Connect existing repository', exact: true }).click();
    await expect(page.getByRole('status')).toHaveText(`Verified destination: fixture-user/${selectedName} @ ${selectedBranch}`);
    await expect(progress.getByRole('button', { name: retryName })).toBeDisabled();
    await expect(progress.getByText('This job will not be redirected.', { exact: false })).toBeVisible();
    const changed = await expectOriginalJob(progress, original);
    expect(changed.selection).toMatchObject({ name: selectedName, branch: selectedBranch, repositoryId: selectedRepositoryId });
    if (!changed.selection) throw new Error('Expected the changed destination to be selected.');
    await expect(progress.getByRole('region', { name: 'Saved progress from GitHub' }).getByText(
      '0 recorded accepted; 0 unverified saved entries.', { exact: true },
    )).toBeVisible();
    expect(requests.every(request => request.method === 'GET')).toBe(true);
    const inspected = requests.length;

    await retryMessage(progress, original, changed.selection);

    await expect(progress.getByText('Delivery blocked: The account or selected destination changed.', { exact: false })).toBeVisible();
    expect((await expectOriginalJob(progress, original)).job.receipt).toBeNull();
    expect(requests).toHaveLength(inspected);
    expect(server.writes).toHaveLength(writes);
    expect(server.updates).toBe(0);
    await page.getByLabel('Repository name', { exact: true }).fill(original.target.name);
    await page.getByLabel('Branch (optional)', { exact: true }).fill(original.target.branch);
    await page.getByRole('button', { name: 'Connect existing repository', exact: true }).click();
    await expect(page.getByRole('status')).toHaveText('Verified destination: fixture-user/progress-solutions @ learning');
    await expect(progress.getByRole('button', { name: retryName })).toBeEnabled();
    expect(server.writes).toHaveLength(writes);
    server.loseBeforeAt = null;
    await progress.getByRole('button', { name: retryName }).click();
    await expect(progress.getByRole('region', { name: 'Captured attempts' }).getByText('Saved to GitHub', { exact: true }))
      .toBeVisible();
    expect((await expectOriginalJob(progress, original)).job.receipt?.commitSha).toBe(original.candidate?.commitSha);
    expect(server.updates).toBe(1);
    expect(server.writes.filter(write => write.path.endsWith('/git/commits'))).toHaveLength(1);
  });
}

test('disconnecting a held reference request retains uncertainty even when GitHub completes it, then recovers its original receipt', async ({
  extensionContext, progress, problem,
}) => {
  const { server, connection, page } = await setup(extensionContext, progress);
  const gate = Promise.withResolvers<void>();
  server.refGate = gate.promise;
  try {
    await problem.getByRole('textbox', { name: 'Solution' }).fill(submittedSource);
    await problem.getByRole('button', { name: 'Submit', exact: true }).click();
    await expect.poll(() => server.writes.filter(write => write.method === 'PATCH').length).toBe(1);
    const original = (await retainedDelivery(progress)).job;
    if (!original.candidate) throw new Error('Expected the prepared commit before the reference request.');
    expect(original.state).toBe('publishing');
    expect(server.updates).toBe(0);
    await expect(connection.getByRole('button', { name: 'Disconnect GitHub' })).toBeEnabled();
    await connection.getByRole('button', { name: 'Disconnect GitHub' }).click();
    await expect(connection.getByRole('status')).toHaveText('Not connected to GitHub.');
    expect(await credentialSummary(progress)).toEqual(noCredentials);
    await expect(progress.getByText('Publication outcome is uncertain.', { exact: false })).toBeVisible();
    await expect(progress.getByRole('button', { name: retryName })).toBeDisabled();
    const writes = server.writes.length;
    gate.resolve();
    await expect.poll(() => server.refCompletions).toBe(1);
    expect(server.head).toBe(original.candidate.commitSha);
    expect(server.updates).toBe(1);
    await progress.reload();
    const disconnected = await expectOriginalJob(progress, original);
    expect(disconnected.job).toMatchObject({ state: 'uncertain', receipt: null });
    expect(disconnected.selection).toBeNull();
    await expect(progress.getByRole('link', { name: /^Commit / })).toHaveCount(0);

    await connection.getByRole('button', { name: 'Connect GitHub', exact: true }).click();
    await expect(connection.getByRole('status')).toHaveText('Connected as fixture-user');
    await expect(progress.getByRole('button', { name: retryName })).toBeDisabled();
    await verifyOriginalDestination(page);
    await expect(progress.getByRole('button', { name: retryName })).toBeEnabled();
    expect((await retainedDelivery(progress)).job.receipt).toBeNull();
    expect(server.writes).toHaveLength(writes);
    await progress.getByRole('button', { name: retryName }).click();
    await expect(progress.getByRole('link', { name: `Commit ${original.candidate.commitSha}`, exact: true })).toBeVisible();
    const recovered = await expectOriginalJob(progress, original);
    expect(recovered.job.state).toBe('saved');
    expect(recovered.job.receipt?.commitSha).toBe(original.candidate.commitSha);
    expect(server.writes).toHaveLength(writes);
    expect(server.updates).toBe(1);
    expect([...server.files.values()]).toContain(submittedBytes);
  } finally {
    gate.resolve();
  }
});

for (const scenario of ['cancel delayed token', 'disconnect delayed identity'] as const) {
  test(`${scenario} cannot restore credentials or resume retained work after its response arrives`, async ({
    extensionContext, progress, problem,
  }) => {
    const { server, connection, auth } = await setup(extensionContext, progress);
    server.loseBeforeAt = 'ref';
    const original = await captureUncertain(problem, progress);
    await connection.getByRole('button', { name: 'Disconnect GitHub' }).click();
    await expect(connection.getByRole('status')).toHaveText('Not connected to GitHub.');
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const settled = Promise.withResolvers<void>();
    let endpoint: string;
    let response: typeof tokenResponse | { id: number; login: string };
    let stopButton: string;
    let stoppedStatus: string;
    switch (scenario) {
      case 'cancel delayed token':
        endpoint = 'https://github.com/login/oauth/access_token';
        response = tokenResponse;
        stopButton = 'Cancel authorization';
        stoppedStatus = 'GitHub authorization cancelled.';
        break;
      case 'disconnect delayed identity':
        endpoint = 'https://api.github.com/user';
        response = { id: 42, login: 'fixture-user' };
        stopButton = 'Disconnect GitHub';
        stoppedStatus = 'Not connected to GitHub.';
        break;
    }
    let heldRequests = 0;
    await extensionContext.route(endpoint, async route => {
      heldRequests++;
      entered.resolve();
      await release.promise;
      try {
        await route.fulfill({ headers: { date: new Date().toUTCString() }, json: response });
      } finally {
        settled.resolve();
      }
    });
    const writes = server.writes.length;
    const identityRequests = auth.identityRequests;
    try {
      await connection.getByRole('button', { name: 'Connect GitHub', exact: true }).click();
      await entered.promise;
      await expect(progress.getByRole('button', { name: retryName })).toBeDisabled();
      await connection.getByRole('button', { name: stopButton, exact: true }).click();
      await expect(connection.getByRole('status')).toHaveText(stoppedStatus);
      release.resolve();
      await settled.promise;
      await expect(connection.getByRole('button', { name: 'Cancel authorization' })).toBeDisabled();
      await connection.reload();
      await expect(connection.getByRole('status')).toHaveText(stoppedStatus);
      expect(await credentialSummary(connection)).toEqual(noCredentials);
      const after = await expectOriginalJob(progress, original);
      expect(after.selection).toBeNull();
      expect(after.job).toEqual(original);
      await expect(progress.getByRole('button', { name: retryName })).toBeDisabled();
      expect(server.writes).toHaveLength(writes);
      expect(server.updates).toBe(0);
      expect(auth.identityRequests).toBe(identityRequests);
      expect(heldRequests).toBe(1);
    } finally {
      release.resolve();
    }
  });
}

test('a real browser restart retains pending work in the same profile but requires new authorization and destination verification', async ({
  extensionContext, progress, problem,
}, testInfo) => {
  const { server, target } = await setup(extensionContext, progress);
  server.loseBeforeAt = 'tree';
  const original = await captureUncertain(problem, progress);
  expect(original.candidate).toBeNull();
  expect((await credentialSummary(progress)).accessInSession).toBe(true);
  expect(server.updates).toBe(0);
  await extensionContext.close();

  const restarted = await launchExtensionProfile(testInfo.outputPath('extension'), testInfo.outputPath('profile'));
  try {
    const auth = await githubFixture(restarted);
    const destination = await destinationFixture(restarted);
    destination.exists = true;
    destination.marker = true;
    destination.markerContent = target.markerContent;
    const remote = await publicationFixture(restarted, destination);
    const requests = await observeApi(restarted);
    const worker = restarted.serviceWorkers()[0] ?? await restarted.waitForEvent('serviceworker');
    await worker.evaluate(() => { const now = Date.now(); Date.now = () => now; });
    const restored = await restarted.newPage();
    await restored.goto(`chrome-extension://${new URL(worker.url()).hostname}/options.html`);
    await expect(restored.getByRole('status')).toHaveText('1 captured attempt.');
    const retained = await expectOriginalJob(restored, original);
    expect(retained.job).toEqual(original);
    expect(retained.selection).toBeNull();
    expect(await credentialSummary(restored)).toEqual(noCredentials);
    await expect(restored.getByRole('button', { name: retryName })).toBeDisabled();
    const connection = await openConnection(restarted, restored);
    await expect(connection.getByRole('status')).toHaveText('Not connected to GitHub.');
    expect(auth.deviceRequests).toBe(0);
    expect(auth.identityRequests).toBe(0);
    expect(requests).toEqual([]);
    expect(remote.writes).toEqual([]);

    await connection.getByRole('button', { name: 'Connect GitHub', exact: true }).click();
    await expect(connection.getByRole('status')).toHaveText('Connected as fixture-user');
    expect(auth.deviceRequests).toBe(1);
    expect((await credentialSummary(restored)).accessInSession).toBe(true);
    await expect(restored.getByRole('button', { name: retryName })).toBeDisabled();
    const [page] = await Promise.all([
      restarted.waitForEvent('page'),
      connection.getByRole('link', { name: 'Set up progress repository' }).click(),
    ]);
    await expect(page.getByText('Saved setup:', { exact: false })).toContainText('fixture-user/progress-solutions');
    expect((await retainedDelivery(restored)).selection).toBeNull();
    await page.getByRole('button', { name: 'Verify pending or saved repository' }).click();
    await expect(page.getByRole('status')).toHaveText('Verified destination: fixture-user/progress-solutions @ learning');
    await expect(restored.getByRole('button', { name: retryName })).toBeEnabled();
    expect(remote.writes).toEqual([]);
    await restored.getByRole('button', { name: retryName }).click();
    await expect(restored.getByRole('region', { name: 'Captured attempts' }).getByText('Saved to GitHub', { exact: true }))
      .toBeVisible();
    const saved = await retainedDelivery(restored);
    expect(saved.job).toMatchObject({ id: original.id, target: original.target, snapshot: original.snapshot, state: 'saved' });
    expect(saved.selection?.connectionId).not.toBe(original.target.connectionId);
    expect(remote.updates).toBe(1);
    expect(remote.writes.filter(write => write.path.endsWith('/git/commits'))).toHaveLength(1);
    expect([...remote.files.values()]).toContain(submittedBytes);
    expect(destination.creations).toBe(0);
    expect(destination.initializations).toBe(0);
  } finally {
    await restarted.close();
  }
});
