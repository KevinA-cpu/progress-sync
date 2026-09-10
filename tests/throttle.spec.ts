import type { Browser } from 'wxt/browser';
import {
  advanceDeliverySchedule, deliveryAlarm, expect, extensionWorker, stopExtensionWorker, submittedSource, test,
} from './fixtures';
import { CLIENT_ID } from './github-fixture';
import { setup } from './publication-setup';
import { deliveryView, observeApi, onlyJob, retryName, submit, throttledText } from './delivery-view';

declare const chrome: typeof Browser;

test.use({ githubClientId: CLIENT_ID });

const hour = 60 * 60 * 1000;
const cooldownText = 'GitHub asked this client to wait until';

const deadlines = [
  { form: 'a two-hour Retry-After', status: 429, wait: 2 * hour, headers: () => ({ 'retry-after': '7200' }) },
  {
    form: 'a Retry-After date', status: 429, wait: 90 * 60 * 1000,
    headers: (now: number) => ({ 'retry-after': new Date(now + 90 * 60 * 1000).toUTCString() }),
  },
  {
    form: 'a distant primary-limit reset', status: 403, wait: 3 * hour,
    headers: (now: number) => ({
      'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(Math.floor((now + 3 * hour) / 1000)),
    }),
  },
];

for (const deadline of deadlines) {
  test(`${deadline.form} is respected in full rather than shortened to the internal ceiling`, async ({
    extensionContext, progress, problem,
  }) => {
    const { server } = await setup(extensionContext, progress);
    server.failAt = 'ref';
    server.failStatus = deadline.status;
    server.failHeaders = deadline.headers(Date.now());
    const requested = Date.now() + deadline.wait;

    await submit(problem);
    await expect(progress.getByText(throttledText, { exact: false })).toBeVisible();

    const job = await onlyJob(progress);
    expect(job.retry).toMatchObject({ attempts: 0, failure: 'rate-limited' });
    const scheduled = job.retry?.nextAttemptAt;
    if (!scheduled) throw new Error('Expected a scheduled attempt after the stated deadline.');
    expect(Date.parse(scheduled)).toBeGreaterThanOrEqual(requested - 60_000);
    const alarm = await deliveryAlarm(extensionContext);
    expect(alarm ?? 0).toBeGreaterThanOrEqual(requested - 60_000);
    expect(server.updates).toBe(0);
  });
}

test('a stated deadline holds every job and explicit retry for the same GitHub authority', async ({
  extensionContext, progress, problem,
}) => {
  const { server } = await setup(extensionContext, progress);
  server.failAt = 'ref';
  server.failStatus = 429;
  server.failHeaders = { 'retry-after': '7200' };
  await submit(problem);
  await expect(progress.getByText(throttledText, { exact: false })).toBeVisible();
  const view = await deliveryView(progress);
  const [throttled] = view.jobs;
  const selection = view.selection;
  if (!throttled || !selection) throw new Error('Expected one throttled job and a live selection.');
  const writes = server.writes.length;
  server.failAt = null;
  server.failHeaders = null;

  const refused = await progress.evaluate(input => chrome.runtime.sendMessage(input), {
    type: 'delivery:retry', jobId: throttled.id,
    expectedConnectionId: selection.connectionId, expectedSelectionId: selection.operationId,
  });
  expect(refused).toMatchObject({ ok: false });
  expect(String(refused.error)).toContain(cooldownText);
  expect(server.writes).toHaveLength(writes);

  await submit(problem, `// Second attempt\n${submittedSource}`);
  await expect(progress.getByRole('status')).toHaveText('2 captured attempts.');
  await expect(progress.getByText(throttledText, { exact: false })).toHaveCount(2);
  expect(server.writes).toHaveLength(writes);
  for (const job of (await deliveryView(progress)).jobs) {
    expect(Date.parse(job.retry?.nextAttemptAt ?? '')).toBeGreaterThan(Date.now() + hour);
  }

  await advanceDeliverySchedule(extensionContext, hour);
  await progress.getByRole('button', { name: 'Refresh progress' }).click();
  expect(server.writes).toHaveLength(writes);
  for (const job of (await deliveryView(progress)).jobs) expect(job.retry?.attempts).toBe(0);

  await advanceDeliverySchedule(extensionContext, hour + 120_000);
  await expect(progress.getByText('Saved to GitHub', { exact: true })).toHaveCount(2);
  expect(server.updates).toBe(2);
});

