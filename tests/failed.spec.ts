import { createHash } from 'node:crypto';
import type { Page } from '@playwright/test';
import type { Browser } from 'wxt/browser';
import type { BrowserContext } from '@playwright/test';
import { expect, submittedBytes, submittedSource, successPage, test } from './fixtures';
import { CLIENT_ID, githubFixture, openConnection } from './github-fixture';
import { destinationFixture } from './destination-fixture';
import { recoveryFixture } from './recovery-fixture';
import { setup } from './publication-setup';
import { trackContentScript } from './content-script-fixture';

declare const chrome: typeof Browser;

test.use({ githubClientId: CLIENT_ID });

const FAILED_OFF = 'Failed attempts stay local.'
  + ' Nothing failed is published unless you publish that attempt explicitly.';
const FAILED_ON = 'Failed attempts captured from now on are published automatically to this public repository,'
  + ' with their source and submission report.';
const PUBLISH_FAILED = /^Publish failed attempt and its report to /;
const incorrectPage = successPage.replace('Status: Success!', 'Status: Incorrect');
// A result page as a provider may well render it: the verdict beside lesson prose, a reference table, a model
// answer and a bitmap. None of that is this submission's own verdict, messages, or drawn chart.
const explainedPage = `<!doctype html>
<html><head><title>step_one: Simulation - HDLBits</title></head>
<body><h2>step_one &mdash; Compile and simulate</h2><h2>Status: Incorrect</h2>
<p>Teaching note: a continuous assignment drives the output whenever its right side changes.</p>
<table><tr><th>Time</th><th>Reference output</th><th>Your output</th></tr>
<tr><td>5</td><td>1</td><td>0</td></tr></table>
<pre>Model answer: assign one = 1'b1;</pre>
<img alt="Timing diagram" src="/waveform.png">
</body></html>`;
const PROVIDER_ONLY_TEXT = [
  'Teaching note', 'Reference output', 'Model answer', 'waveform.png',
];

async function failResults(page: Page, body = incorrectPage): Promise<void> {
  await page.context().route('**/runsim.php', route => route.fulfill({ contentType: 'text/html', body }));
}

async function submit(page: Page, source: string): Promise<void> {
  await page.getByRole('textbox', { name: 'Solution' }).fill(source);
  await page.getByRole('button', { name: 'Submit', exact: true }).click();
}

async function setFailedPublication(page: Page, enabled: boolean): Promise<void> {
  const toggle = page.getByLabel('Publish new failed attempts and their reports automatically');
  await toggle.setChecked(enabled);
  if (enabled) {
    await page.getByLabel('I understand failed attempts and reports will be publicly readable').check();
  }
  await page.getByRole('button', { name: 'Save failed-attempt choice', exact: true }).click();
  await expect(page.locator('#failed-state')).toContainText(enabled ? FAILED_ON : FAILED_OFF);
}

function failedRoot(files: Map<string, string>): string {
  const source = [...files.keys()].find(path => path.includes('/failed-') && path.endsWith('/solution.v'));
  if (!source) throw new Error('Expected a published failed record.');
  return source.slice(0, -'/solution.v'.length);
}

interface StoredAttempt {
  id: string;
  state: string;
  outcome?: string;
  report?: { status: string; messages: unknown[]; coverage: Record<string, unknown> };
}

async function storedAttempts(progress: Page): Promise<StoredAttempt[]> {
  return progress.evaluate(async () => {
    const reply = await chrome.runtime.sendMessage({ type: 'progress:list' }) as { attempts: StoredAttempt[] };
    return reply.attempts;
  }) as Promise<StoredAttempt[]>;
}

