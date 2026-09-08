import { createHash } from 'node:crypto';
import type { Page } from '@playwright/test';
import type { Browser } from 'wxt/browser';
import { expect, submittedSource, successPage, test } from './fixtures';
import { trackContentScript } from './content-script-fixture';
import { CLIENT_ID } from './github-fixture';
import { setup } from './publication-setup';

declare const chrome: typeof Browser;

test.use({ githubClientId: CLIENT_ID });

async function submit(page: Page, source: string): Promise<void> {
  await page.getByRole('textbox', { name: 'Solution' }).fill(source);
  await page.getByRole('button', { name: 'Submit', exact: true }).click();
}

for (const otherProblem of ['step_one', 'zero']) {
  test(`out-of-order tabs publish distinct exact attempts for ${otherProblem}`, async ({
    extensionContext, problem, progress,
  }) => {
    const { server } = await setup(extensionContext, progress);
    const grading = Promise.withResolvers<void>();
    const writing = Promise.withResolvers<void>();
    server.writeGate = writing.promise;
    let requests = 0;
    await extensionContext.route('**/runsim.php', async route => {
      const first = requests++ === 0;
      if (first) await grading.promise;
      await route.fulfill({
        contentType: 'text/html',
        body: first ? successPage : successPage.replaceAll('step_one', otherProblem),
      });
    });
    const second = await extensionContext.newPage();
    await second.goto(`https://hdlbits.01xz.net/wiki/${otherProblem === 'zero' ? 'Zero' : 'Step_one'}`);
    const sources = [`// First tab\n${submittedSource}`, `// Second tab\n${submittedSource}`];
    await submit(problem, sources[0]!);
    await expect(progress.getByText('Waiting for the result - not saved to GitHub', { exact: true })).toHaveCount(1);
    await submit(second, sources[1]!);
    await expect.poll(() => server.writes.length).toBe(1);
    await expect(progress.getByText('Accepted - awaiting GitHub delivery', { exact: true })).toHaveCount(1);
    await problem.getByRole('textbox', { name: 'Solution' }).fill('unsubmitted first edit');
    await second.getByRole('textbox', { name: 'Solution' }).fill('unsubmitted second edit');
    grading.resolve();
    await expect(progress.getByText('Accepted - awaiting GitHub delivery', { exact: true })).toHaveCount(2);
    expect(server.updates).toBe(0);
    writing.resolve();
    await expect(progress.getByText('Saved to GitHub', { exact: true })).toHaveCount(2);

    const ids: string[] = [];
    const receipts: string[] = [];
    for (const [index, source] of sources.entries()) {
      const article = progress.locator('#attempts article').nth(1 - index);
      const attemptId = await article.locator('dd').first().innerText();
      ids.push(attemptId);
      const problemId = index === 0 ? 'step_one' : otherProblem;
      const root = `progress/hdlbits/${problemId}/${attemptId}`;
      const bytes = source.replaceAll('\n', '\r\n');
      expect(server.files.get(`${root}/solution.v`)).toBe(bytes);
      expect(JSON.parse(server.files.get(`${root}/acceptance.json`)!)).toEqual({
        schemaVersion: 1, provider: 'hdlbits', problemId, attemptId,
        sourceHash: createHash('sha256').update(bytes).digest('hex'),
        submittedAt: expect.any(String), observedAt: expect.any(String),
        provenance: { capture: 'browser-post', verdict: 'success' },
      });
      await expect(article.getByRole('textbox', { name: 'Submitted source' })).toHaveValue(source);
      receipts.push(await article.getByRole('link', { name: /^Commit / }).innerText());
    }
    expect(new Set(ids).size).toBe(2);
    expect(new Set(receipts).size).toBe(2);
    expect([...server.files.keys()].filter(path => path.startsWith('progress/'))).toHaveLength(4);
    expect(server.files.get('README.md')).toBe('Keep this learner file.\n');
    expect(server.updates).toBe(2);
    expect(server.writes).toHaveLength(6);
    expect(server.requestsValid).toBe(true);
    const captured = await progress.evaluate(() => chrome.runtime.sendMessage({ type: 'progress:list' }));
    expect(captured).toMatchObject({ ok: true, attempts: ids.map((id, index) => ({
      id, source: sources[index]!.replaceAll('\n', '\r\n'), state: 'accepted',
      provenance: { requestId: expect.any(String), resultDocumentId: expect.any(String) },
    })) });
    expect(new Set(captured.attempts.map((attempt: { provenance: { tabId: number } }) => attempt.provenance.tabId)).size).toBe(2);
    expect(new Set(captured.attempts.map((attempt: { provenance: { resultDocumentId: string } }) =>
      attempt.provenance.resultDocumentId)).size).toBe(2);

    await extensionContext.route('**/runsim.php', route => route.fulfill({
      contentType: 'text/html', body: successPage.replace('Status: Success!', 'Status: Incorrect'),
    }));
    await submit(problem, `// Failed reattempt\n${submittedSource.replace("1'b1", "1'b0")}`);
    await expect(progress.getByText('HDLBits did not accept this submission.', { exact: false })).toHaveCount(1);
    await expect(progress.getByText('Saved to GitHub', { exact: true })).toHaveCount(2);
    expect(server.writes).toHaveLength(6);
  });
}