test('a deadline beyond the supported window blocks and explains instead of retrying sooner', async ({
  extensionContext, progress, problem,
}) => {
  const { server } = await setup(extensionContext, progress);
  server.failAt = 'ref';
  server.failStatus = 429;
  server.failHeaders = { 'retry-after': '172800' };
  await submit(problem);

  await expect(progress.getByText('longer than automatic delivery supports', { exact: false })).toBeVisible();
  const blocked = await onlyJob(progress);
  expect(blocked.retry).toMatchObject({ attempts: 0, nextAttemptAt: null, failure: 'unsupported-delay' });
  expect(await deliveryAlarm(extensionContext)).toBeNull();
  const writes = server.writes.length;
  const requests = await observeApi(extensionContext);
  server.failAt = null;
  server.failHeaders = null;

  await advanceDeliverySchedule(extensionContext, 0);
  await progress.getByRole('button', { name: 'Refresh progress' }).click();
  expect(server.writes).toHaveLength(writes);
  await progress.getByRole('button', { name: retryName }).click();
  await expect(progress.getByRole('alert')).toContainText(cooldownText);
  expect(server.writes).toHaveLength(writes);
  expect(requests).toEqual([]);
  expect(server.updates).toBe(0);
});

test('a deadline that cannot be stored still stops the next job and retry from sending early', async ({
  extensionContext, progress, problem,
}) => {
  const { server } = await setup(extensionContext, progress);
  await extensionWorker(extensionContext).evaluate(() => {
    Reflect.set(globalThis, 'throttleWriteFailures', 0);
    const original = chrome.storage.local.set.bind(chrome.storage.local);
    chrome.storage.local.set = async items => {
      if (Object.hasOwn(items, 'delivery-throttle-v1')) {
        chrome.storage.local.set = original;
        const failures: unknown = Reflect.get(globalThis, 'throttleWriteFailures');
        Reflect.set(globalThis, 'throttleWriteFailures', (typeof failures === 'number' ? failures : 0) + 1);
        throw new Error('SYNTHETIC_THROTTLE_STORAGE_FAILURE');
      }
      return original(items);
    };
  });
  server.failAt = 'ref';
  server.failStatus = 429;
  server.failHeaders = { 'retry-after': '7200' };
  await submit(problem);

  await expect.poll(() => server.writes.filter(write => write.method === 'PATCH').length).toBe(1);
  expect(await extensionWorker(extensionContext)
    .evaluate(() => Reflect.get(globalThis, 'throttleWriteFailures'))).toBeGreaterThan(0);
  const writes = server.writes.length;
  const requests = await observeApi(extensionContext);
  server.failAt = null;
  server.failHeaders = null;

  await submit(problem, `// Second attempt\n${submittedSource}`);
  await expect(progress.getByRole('status')).toHaveText('2 captured attempts.');
  await expect(progress.getByText(throttledText, { exact: false })).toBeVisible();
  expect(server.writes).toHaveLength(writes);
  expect(server.updates).toBe(0);
  expect(requests.filter(request => request.method !== 'GET')).toEqual([]);
  await expect(progress.getByRole('textbox', { name: 'Submitted source (read-only)' }).last())
    .toHaveValue(submittedSource);

  const view = await deliveryView(progress);
  if (!view.selection) throw new Error('Expected a live selection.');
  for (const job of view.jobs) {
    const refused = await progress.evaluate(input => chrome.runtime.sendMessage(input), {
      type: 'delivery:retry', jobId: job.id,
      expectedConnectionId: view.selection.connectionId, expectedSelectionId: view.selection.operationId,
    });
    expect(String(refused.error)).toContain(cooldownText);
  }
  expect(server.writes).toHaveLength(writes);

  await expect.poll(async () => {
    const stored = await progress.evaluate(() => chrome.storage.local.get('delivery-throttle-v1'));
    const recorded = Object.values(stored['delivery-throttle-v1'] ?? {});
    return recorded.length === 1 && Date.parse(String(recorded[0])) > Date.now() + hour;
  }).toBe(true);
  expect(server.writes).toHaveLength(writes);
  expect(server.updates).toBe(0);

  await stopExtensionWorker(extensionContext, progress);
  await progress.reload();
  await advanceDeliverySchedule(extensionContext, 60_000);
  await expect(progress.getByText(throttledText, { exact: false })).toBeVisible();
  expect(server.writes).toHaveLength(writes);
  expect(server.updates).toBe(0);
});

test('an unreadable Retry-After is refused rather than treated as no delay', async ({
  extensionContext, progress, problem,
}) => {
  const { server } = await setup(extensionContext, progress);
  server.failAt = 'ref';
  server.failStatus = 429;
  server.failHeaders = { 'retry-after': 'soon' };
  await submit(problem);

  await expect(progress.getByText('did not state a usable time', { exact: false })).toBeVisible();
  const blocked = await onlyJob(progress);
  expect(blocked.retry).toMatchObject({ attempts: 0, nextAttemptAt: null, failure: 'unsupported-delay' });
  expect(await deliveryAlarm(extensionContext)).toBeNull();
  const writes = server.writes.length;

  await advanceDeliverySchedule(extensionContext, hour);
  await progress.getByRole('button', { name: 'Refresh progress' }).click();
  expect(server.writes).toHaveLength(writes);
  expect(server.updates).toBe(0);

  server.failAt = null;
  server.failHeaders = null;
  await progress.getByRole('button', { name: retryName }).click();
  await expect(progress.getByText('Saved to GitHub', { exact: true })).toBeVisible();
  expect(server.updates).toBe(1);
});