test('failed attempts publish automatically only from the moment the public setting is turned on', async ({
  extensionContext, progress, problem,
}) => {
  const { server, page } = await setup(extensionContext, progress);
  await expect(page.locator('#failed-state')).toHaveText(FAILED_OFF);
  await failResults(problem);
  await submit(problem, `// Earlier failure\n${submittedSource}`);
  await expect(progress.getByText('Incorrect - not saved to GitHub', { exact: true })).toHaveCount(1);
  expect(server.writes).toEqual([]);

  await setFailedPublication(page, true);
  const gate = Promise.withResolvers<void>();
  server.writeGate = gate.promise;
  await submit(problem, `// Published failure\n${submittedSource}`);
  await expect(progress.getByText('Failed attempt - awaiting GitHub delivery', { exact: true })).toBeVisible();
  gate.resolve();
  await expect(progress.getByText('Failed attempt saved to GitHub', { exact: true })).toHaveCount(1);
  // Nothing captured before the setting was turned on is published with it.
  await expect(progress.getByText('Incorrect - not saved to GitHub', { exact: true })).toHaveCount(1);
  expect(failedRoot(server.files)).toContain('/failed-');
  // A failed record is never written as, or counted as, an accepted one.
  expect([...server.files.keys()].some(path => path.endsWith('acceptance.json'))).toBe(false);
  expect(server.updates).toBe(1);
});

test('a published failed attempt carries its exact source, its own record and the report it names', async ({
  extensionContext, progress, problem,
}) => {
  const { server, page } = await setup(extensionContext, progress);
  await failResults(problem);
  await setFailedPublication(page, true);
  await submit(problem, `// Published failure\n${submittedSource}`);
  await expect(progress.getByText('Failed attempt saved to GitHub', { exact: true })).toHaveCount(1);

  const root = failedRoot(server.files);
  const bytes = `// Published failure\r\n${submittedBytes}`;
  const record = JSON.parse(server.files.get(`${root}/attempt.json`) ?? 'null');
  expect(record).toEqual({
    schemaVersion: 1, kind: 'failed', accepted: false, provider: 'hdlbits', problemId: 'step_one',
    attemptId: expect.any(String), outcome: 'incorrect',
    sourceHash: createHash('sha256').update(bytes).digest('hex'),
    sourceBytes: Buffer.byteLength(bytes, 'utf8'),
    submittedAt: expect.any(String), observedAt: expect.any(String),
    reportHash: expect.any(String), reportBytes: expect.any(Number),
    provenance: { capture: 'browser-post', verdict: 'incorrect', origin: 'https://hdlbits.01xz.net' },
  });
  expect(root).toBe(`progress/hdlbits/step_one/failed-${record.attemptId}`);
  expect(server.files.get(`${root}/solution.v`)).toBe(bytes);
  // The record pins the exact report bytes published beside it.
  const report = server.files.get(`${root}/report.json`) ?? '';
  expect(createHash('sha256').update(report).digest('hex')).toBe(record.reportHash);
  expect(Buffer.byteLength(report, 'utf8')).toBe(record.reportBytes);
  expect(JSON.parse(report)).toEqual({
    schemaVersion: 1, kind: 'report', provider: 'hdlbits', problemId: 'step_one',
    attemptId: record.attemptId, outcome: 'incorrect', observedAt: record.observedAt,
    status: 'Status: Incorrect', messages: [],
    coverage: { statusLine: true, diagnosticMessages: false, timingDiagram: false, artifacts: 'none' },
    provenance: { capture: 'browser-post', origin: 'https://hdlbits.01xz.net' },
  });
  // A result that drew nothing publishes no image file and claims no attribution it has no diagram for.
  expect([...server.files.keys()].some(path => path.endsWith('.png'))).toBe(false);
  expect([...server.files.keys()].some(path => path.endsWith('acceptance.json'))).toBe(false);
  expect(server.requestsValid).toBe(true);

  // The extension's own published bytes are read back as the failed record they are.
  await progress.getByRole('button', { name: 'Refresh saved progress' }).click();
  await expect(progress.locator('#recovery-status'))
    .toHaveText('0 recorded accepted; 1 recorded failed; 0 imported unverified; 0 unverified saved entries.');
  await expect(progress.getByText('Recorded failed attempt from GitHub - not accepted', { exact: true }))
    .toBeVisible();
});

