import type { Browser } from 'wxt/browser';
import {
  advanceDeliverySchedule, deliveryAlarm, expect, extensionWorker, launchExtensionProfile, stopExtensionWorker,
  submittedBytes, submittedSource, test,
} from './fixtures';
import { CLIENT_ID, credentialSummary, githubFixture, openConnection } from './github-fixture';
import { destinationFixture } from './destination-fixture';
import { publicationFixture } from './publication-fixture';
import { setup } from './publication-setup';
import {
  deliveryView, exhaustedText, observeApi, onlyJob, queuedText, retryName, schedulerFailureText,
  storedJobs, submit, throttledText, unscheduledText,
} from './delivery-view';

declare const chrome: typeof Browser;

test.use({ githubClientId: CLIENT_ID });

const scheduleDelays = [60_000, 240_000, 960_000, 3_840_000, 7_200_000];
const pastEveryDelay = scheduleDelays.reduce((total, delay) => total + delay, 5000);

test('a queued upload interrupted by an outage reaches saved automatically once GitHub is reachable', async ({
  extensionContext, progress, problem,
}) => {
  const { server } = await setup(extensionContext, progress);
  let offline = true;
  await extensionContext.route('https://api.github.com/**', async route => {
    if (offline) return route.abort('internetdisconnected');
    await route.fallback();
  });

  await submit(problem);
  await expect(progress.getByText('GitHub could not be reached.', { exact: false })).toBeVisible();
  await expect(progress.getByText(queuedText, { exact: false })).toBeVisible();
  const queued = await onlyJob(progress);
  expect(queued).toMatchObject({ state: 'blocked', receipt: null, retry: { attempts: 0, failure: 'transient' } });
  expect(queued.snapshot.source).toBe(submittedBytes);
  expect(server.writes).toEqual([]);
  const scheduled = await deliveryAlarm(extensionContext);
  const requested = queued.retry?.nextAttemptAt;
  if (!scheduled || !requested) throw new Error('Expected a durable wakeup for the queued job.');
  expect(Math.abs(scheduled - Date.parse(requested))).toBeLessThan(1000);
  expect(Date.parse(requested) - Date.now()).toBeGreaterThan(30_000);

  offline = false;
  await advanceDeliverySchedule(extensionContext, 61_000);

  await expect(progress.getByText('Saved to GitHub', { exact: true })).toBeVisible();
  await expect(progress.getByText(queuedText, { exact: false })).toHaveCount(0);
  const saved = await onlyJob(progress);
  expect(saved).toMatchObject({ state: 'saved', retry: null });
  expect(server.updates).toBe(1);
  expect(server.writes.filter(write => write.path.endsWith('/git/commits'))).toHaveLength(1);
  expect([...server.files.values()]).toContain(submittedBytes);
  expect(await deliveryAlarm(extensionContext)).toBeNull();
});

test('worker termination preserves the snapshot and re-arms the schedule in the recreated worker', async ({
  extensionContext, progress, problem,
}) => {
  const { server } = await setup(extensionContext, progress);
  const gate = Promise.withResolvers<void>();
  server.writeGate = gate.promise;
  try {
    await submit(problem);
    await expect.poll(() => server.writes.length).toBe(1);
    await stopExtensionWorker(extensionContext, progress);
    await progress.reload();

    await expect(progress.getByText('Publication was interrupted.', { exact: false })).toBeVisible();
    await expect(progress.getByText(queuedText, { exact: false })).toBeVisible();
    const adopted = await onlyJob(progress);
    expect(adopted).toMatchObject({ state: 'uncertain', receipt: null, retry: { attempts: 0, failure: 'transient' } });
    expect(adopted.snapshot.source).toBe(submittedBytes);
    expect(await deliveryAlarm(extensionContext)).not.toBeNull();
    gate.resolve();
    server.writeGate = null;

    await advanceDeliverySchedule(extensionContext, 61_000);

    await expect(progress.getByText('Saved to GitHub', { exact: true })).toBeVisible();
    expect((await onlyJob(progress)).id).toBe(adopted.id);
    expect(server.updates).toBe(1);
    expect([...server.files.keys()].filter(path => path.startsWith('progress/'))).toHaveLength(2);
    expect([...server.files.values()]).toContain(submittedBytes);
  } finally {
    gate.resolve();
  }
});