test('same-frame overlap stays unverified without blocking another tab and reload permits a fresh attempt', async ({
  extensionContext, problem, progress,
}) => {
  const { server } = await setup(extensionContext, progress);
  const oldResult = Promise.withResolvers<void>();
  const replacementResult = Promise.withResolvers<void>();
  const healthyResult = Promise.withResolvers<void>();
  const sources = {
    old: `// Old overlapping attempt\n${submittedSource}`,
    replacement: `// Replacement attempt\n${submittedSource}`,
    healthy: `// Independent tab\n${submittedSource}`,
  };
  await extensionContext.route('**/runsim.php', async route => {
    const body = route.request().postData() ?? '';
    if (body.includes('// Old overlapping attempt')) await oldResult.promise;
    if (body.includes('// Replacement attempt')) await replacementResult.promise;
    if (body.includes('// Independent tab')) await healthyResult.promise;
    await route.fulfill({ contentType: 'text/html', body: successPage });
  });
  const second = await extensionContext.newPage();
  await second.goto('https://hdlbits.01xz.net/wiki/Step_one');
  await submit(problem, sources.old);
  await expect(progress.getByRole('status')).toHaveText('1 captured attempt.');
  await submit(second, sources.healthy);
  await expect(progress.getByText('Waiting for the result - not saved to GitHub', { exact: true })).toHaveCount(2);
  await submit(problem, sources.replacement);
  await expect(progress.getByText('Unverified:', { exact: false })).toHaveCount(2);
  oldResult.resolve();
  replacementResult.resolve();
  await expect(problem.frameLocator('#compile_iframe').getByRole('heading', { name: 'Status: Success!', exact: true })).toBeVisible();
  await progress.getByRole('button', { name: 'Refresh progress' }).click();
  expect(server.writes).toEqual([]);
  healthyResult.resolve();
  await expect(progress.getByText('Saved to GitHub', { exact: true })).toHaveCount(1);
  expect([...server.files].filter(([path]) => path.endsWith('/solution.v')).map(([, source]) => source))
    .toEqual([sources.healthy.replaceAll('\n', '\r\n')]);
  await problem.reload();
  await submit(problem, submittedSource);
  await expect(progress.getByText('Saved to GitHub', { exact: true })).toHaveCount(2);
  await expect(progress.getByText('Unverified:', { exact: false })).toHaveCount(2);
  expect(server.updates).toBe(2);
});