test('an earlier failed attempt is published only by its own confirmed request', async ({
  extensionContext, progress, problem,
}) => {
  const { server, page } = await setup(extensionContext, progress);
  await failResults(problem);
  await submit(problem, submittedSource);
  await expect(progress.getByText('Incorrect - not saved to GitHub', { exact: true })).toBeVisible();

  progress.once('dialog', dialog => void dialog.dismiss());
  await progress.getByRole('button', { name: PUBLISH_FAILED }).click();
  await expect(progress.getByRole('button', { name: PUBLISH_FAILED })).toBeEnabled();
  expect(server.writes).toEqual([]);

  progress.once('dialog', dialog => void dialog.accept());
  await progress.getByRole('button', { name: PUBLISH_FAILED }).click();
  await expect(progress.getByText('Failed attempt saved to GitHub', { exact: true })).toBeVisible();
  expect(failedRoot(server.files)).toContain('/failed-');
  expect(server.updates).toBe(1);
  // Publishing one record explicitly does not turn the automatic setting on.
  await expect(page.locator('#failed-state')).toHaveText(FAILED_OFF);
});

test('turning the setting off stops new failed publications and removes nothing published', async ({
  extensionContext, progress, problem,
}) => {
  const { server, page } = await setup(extensionContext, progress);
  await failResults(problem);
  await setFailedPublication(page, true);
  await submit(problem, `// Published failure\n${submittedSource}`);
  await expect(progress.getByText('Failed attempt saved to GitHub', { exact: true })).toHaveCount(1);
  const published = new Map(server.files);

  await setFailedPublication(page, false);
  await submit(problem, `// Later failure\n${submittedSource}`);
  await expect(progress.getByText('Incorrect - not saved to GitHub', { exact: true })).toHaveCount(1);
  await progress.getByRole('button', { name: 'Refresh progress' }).click();
  await expect(progress.getByText('Failed attempt saved to GitHub', { exact: true })).toHaveCount(1);
  expect([...server.files]).toEqual([...published]);
  expect(server.updates).toBe(1);
});

test('a confirmation for one kind of attempt cannot publish the other', async ({
  extensionContext, progress, problem,
}) => {
  // Captured before any destination existed, so no accepted job was created for it.
  await submit(problem, submittedSource);
  await expect(progress.getByText('Accepted locally - not saved to GitHub', { exact: true })).toBeVisible();
  const { server, page } = await setup(extensionContext, progress);
  await failResults(problem);
  await submit(problem, `// Failure\n${submittedSource}`);
  await expect(progress.getByText('Incorrect - not saved to GitHub', { exact: true })).toBeVisible();

  const attempts = await storedAttempts(progress);
  const accepted = attempts.find(attempt => attempt.state === 'accepted')?.id ?? '';
  const failed = attempts.find(attempt => attempt.state === 'failed')?.id ?? '';
  expect(accepted && failed).toBeTruthy();
  const replies = await progress.evaluate(async ids => {
    const view = await chrome.runtime.sendMessage({ type: 'delivery:list' }) as {
      selection: { connectionId: string; operationId: string };
    };
    const target = {
      expectedConnectionId: view.selection.connectionId, expectedSelectionId: view.selection.operationId,
      publicConfirmed: true,
    };
    return {
      acceptedRequestForFailed: await chrome.runtime.sendMessage({
        type: 'delivery:publish', attemptId: ids.failed, ...target,
      }),
      failedRequestForAccepted: await chrome.runtime.sendMessage({
        type: 'delivery:publish-failed', attemptId: ids.accepted, failedConfirmed: true, ...target,
      }),
      unconfirmedFailedRequest: await chrome.runtime.sendMessage({
        type: 'delivery:publish-failed', attemptId: ids.failed, ...target,
      }),
    };
  }, { accepted, failed });
  expect(replies).toEqual({
    acceptedRequestForFailed: {
      ok: false,
      error: 'Only a complete, validated failed snapshot with its submission report can be published.',
    },
    failedRequestForAccepted: {
      ok: false, error: 'Only a complete, validated accepted snapshot can be published.',
    },
    unconfirmedFailedRequest: { ok: false, error: 'Unsupported delivery operation or sender.' },
  });
  expect(server.writes).toEqual([]);
  await expect(page.locator('#failed-state')).toHaveText(FAILED_OFF);
});