test('a real browser restart keeps queued work waiting for reauthorization, then resumes it without a manual retry', async ({
  extensionContext, progress, problem,
}, testInfo) => {
  const { server, target } = await setup(extensionContext, progress);
  server.loseBeforeAt = 'tree';
  await submit(problem);
  await expect(progress.getByText(queuedText, { exact: false })).toBeVisible();
  const original = await onlyJob(progress);
  expect(original.retry).toMatchObject({ attempts: 0, failure: 'transient' });
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
    const restored = await restarted.newPage();
    await restored.goto(`chrome-extension://${new URL(worker.url()).hostname}/options.html`);
    await expect(restored.getByRole('status')).toHaveText('1 captured attempt.');
    expect(await credentialSummary(restored)).toEqual({
      accessInSession: false, refreshInSession: false, deviceInSession: false, leakedOutsideSession: false,
    });

    await advanceDeliverySchedule(restarted, pastEveryDelay);
    await expect(restored.getByRole('button', { name: retryName })).toBeDisabled();
    const waiting = await onlyJob(restored);
    expect(waiting).toMatchObject({ id: original.id, state: original.state, retry: original.retry });
    expect(requests).toEqual([]);
    expect(remote.writes).toEqual([]);
    expect(await credentialSummary(restored)).toMatchObject({ accessInSession: false });

    const connection = await openConnection(restarted, restored);
    await connection.getByRole('button', { name: 'Connect GitHub', exact: true }).click();
    await expect(connection.getByRole('status')).toHaveText('Connected as fixture-user');
    expect(remote.writes).toEqual([]);
    const [page] = await Promise.all([
      restarted.waitForEvent('page'),
      connection.getByRole('link', { name: 'Set up progress repository' }).click(),
    ]);
    await page.getByRole('button', { name: 'Verify pending or saved repository' }).click();
    await expect(page.getByRole('status')).toHaveText('Verified destination: fixture-user/progress-solutions @ learning');

    await expect(restored.getByRole('region', { name: 'Captured attempts' }).getByText('Saved to GitHub', { exact: true }))
      .toBeVisible();
    const saved = await onlyJob(restored);
    expect(saved).toMatchObject({ id: original.id, state: 'saved', retry: null });
    expect(saved.target).toEqual(original.target);
    expect(remote.updates).toBe(1);
    expect(remote.writes.filter(write => write.path.endsWith('/git/commits'))).toHaveLength(1);
    expect([...remote.files.values()]).toContain(submittedBytes);
    expect(destination.creations).toBe(0);
    expect(auth.deviceRequests).toBe(1);
  } finally {
    await restarted.close();
  }
});

