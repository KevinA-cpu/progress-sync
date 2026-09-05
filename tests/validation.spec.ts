import type { Browser } from 'wxt/browser';
import { expect, stopExtensionWorker, submittedSource, test } from './fixtures';

declare const chrome: typeof Browser;

for (const scenario of [
  { name: 'unexpected fields', changes: { unexpected: 'not part of the stored schema' } },
  { name: 'a missing accepted-source hash', changes: { sourceHash: null } },
  { name: 'a non-string source', changes: { source: 123 } },
]) {
  test(`saved progress with ${scenario.name} is rejected rather than displayed as accepted`, async ({
    extensionContext, problem, progress,
  }) => {
    await problem.getByRole('textbox', { name: 'Solution' }).fill(submittedSource);
    await problem.getByRole('button', { name: 'Submit', exact: true }).click();
    await expect(progress.getByText('Accepted locally - not saved to GitHub', { exact: true }))
      .toBeVisible();

    await progress.evaluate(async changes => {
      const stored: unknown = (await chrome.storage.local.get('attempts-v1'))['attempts-v1'];
      if (!Array.isArray(stored) || stored.length !== 1) {
        throw new Error('Expected one captured attempt for the persisted-data fixture.');
      }
      await chrome.storage.local.set({
        'attempts-v1': [{ ...stored[0], ...changes }],
      });
    }, scenario.changes);
    await stopExtensionWorker(extensionContext, progress);
    await progress.reload();

    await expect(progress.getByRole('alert'))
      .toHaveText('Local progress is invalid or unsupported. It has not been overwritten.');
    await expect(progress.getByRole('textbox', { name: 'Submitted source' })).toHaveCount(0);
    await expect(progress.getByText('Accepted locally - not saved to GitHub', { exact: true }))
      .toHaveCount(0);
  });
}

test('valid schemas do not bypass the permitted runtime operation and sender', async ({
  progress,
}) => {
  const replies = await progress.evaluate(async () => ({
    valid: await chrome.runtime.sendMessage({ type: 'progress:list' }),
    extra: await chrome.runtime.sendMessage({ type: 'progress:list', unexpected: true }),
    forged: await chrome.runtime.sendMessage({
      type: 'hdlbits:result', problemId: 'step_one', verdict: 'success',
    }),
  }));

  expect(replies).toEqual({
    valid: { ok: true, attempts: [] },
    extra: { ok: false, error: 'Unsupported message or sender.' },
    forged: { ok: false, error: 'Unsupported message or sender.' },
  });
});

test('validation works without attempting scripts forbidden by the extension CSP', async ({
  progress,
}) => {
  await progress.addInitScript(() => {
    const blockedScripts: string[] = [];
    document.addEventListener('securitypolicyviolation', event => {
      blockedScripts.push(event.blockedURI);
    });
    Object.defineProperty(globalThis, 'blockedValidationScripts', { value: blockedScripts });
  });
  await progress.reload();
  await expect(progress.getByRole('status')).toContainText('No captured attempts yet.');

  expect(await progress.evaluate(() => Reflect.get(globalThis, 'blockedValidationScripts')))
    .toEqual([]);
});