test('a report copies the stated verdict only, never provider explanations or a reference table', async ({
  extensionContext, progress, problem,
}) => {
  const { server, page } = await setup(extensionContext, progress);
  await failResults(problem, explainedPage);
  await setFailedPublication(page, true);
  await submit(problem, submittedSource);
  await expect(progress.getByText('Failed attempt saved to GitHub', { exact: true })).toBeVisible();

  const stored = await storedAttempts(progress);
  expect(stored).toHaveLength(1);
  expect(stored[0]?.report).toEqual({
    schemaVersion: 1, status: 'Status: Incorrect', messages: [],
    // The block this page states its model answer in is not one this extension reads, so the report says its
    // message coverage is partial instead of reading as a result with nothing to say.
    coverage: {
      statusLine: true, diagnosticMessages: false, partialMessages: true, timingDiagram: false, artifacts: 'none',
    },
  });
  const everything = [...server.files.values()].join('\n');
  for (const text of PROVIDER_ONLY_TEXT) {
    expect(everything).not.toContain(text);
    await expect(progress.getByText(text, { exact: false })).toHaveCount(0);
  }
  await expect(progress.getByText(
    'Some blocks on this result used a structure this extension does not read. Only recognised messages are stored.',
    { exact: true },
  )).toBeVisible();
  // A page that drew no chart says so; nothing is invented from the reference table or the bitmap beside it.
  await expect(progress.getByText('This result drew no timing diagram.', { exact: true })).toBeVisible();
});

test('a delayed failure in one tab keeps its own source, outcome and report', async ({
  extensionContext, progress, problem,
}) => {
  const { server, page } = await setup(extensionContext, progress);
  await setFailedPublication(page, true);
  const failing = Promise.withResolvers<void>();
  await extensionContext.route('**/runsim.php', async route => {
    const body = route.request().postData() ?? '';
    if (body.includes('// Slow failure')) {
      await failing.promise;
      await route.fulfill({ contentType: 'text/html', body: incorrectPage });
    } else {
      await route.fulfill({ contentType: 'text/html', body: successPage });
    }
  });
  const second = await extensionContext.newPage();
  await second.goto('https://hdlbits.01xz.net/wiki/Step_one');
  await submit(problem, `// Slow failure\n${submittedSource}`);
  await expect(progress.getByText('Waiting for the result - not saved to GitHub', { exact: true })).toHaveCount(1);
  await submit(second, `// Accepted elsewhere\n${submittedSource}`);
  await expect(progress.getByText('Saved to GitHub', { exact: true })).toHaveCount(1);
  failing.resolve();
  await expect(progress.getByText('Failed attempt saved to GitHub', { exact: true })).toHaveCount(1);

  const root = failedRoot(server.files);
  expect(server.files.get(`${root}/solution.v`)).toBe(`// Slow failure\r\n${submittedBytes}`);
  const accepted = [...server.files.keys()].find(path => path.endsWith('acceptance.json'))?.slice(0, -'/acceptance.json'.length) ?? '';
  expect(server.files.get(`${accepted}/solution.v`)).toBe(`// Accepted elsewhere\r\n${submittedBytes}`);
  expect(JSON.parse(server.files.get(`${root}/report.json`) ?? 'null')).toMatchObject({
    outcome: 'incorrect', status: 'Status: Incorrect',
  });
  expect(server.updates).toBe(2);
  expect(server.requestsValid).toBe(true);
});