test('duplicate and overlapping wakeups share one serialized publication', async ({
  extensionContext, progress, problem,
}) => {
  const { server, page } = await setup(extensionContext, progress);
  server.loseBeforeAt = 'ref';
  await submit(problem);
  await expect(progress.getByText('Publication outcome is uncertain.', { exact: false })).toBeVisible();
  const uncertain = await onlyJob(progress);
  expect(uncertain.retry).toMatchObject({ attempts: 0, failure: 'transient' });
  const references = server.writes.filter(write => write.method === 'PATCH').length;
  expect(references).toBe(1);
  server.loseBeforeAt = null;
  const gate = Promise.withResolvers<void>();
  server.refGate = gate.promise;
  try {
    await advanceDeliverySchedule(extensionContext, 61_000);
    await expect.poll(() => server.writes.filter(write => write.method === 'PATCH').length).toBe(references + 1);

    await advanceDeliverySchedule(extensionContext, 1000);
    await advanceDeliverySchedule(extensionContext, 1000);
    await page.getByRole('button', { name: 'Verify pending or saved repository' }).click();
    await expect(page.getByRole('status')).toContainText('Verified destination:');
    gate.resolve();

    await expect(progress.getByText('Saved to GitHub', { exact: true })).toBeVisible();
    await expect(progress.getByRole('region', { name: 'Captured attempts' }).locator('article')).toHaveCount(1);
    expect((await onlyJob(progress)).receipt?.commitSha).toBe(server.head);
    expect(server.updates).toBe(1);
    expect(server.refCompletions).toBe(1);
    expect(server.writes.filter(write => write.path.endsWith('/git/commits'))).toHaveLength(1);
    expect([...server.files.keys()].filter(path => path.startsWith('progress/'))).toHaveLength(2);
  } finally {
    gate.resolve();
  }
});

test('an explicit rate-limit delay is respected before the job resumes, without pausing the destination', async ({
  extensionContext, progress, problem,
}) => {
  const { server } = await setup(extensionContext, progress);
  server.failAt = 'ref';
  server.failStatus = 403;
  server.failHeaders = { 'retry-after': '120' };
  await submit(problem);
  await expect(progress.getByText('Delivery blocked: GitHub rejected publication.', { exact: false })).toBeVisible();
  await expect(progress.getByText(throttledText, { exact: false })).toBeVisible();
  const throttled = await onlyJob(progress);
  expect(throttled.retry).toMatchObject({ attempts: 0, failure: 'rate-limited' });
  const requested = throttled.retry?.nextAttemptAt;
  if (!requested) throw new Error('Expected a scheduled attempt after the rate limit.');
  expect(Date.parse(requested) - Date.now()).toBeGreaterThan(110_000);
  await expect(progress.getByRole('button', { name: retryName })).toBeEnabled();
  const writes = server.writes.length;
  expect(server.updates).toBe(0);

  await advanceDeliverySchedule(extensionContext, 61_000);
  await expect(progress.getByText(throttledText, { exact: false })).toBeVisible();
  expect(server.writes).toHaveLength(writes);
  expect((await onlyJob(progress)).retry).toMatchObject({ attempts: 0, nextAttemptAt: requested });

  server.failAt = null;
  server.failHeaders = null;
  await advanceDeliverySchedule(extensionContext, 61_000);

  await expect(progress.getByText('Saved to GitHub', { exact: true })).toBeVisible();
  expect(server.updates).toBe(1);
  expect(server.writes.filter(write => write.path.endsWith('/git/commits'))).toHaveLength(1);
});

test('a repeatedly failing transfer stops at the bounded budget and stays manually actionable', async ({
  extensionContext, progress, problem,
}) => {
  test.slow();
  const { server } = await setup(extensionContext, progress);
  server.loseBeforeAt = 'ref';
  await submit(problem);
  await expect(progress.getByText('Publication outcome is uncertain.', { exact: false })).toBeVisible();
  expect((await onlyJob(progress)).retry).toMatchObject({ attempts: 0, failure: 'transient' });

  for (const [index, delay] of scheduleDelays.entries()) {
    const attempt = index + 1;
    await advanceDeliverySchedule(extensionContext, delay + 5000);
    await expect.poll(async () => {
      const job = await onlyJob(progress);
      const running = job.state === 'publishing' || job.state === 'reconciling';
      return running || !job.retry ? 'in flight' : `${job.retry.attempts} ${job.retry.nextAttemptAt === null}`;
    }).toBe(`${attempt} ${attempt === scheduleDelays.length}`);
  }
  await expect(progress.getByText(exhaustedText, { exact: false })).toBeVisible();
  const exhausted = await onlyJob(progress);
  expect(exhausted.retry).toMatchObject({ attempts: 5, nextAttemptAt: null, failure: 'transient' });
  expect(exhausted.state).toBe('uncertain');
  expect(await deliveryAlarm(extensionContext)).toBeNull();
  const writes = server.writes.length;

  await advanceDeliverySchedule(extensionContext, pastEveryDelay);
  await progress.getByRole('button', { name: 'Refresh progress' }).click();
  await expect(progress.getByText(exhaustedText, { exact: false })).toBeVisible();
  expect(server.writes).toHaveLength(writes);
  expect(server.updates).toBe(0);

  server.loseBeforeAt = null;
  await progress.getByRole('button', { name: retryName }).click();
  await expect(progress.getByText('Saved to GitHub', { exact: true })).toBeVisible();
  expect(server.updates).toBe(1);
  expect([...server.files.keys()].filter(path => path.startsWith('progress/'))).toHaveLength(2);
});