for (const priorVerdict of ['Success!', 'Incorrect']) {
  test(`repeated ${priorVerdict} documents and malformed messages cannot authorize or poison a newer attempt`, async ({
    extensionContext, problem, progress,
  }) => {
    const { server } = await setup(extensionContext, progress);
    const observer = await trackContentScript(extensionContext, problem);
    const grading = Promise.withResolvers<void>();
    let requests = 0;
    await extensionContext.route('**/runsim.php', async route => {
      const first = requests++ === 0;
      if (!first) await grading.promise;
      await route.fulfill({
        contentType: 'text/html', body: first ? successPage.replace('Status: Success!', `Status: ${priorVerdict}`) : successPage,
      });
    });
    await submit(problem, submittedSource);
    const priorAccepted = priorVerdict === 'Success!';
    await expect(progress.getByText(priorAccepted ? 'Saved to GitHub' : 'Unverified: HDLBits did not accept this submission.',
      { exact: true })).toBeVisible();
    const writes = server.writes.length;
    await submit(problem, `// New attempt\n${submittedSource}`);
    await expect(progress.getByText('Waiting for the result - not saved to GitHub', { exact: true })).toHaveCount(1);
    const replies = await observer.evaluate(`(async () => {
      const result = { type: 'hdlbits:result', problemId: 'step_one', verdict: 'success' };
      return {
        repeated: await Promise.all([1, 2].map(() => chrome.runtime.sendMessage(result))),
        malformed: await Promise.all([
          { ...result, source: 'forged', owner: 'attacker' },
          { ...result, problemId: '../outside' },
          { ...result, problemId: 'x'.repeat(129) },
          { ...result, verdict: 'accepted' }
        ].map(value => chrome.runtime.sendMessage(value))),
        destination: await chrome.runtime.sendMessage({ type: 'destination:create', owner: 'attacker' }),
        publish: await chrome.runtime.sendMessage({ type: 'delivery:publish', source: 'forged' }),
        store: await chrome.runtime.sendMessage({ type: 'progress:list' })
      };
    })()`);
    expect(replies).toEqual({
      repeated: Array(2).fill({ ok: false, error: 'No matching observed submission. This result is unverified.' }),
      malformed: Array(4).fill({ ok: false, error: 'Unsupported message or sender.' }),
      destination: { ok: false, error: 'invalid-input' },
      publish: { ok: false, error: 'Unsupported delivery operation or sender.' },
      store: { ok: false, error: 'Unsupported message or sender.' },
    });
    await progress.getByRole('button', { name: 'Refresh progress' }).click();
    await expect(progress.getByText('Waiting for the result - not saved to GitHub', { exact: true })).toHaveCount(1);
    expect(server.writes).toHaveLength(writes);
    grading.resolve();
    await expect(progress.getByText('Saved to GitHub', { exact: true })).toHaveCount(priorAccepted ? 2 : 1);
    expect(server.updates).toBe(priorAccepted ? 2 : 1);
    await observer.close();
  });
}

for (const interruption of ['navigation', 'timeout', 'unsupported result']) {
  test(`${interruption} in one tab cannot publish its source or interfere with a healthy tab`, async ({
    extensionContext, problem, progress,
  }) => {
    const { server } = await setup(extensionContext, progress);
    const grading = Promise.withResolvers<void>();
    let requests = 0;
    await extensionContext.route('**/runsim.php', async route => {
      const first = requests++ === 0;
      if (first) await grading.promise;
      await route.fulfill({
        contentType: 'text/html',
        body: first && interruption === 'unsupported result'
          ? successPage.replace('</body>', '<h2>Status: Incorrect</h2></body>') : successPage,
      });
    });
    await submit(problem, `// Unverifiable attempt\n${submittedSource}`);
    await expect(progress.getByText('Waiting for the result - not saved to GitHub', { exact: true })).toHaveCount(1);
    if (interruption === 'navigation') {
      await problem.goto('https://hdlbits.01xz.net/wiki/Zero');
    } else if (interruption === 'timeout') {
      const worker = extensionContext.serviceWorkers()[0];
      if (!worker) throw new Error('Missing extension worker.');
      const now = Date.now();
      await worker.evaluate(now => { Date.now = () => now; }, now + 180_000);
      await progress.getByRole('button', { name: 'Refresh progress' }).click();
      await expect(progress.getByText('Result timed out.', { exact: false })).toBeVisible();
      await worker.evaluate(() => { Date.now = () => new Date().getTime(); });
    }
    const second = await extensionContext.newPage();
    await second.goto('https://hdlbits.01xz.net/wiki/Step_one');
    await submit(second, submittedSource);
    await expect(progress.getByText('Saved to GitHub', { exact: true })).toHaveCount(1);
    grading.resolve();
    if (interruption !== 'navigation') {
      await expect(problem.frameLocator('#compile_iframe').getByRole('heading', { name: 'Status: Success!', exact: true })).toBeVisible();
    }
    await expect(progress.getByText('Unverified:', { exact: false })).toHaveCount(1);
    await progress.getByRole('button', { name: 'Refresh progress' }).click();
    expect(server.updates).toBe(1);
    expect([...server.files].filter(([path]) => path.endsWith('/solution.v')).map(([, source]) => source))
      .toEqual([submittedSource.replaceAll('\n', '\r\n')]);
  });
}