test('a forged or malformed report cannot record a failure the page never stated', async ({
  extensionContext, progress, problem,
}) => {
  const { server, page } = await setup(extensionContext, progress);
  await setFailedPublication(page, true);
  const grading = Promise.withResolvers<void>();
  let requests = 0;
  await extensionContext.route('**/runsim.php', async route => {
    if (requests++ > 0) await grading.promise;
    await route.fulfill({ contentType: 'text/html', body: successPage });
  });
  await submit(problem, submittedSource);
  await expect(progress.getByText('Saved to GitHub', { exact: true })).toHaveCount(1);
  const observer = await trackContentScript(extensionContext, problem);
  await submit(problem, `// Newer attempt\n${submittedSource}`);
  await expect(progress.getByText('Waiting for the result - not saved to GitHub', { exact: true })).toHaveCount(1);

  const replies = await observer.evaluate(`(async () => {
    const valid = {
      schemaVersion: 1, status: 'Status: Incorrect', messages: [],
      coverage: { statusLine: true, diagnosticMessages: false, timingDiagram: false }
    };
    const result = { type: 'hdlbits:result', problemId: 'step_one', verdict: 'incorrect' };
    return {
      oversized: await chrome.runtime.sendMessage({ ...result,
        report: { ...valid, messages: [{ severity: 'error', text: 'x'.repeat(2000) }],
          coverage: { statusLine: true, diagnosticMessages: true, timingDiagram: false } } }),
      inconsistent: await chrome.runtime.sendMessage({ ...result,
        report: { ...valid, coverage: { statusLine: true, diagnosticMessages: true, timingDiagram: false } } }),
      timing: await chrome.runtime.sendMessage({ ...result,
        report: { ...valid, coverage: { statusLine: true, diagnosticMessages: false, timingDiagram: true } } }),
      markup: await chrome.runtime.sendMessage({ ...result,
        report: { ...valid, status: 'Status: Incorrect\\u0000<script>' } }),
      missing: await chrome.runtime.sendMessage(result),
      wellFormed: await chrome.runtime.sendMessage({ ...result, report: valid })
    };
  })()`);
  expect(replies).toEqual({
    oversized: { ok: false, error: 'Unsupported message or sender.' },
    inconsistent: { ok: false, error: 'Unsupported message or sender.' },
    timing: { ok: false, error: 'Unsupported message or sender.' },
    markup: { ok: false, error: 'Unsupported message or sender.' },
    missing: { ok: false, error: 'Unsupported message or sender.' },
    // Even a well-formed report belongs to no observed submission of this document.
    wellFormed: { ok: false, error: 'No matching observed submission. This result is unverified.' },
  });
  grading.resolve();
  await expect(progress.getByText('Saved to GitHub', { exact: true })).toHaveCount(2);
  expect((await storedAttempts(progress)).map(attempt => attempt.state)).toEqual(['accepted', 'accepted']);
  expect([...server.files.keys()].some(path => path.includes('/failed-'))).toBe(false);
  await observer.close();
});

const ATTEMPT_ID = '22222222-2222-4222-8222-222222222222';

// A published failed record as the extension writes it: source, record, and the exact report the record names.
function savedFailedFiles(changes: { report?: string | null; metadata?: Record<string, unknown> } = {}) {
  const root = `progress/hdlbits/step_one/failed-${ATTEMPT_ID}`;
  const observedAt = '2026-01-01T00:00:01.000Z';
  // The record always names the report the extension published; a scenario only changes what is stored.
  const named = JSON.stringify({
    schemaVersion: 1, kind: 'report', provider: 'hdlbits', problemId: 'step_one', attemptId: ATTEMPT_ID,
    outcome: 'incorrect', observedAt, status: 'Status: Incorrect', messages: [],
    coverage: { statusLine: true, diagnosticMessages: false, timingDiagram: false },
    provenance: { capture: 'browser-post', origin: 'https://hdlbits.01xz.net' },
  }, null, 2) + '\n';
  const report = changes.report === undefined ? named : changes.report;
  const files = new Map([
    [`${root}/solution.v`, submittedBytes],
    [`${root}/attempt.json`, JSON.stringify({
      schemaVersion: 1, kind: 'failed', accepted: false, provider: 'hdlbits', problemId: 'step_one',
      attemptId: ATTEMPT_ID, outcome: 'incorrect',
      sourceHash: createHash('sha256').update(submittedBytes, 'utf8').digest('hex'),
      sourceBytes: Buffer.byteLength(submittedBytes, 'utf8'),
      submittedAt: '2026-01-01T00:00:00.000Z', observedAt,
      reportHash: createHash('sha256').update(named, 'utf8').digest('hex'),
      reportBytes: Buffer.byteLength(named, 'utf8'),
      provenance: { capture: 'browser-post', verdict: 'incorrect', origin: 'https://hdlbits.01xz.net' },
      ...changes.metadata,
    })],
  ]);
  if (report !== null) files.set(`${root}/report.json`, report);
  return files;
}

