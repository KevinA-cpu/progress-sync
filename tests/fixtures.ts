import { expect as check, test as base, chromium, type BrowserContext, type Page, type Worker } from '@playwright/test';
import { resolve } from 'node:path';
import { cp, writeFile } from 'node:fs/promises';
import type { Browser } from 'wxt/browser';

declare const chrome: typeof Browser;

export const DELIVERY_RETRY_ALARM = 'delivery-retry-v1';

export const submittedSource = "module top_module(output one);\nassign one = 1'b1;\nendmodule\n";
export const submittedBytes = "module top_module(output one);\r\nassign one = 1'b1;\r\nendmodule\r\n";

const problemPage = `<!doctype html>
<html lang="en"><head><title>Controlled HDLBits problem</title></head><body>
  <h1>Step one</h1>
  <span id="historical-status">Not solved</span>
  <form id="codeform" action="/runsim.php" method="post" enctype="multipart/form-data" target="compile_iframe">
    <label for="codesubmitbox">Solution</label>
    <textarea id="codesubmitbox" name="vlgcode_box"></textarea>
    <input type="hidden" name="tc" value="step_one">
    <button id="submitiframe" type="button">Submit</button>
  </form>
  <iframe id="compile_iframe" name="compile_iframe" title="Grading result"></iframe>
  <script>
    document.querySelector('#submitiframe').addEventListener('click', () => {
      document.querySelector('#codeform').submit();
    });
  </script>
</body></html>`;

// The provider renders its message box on every result, empty when the compiler said nothing, so a result the
// artifact phase can conclude as soon as it stops changing is the ordinary case rather than a special one.
export const successPage = `<!doctype html>
<html><head><title>step_one: Simulation - HDLBits</title></head>
<body><h2>step_one &mdash; Compile and simulate</h2><h2>Status: Success!</h2>
<div class="msgbox msg_none"><div class="warn_msgs"></div></div></body></html>`;

export async function installProviderRoutes(context: BrowserContext): Promise<void> {
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.protocol === 'chrome-extension:') {
      await route.continue();
    } else if (url.origin !== 'https://hdlbits.01xz.net') {
      await route.abort();
    } else if (url.pathname === '/wiki/Step_one' || url.pathname === '/wiki/Zero') {
      await route.fulfill({
        contentType: 'text/html',
        body: url.pathname === '/wiki/Zero' ? problemPage.replaceAll('step_one', 'zero') : problemPage,
      });
    } else if (url.pathname === '/runsim.php') {
      await route.fulfill({ contentType: 'text/html', body: successPage });
    } else {
      await route.fulfill({ status: 404, body: 'Not found' });
    }
  });
}

// Context console events include service-worker output. Attaching before the first worker starts slows
// publication measurably, so capture begins once it runs and before GitHub can issue a credential.
const consoleLines = new WeakMap<BrowserContext, string[]>();

export function captureConsole(context: BrowserContext): void {
  if (consoleLines.has(context)) return;
  const lines: string[] = [];
  consoleLines.set(context, lines);
  context.on('console', message => { lines.push(message.text()); });
}

export function consoleOutput(context: BrowserContext): string[] {
  const lines = consoleLines.get(context);
  if (!lines) throw new Error('Expected a context prepared with captureConsole before it was used.');
  return lines;
}

export async function launchExtensionProfile(extensionPath: string, profilePath: string): Promise<BrowserContext> {
  const context = await chromium.launchPersistentContext(profilePath, {
    channel: 'chromium',
    headless: true,
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
      // The extension can send its first request before routing is installed. Resolution is broken so that such
      // a request fails as an unreachable network instead of reaching a real site.
      '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost',
    ],
  });
  await installProviderRoutes(context);
  return context;
}

interface ExtensionFixtures {
  githubClientId: string | null;
  extensionContext: BrowserContext;
  progress: Page;
  problem: Page;
}