for (const rejection of ['branch policy', 'revoked authorization'] as const) {
  test(`a ${rejection} rejection is retained without any scheduled attempt`, async ({
    extensionContext, progress, problem,
  }) => {
    const { server } = await setup(extensionContext, progress);
    server.failAt = 'ref';
    server.failStatus = rejection === 'branch policy' ? 422 : 401;
    await submit(problem);
    await expect(progress.getByText('Delivery blocked: GitHub rejected publication.', { exact: false })).toBeVisible();
    const blocked = await onlyJob(progress);
    expect(blocked.retry).toMatchObject({
      attempts: 0, nextAttemptAt: null,
      failure: rejection === 'branch policy' ? 'permanent' : 'authorization',
    });
    await expect(progress.getByText(queuedText, { exact: false })).toHaveCount(0);
    await expect(progress.getByText(exhaustedText, { exact: false })).toHaveCount(0);
    expect(await deliveryAlarm(extensionContext)).toBeNull();
    if (rejection === 'revoked authorization') {
      expect((await credentialSummary(progress)).accessInSession).toBe(false);
    }
    const writes = server.writes.length;
    const requests = await observeApi(extensionContext);

    await advanceDeliverySchedule(extensionContext, pastEveryDelay);
    await progress.getByRole('button', { name: 'Refresh progress' }).click();

    expect(server.writes).toHaveLength(writes);
    expect(requests).toEqual([]);
    expect(server.updates).toBe(0);
    expect((await onlyJob(progress)).retry).toEqual(blocked.retry);
    await expect(progress.getByRole('button', { name: retryName }))
      .toBeEnabled({ enabled: rejection === 'branch policy' });
  });
}

test('an attempt reserved but never sent is recovered after the worker dies, keeping its spent budget', async ({
  extensionContext, progress, problem,
}) => {
  const { server } = await setup(extensionContext, progress);
  server.loseBeforeAt = 'ref';
  await submit(problem);
  await expect(progress.getByText('Publication outcome is uncertain.', { exact: false })).toBeVisible();
  expect((await onlyJob(progress)).retry).toMatchObject({ attempts: 0, failure: 'transient' });
  const writes = server.writes.length;

  await extensionWorker(extensionContext).evaluate(() => {
    const original = chrome.storage.local.set.bind(chrome.storage.local);
    let reserved = false;
    chrome.storage.local.set = async items => {
      const jobs: unknown = Reflect.get(items, 'delivery-jobs-v1');
      const reserving = Array.isArray(jobs) && jobs.some(job => job.retry?.reservedAt != null);
      if (reserved && Array.isArray(jobs)) await new Promise(() => undefined);
      reserved ||= reserving;
      return original(items);
    };
  });
  await advanceDeliverySchedule(extensionContext, 61_000);
  await expect.poll(async () => (await storedJobs(progress))[0]?.retry?.reservedAt != null).toBe(true);
  const reservation = (await storedJobs(progress))[0];
  expect(reservation).toMatchObject({ state: 'uncertain', retry: { attempts: 1, nextAttemptAt: null } });
  expect(server.writes).toHaveLength(writes);

  await stopExtensionWorker(extensionContext, progress);
  await progress.reload();

  await expect.poll(async () => (await onlyJob(progress)).retry?.nextAttemptAt !== null).toBe(true);
  const adopted = await onlyJob(progress);
  expect(adopted).toMatchObject({ state: 'uncertain', retry: { attempts: 1, failure: 'transient' } });
  expect(adopted.retry?.reservedAt ?? null).toBeNull();
  expect(Date.parse(adopted.retry?.nextAttemptAt ?? '') - Date.now()).toBeGreaterThan(120_000);
  expect(await deliveryAlarm(extensionContext)).not.toBeNull();
  await expect(progress.getByText(queuedText, { exact: false })).toBeVisible();

  server.loseBeforeAt = null;
  await advanceDeliverySchedule(extensionContext, scheduleDelays[1] ?? 0);
  await expect(progress.getByText('Saved to GitHub', { exact: true })).toBeVisible();
  expect(server.updates).toBe(1);
  expect([...server.files.values()]).toContain(submittedBytes);
});