async function readSaved(context: BrowserContext, progress: Page, files: Map<string, string>) {
  await githubFixture(context);
  const target = await destinationFixture(context);
  target.exists = true;
  target.marker = true;
  const remote = await recoveryFixture(context, target, { files });
  const connection = await openConnection(context, progress);
  await connection.getByRole('button', { name: 'Connect GitHub', exact: true }).click();
  await expect(connection.getByRole('status')).toHaveText('Connected as fixture-user');
  const [destination] = await Promise.all([
    context.waitForEvent('page'),
    connection.getByRole('link', { name: 'Set up progress repository' }).click(),
  ]);
  await expect(destination.getByText('Owner: fixture-user', { exact: true })).toBeVisible();
  await destination.getByRole('button', { name: 'Connect existing repository', exact: true }).click();
  return remote;
}

test('a published failed record is read back as failed, with its report and never as an acceptance', async ({
  extensionContext, progress,
}) => {
  const remote = await readSaved(extensionContext, progress, savedFailedFiles());
  await expect(progress.locator('#recovery-status'))
    .toHaveText('0 recorded accepted; 1 recorded failed; 0 imported unverified; 0 unverified saved entries.');
  await expect(progress.getByText('Recorded failed attempt from GitHub - not accepted', { exact: true }))
    .toBeVisible();
  await expect(progress.getByText('Recorded acceptance from GitHub', { exact: true })).toHaveCount(0);
  await expect(progress.getByRole('heading', { name: 'Submission report', exact: true })).toBeVisible();
  await expect(progress.getByText('Status: Incorrect', { exact: true })).toBeVisible();
  await expect(progress.getByRole('textbox', { name: 'Recovered source (read-only)' }))
    .toHaveValue(submittedBytes.replaceAll('\r\n', '\n'));
  expect(remote.writes).toBe(0);
});

for (const scenario of [
  {
    name: 'no report file', files: savedFailedFiles({ report: null }),
    message: 'The failed record has no matching submission report file.',
  },
  {
    name: 'a report that was edited after publication',
    files: savedFailedFiles({ report: JSON.stringify({
      schemaVersion: 1, kind: 'report', provider: 'hdlbits', problemId: 'step_one', attemptId: ATTEMPT_ID,
      outcome: 'incorrect', observedAt: '2026-01-01T00:00:01.000Z', status: 'Status: Success!', messages: [],
      coverage: { statusLine: true, diagnosticMessages: false, timingDiagram: false },
      provenance: { capture: 'browser-post', origin: 'https://hdlbits.01xz.net' },
    }, null, 2) + '\n' }),
    message: 'The submission report is malformed, oversized, or does not match the record that names it.',
  },
  {
    name: 'a record claiming acceptance', files: savedFailedFiles({ metadata: { accepted: true } }),
    message: 'Acceptance metadata is malformed or unsupported.',
  },
  {
    name: 'a record moved out of its own folder',
    files: savedFailedFiles({ metadata: { attemptId: '33333333-3333-4333-8333-333333333333' } }),
    message: 'The record identity or observation timestamps do not match its saved attempt.',
  },
]) {
  test(`a failed record with ${scenario.name} stays explicitly unverified`, async ({
    extensionContext, progress,
  }) => {
    const remote = await readSaved(extensionContext, progress, scenario.files);
    await expect(progress.getByText(`Unverified saved file: ${scenario.message}`, { exact: true })).toBeVisible();
    await expect(progress.locator('#recovery-status'))
      .toHaveText('0 recorded accepted; 0 recorded failed; 0 imported unverified; 1 unverified saved entries.');
    await expect(progress.getByText('Recorded failed attempt from GitHub - not accepted', { exact: true }))
      .toHaveCount(0);
    expect(remote.writes).toBe(0);
  });
}