export const test = base.extend<ExtensionFixtures>({
  githubClientId: [null, { option: true }],
  extensionContext: async ({ githubClientId }, use, testInfo) => {
    const extensionPath = testInfo.outputPath('extension');
    await cp(resolve('.output', 'chrome-mv3'), extensionPath, { recursive: true });
    await writeFile(resolve(extensionPath, 'github-app.json'), JSON.stringify({ clientId: githubClientId }));
    const context = await launchExtensionProfile(extensionPath, testInfo.outputPath('profile'));
    await use(context);
    await context.close();
  },
  progress: async ({ extensionContext }, use) => {
    const worker = extensionContext.serviceWorkers()[0]
      ?? await extensionContext.waitForEvent('serviceworker');
    captureConsole(extensionContext);
    const page = await extensionContext.newPage();
    await page.goto(`chrome-extension://${new URL(worker.url()).hostname}/options.html`);
    await use(page);
  },
  problem: async ({ extensionContext, progress }, use) => {
    await progress.getByRole('heading', { name: 'Progress Sync', exact: true }).waitFor();
    const page = await extensionContext.newPage();
    await page.goto('https://hdlbits.01xz.net/wiki/Step_one');
    await use(page);
  },
});

export { expect } from '@playwright/test';

export function extensionWorker(context: BrowserContext): Worker {
  const worker = context.serviceWorkers()[0];
  if (!worker) throw new Error('Expected the extension worker to be running.');
  return worker;
}

const deliveryClockShift = new WeakMap<BrowserContext, number>();

export async function advanceDeliverySchedule(
  context: BrowserContext, milliseconds: number, wake = true,
): Promise<void> {
  const shift = (deliveryClockShift.get(context) ?? 0) + milliseconds;
  deliveryClockShift.set(context, shift);
  await extensionWorker(context).evaluate(async input => {
    const real = () => Math.round(performance.timeOrigin + performance.now());
    Date.now = () => real() + input.shift;
    if (input.wake) await chrome.alarms.create(input.alarm, { when: real() });
  }, { shift, wake, alarm: DELIVERY_RETRY_ALARM });
}

export async function alarmNames(context: BrowserContext): Promise<string[]> {
  return extensionWorker(context)
    .evaluate(async () => (await chrome.alarms.getAll()).map(alarm => alarm.name).sort());
}

export async function deliveryAlarm(context: BrowserContext): Promise<number | null> {
  return extensionWorker(context).evaluate(async name => {
    const alarm = await chrome.alarms.get(name);
    return alarm ? alarm.scheduledTime : null;
  }, DELIVERY_RETRY_ALARM);
}

export async function stopExtensionWorker(context: BrowserContext, page: Page): Promise<void> {
  const worker = context.serviceWorkers()[0];
  if (!worker) throw new Error('Expected the extension worker to be running.');
  const session = await context.newCDPSession(page);
  const runningVersion = new Promise<string>(resolve => {
    session.on('ServiceWorker.workerVersionUpdated', ({ versions }) => {
      const version = versions.find(item => item.scriptURL === worker.url()
        && item.runningStatus === 'running');
      if (version) resolve(version.versionId);
    });
  });
  await session.send('ServiceWorker.enable');
  const versionId = await runningVersion;
  const stopped = new Promise<void>(resolve => {
    session.on('ServiceWorker.workerVersionUpdated', ({ versions }) => {
      if (versions.some(item => item.versionId === versionId && item.runningStatus === 'stopped')) {
        resolve();
      }
    });
  });
  await session.send('ServiceWorker.stopWorker', { versionId });
  await stopped;
  await session.detach();
}

// Waking the worker without opening an extension page leaves no view request in flight.
export async function restartExtensionWorker(
  context: BrowserContext, page: Page, wake: () => Promise<unknown>,
): Promise<Worker> {
  await stopExtensionWorker(context, page);
  await wake();
  await check.poll(() => context.serviceWorkers()).toHaveLength(1);
  return extensionWorker(context);
}