test('writing one job never erases the mid-publication evidence another one needs', async ({
  extensionContext, progress, problem,
}) => {
  const { server, page } = await setup(extensionContext, progress);
  server.loseBeforeAt = 'ref';
  await submit(problem);
  await expect(progress.getByText('Publication outcome is uncertain.', { exact: false })).toBeVisible();
  await submit(problem, `// Second snapshot\n${submittedSource}`);
  await expect(progress.getByText('Publication outcome is uncertain.', { exact: false })).toHaveCount(2);
  const [interrupted, other] = await storedJobs(progress);
  if (!interrupted || !other) throw new Error('Expected two stored delivery jobs.');

  await progress.evaluate(async id => {
    const stored = (await chrome.storage.local.get('delivery-jobs-v1'))['delivery-jobs-v1'];
    if (!Array.isArray(stored)) throw new Error('Expected stored delivery jobs.');
    await chrome.storage.local.set({
      'delivery-jobs-v1': stored.map(job => job.id === id
        ? { ...job, state: 'publishing', detail: null, receipt: null, retry: null } : job),
    });
  }, interrupted.id);

  const selection = (await deliveryView(progress)).selection;
  if (!selection) throw new Error('Expected a live selection.');
  await progress.evaluate(input => chrome.runtime.sendMessage(input), {
    type: 'delivery:retry', jobId: other.id,
    expectedConnectionId: selection.connectionId, expectedSelectionId: selection.operationId,
  });

  await expect.poll(async () => {
    const stored = (await storedJobs(progress)).find(job => job.id === interrupted.id);
    return stored?.retry?.nextAttemptAt != null;
  }).toBe(true);
  const adopted = (await storedJobs(progress)).find(job => job.id === interrupted.id);
  expect(adopted).toMatchObject({ state: 'uncertain', retry: { attempts: 0, failure: 'transient' } });
  await expect(progress.getByText(queuedText, { exact: false })).toHaveCount(2);

  server.loseBeforeAt = null;
  await advanceDeliverySchedule(extensionContext, 61_000);
  await expect(progress.getByText('Saved to GitHub', { exact: true })).toHaveCount(2);
  expect(server.updates).toBe(2);
  await expect(page.getByRole('status')).toContainText('Verified destination:');
});

