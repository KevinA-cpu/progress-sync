import { test as base, chromium, type BrowserContext, type Page } from '@playwright/test';
import { resolve } from 'node:path';
import { cp, writeFile } from 'node:fs/promises';

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

export const successPage = `<!doctype html>
<html><head><title>step_one: Simulation - HDLBits</title></head>
<body><h2>step_one &mdash; Compile and simulate</h2><h2>Status: Success!</h2></body></html>`;

export async function installProviderRoutes(context: BrowserContext): Promise<void> {
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.protocol === 'chrome-extension:') {
      await route.continue();
    } else if (url.origin !== 'https://hdlbits.01xz.net') {
      await route.abort();
    } else if (url.pathname === '/wiki/Step_one') {
      await route.fulfill({ contentType: 'text/html', body: problemPage });
    } else if (url.pathname === '/runsim.php') {
      await route.fulfill({ contentType: 'text/html', body: successPage });
    } else {
      await route.fulfill({ status: 404, body: 'Not found' });
    }
  });
}

export async function launchExtensionProfile(extensionPath: string, profilePath: string): Promise<BrowserContext> {
  const context = await chromium.launchPersistentContext(profilePath, {
    channel: 'chromium',
    headless: true,
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
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