test('a scheduler that cannot register a wakeup says so instead of promising automatic delivery', async ({
  extensionContext, progress, problem,
}) => {
  const { server } = await setup(extensionContext, progress);
  await extensionWorker(extensionContext).evaluate(() => {
    Reflect.set(globalThis, 'alarmFailures', 0);
    const original = chrome.alarms.create.bind(chrome.alarms);
    const failing = async (name: string, info: Browser.alarms.AlarmCreateInfo): Promise<void> => {
      if (name !== 'delivery-retry-v1') return original(name, info);
      const failures: unknown = Reflect.get(globalThis, 'alarmFailures');
      Reflect.set(globalThis, 'alarmFailures', (typeof failures === 'number' ? failures : 0) + 1);
      throw new Error('SYNTHETIC_ALARM_FAILURE');
    };
    Reflect.set(chrome.alarms, 'create', failing);
  });
  server.loseBeforeAt = 'ref';
  await submit(problem);

  await expect(progress.getByText('Publication outcome is uncertain.', { exact: false })).toBeVisible();
  await expect(progress.getByText(schedulerFailureText, { exact: false })).toBeVisible();
  await expect(progress.getByText(unscheduledText, { exact: false })).toBeVisible();
  await expect(progress.getByText(queuedText, { exact: false })).toHaveCount(0);
  const queued = await onlyJob(progress);
  expect(queued.retry).toMatchObject({ attempts: 0, failure: 'transient' });
  expect(queued.retry?.nextAttemptAt).not.toBeNull();
  expect(await deliveryAlarm(extensionContext)).toBeNull();
  expect(await extensionWorker(extensionContext).evaluate(() => Reflect.get(globalThis, 'alarmFailures')))
    .toBeGreaterThan(0);
  await progress.reload();
  await expect(progress.getByText(schedulerFailureText, { exact: false })).toBeVisible();

  await stopExtensionWorker(extensionContext, progress);
  await progress.reload();
  await expect(progress.getByText(schedulerFailureText, { exact: false })).toHaveCount(0);
  await expect(progress.getByText(queuedText, { exact: false })).toBeVisible();
  expect(await deliveryAlarm(extensionContext)).not.toBeNull();
  expect((await onlyJob(progress)).retry).toMatchObject({ attempts: 0, failure: 'transient' });

  server.loseBeforeAt = null;
  await advanceDeliverySchedule(extensionContext, 61_000);
  await expect(progress.getByText('Saved to GitHub', { exact: true })).toBeVisible();
  expect(server.updates).toBe(1);
});

test('a scheduling write failure is reported and spends no attempt', async ({
  extensionContext, progress, problem,
}) => {
  const { server } = await setup(extensionContext, progress);
  server.loseBeforeAt = 'ref';
  await submit(problem);
  await expect(progress.getByText('Publication outcome is uncertain.', { exact: false })).toBeVisible();
  const queued = await onlyJob(progress);
  const writes = server.writes.length;

  await extensionWorker(extensionContext).evaluate(() => {
    const original = chrome.storage.local.set.bind(chrome.storage.local);
    chrome.storage.local.set = async items => {
      const jobs: unknown = Reflect.get(items, 'delivery-jobs-v1');
      if (Array.isArray(jobs) && jobs.some(job => job.retry?.reservedAt != null)) {
        chrome.storage.local.set = original;
        throw new Error('SYNTHETIC_SCHEDULE_STORAGE_FAILURE');
      }
      return original(items);
    };
  });
  await advanceDeliverySchedule(extensionContext, 61_000);

  await expect(progress.getByText(schedulerFailureText, { exact: false })).toBeVisible();
  expect(server.writes).toHaveLength(writes);
  const retained = await onlyJob(progress);
  expect(retained.retry).toMatchObject({ attempts: 0, nextAttemptAt: queued.retry?.nextAttemptAt });
  expect(retained.snapshot.source).toBe(submittedBytes);
  await expect(progress.getByText('SYNTHETIC_SCHEDULE_STORAGE_FAILURE', { exact: false })).toHaveCount(0);

  server.loseBeforeAt = null;
  await advanceDeliverySchedule(extensionContext, 61_000);
  await expect(progress.getByText('Saved to GitHub', { exact: true })).toBeVisible();
  await expect(progress.getByText(schedulerFailureText, { exact: false })).toHaveCount(0);
  expect(server.updates).toBe(1);
  expect((await deliveryView(progress)).scheduling).toBeNull();
});
