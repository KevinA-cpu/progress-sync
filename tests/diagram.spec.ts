import { createHash } from 'node:crypto';
import type { BrowserContext, Page } from '@playwright/test';
import type { Browser } from 'wxt/browser';
import {
  consoleOutput, expect, restartExtensionWorker, submittedBytes, submittedSource, test,
} from './fixtures';
import { ACCESS_TOKEN, CLIENT_ID, githubFixture, openConnection } from './github-fixture';
import { destinationFixture } from './destination-fixture';
import { recoveryFixture } from './recovery-fixture';
import { setup } from './publication-setup';
import { buildPng, corruptPng, countColour, countDrawn, decodePng, type Colour } from './diagram-image';

declare const chrome: typeof Browser;

test.use({ githubClientId: CLIENT_ID });

const BLUE: Colour = [0, 0, 255];
const RED: Colour = [255, 0, 0];
const GREEN: Colour = [0, 255, 0];
const WHITE: Colour = [255, 255, 255];
const PROBLEM_URL = 'https://hdlbits.01xz.net/wiki/Step_one';
const IMAGE_PREFIX = 'data:image/png;base64,';

// The chart's own presentation comes from the page's stylesheet, never from attributes on the drawing. A capture
// that did not resolve these values would store a blank or black image instead of the waveform.
const PAGE_STYLE = `
  body { margin: 0; background: #ffffff }
  .timingbox { background: #ffffff }
  svg .wire { fill: none; stroke: #0000ff; stroke-width: 3 }
  svg .frame { fill: #ffffff; stroke: #cccccc; stroke-width: 1 }
  svg .grid { stroke: #cccccc; stroke-width: 1 }
  svg text { font-family: monospace; font-size: 12px; fill: #000000 }
`;

// An original drawing built from the element types an actual result page uses for a waveform: a defs block with
// a marker and a reusable lane, a frame, a referenced lane, a stroked wire, a grid line and labels.
function waveform(options: { id?: string; width?: number; height?: number; offset?: number } = {}): string {
  const id = options.id ?? '0';
  const width = options.width ?? 360;
  const height = options.height ?? 120;
  const offset = options.offset ?? 0;
  return `<svg id="svgcontent_${id}" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <defs>
    <marker id="edge_${id}" markerWidth="8" markerHeight="8" refX="4" refY="4" orient="auto">
      <path class="wire" d="M1,1 L7,4 L1,7"/>
    </marker>
    <g id="lane_${id}"><path class="wire" d="M0,0 L40,0 L40,-18 L110,-18 L110,0 L180,0"/></g>
  </defs>
  <g transform="translate(24,${20 + offset})">
    <rect class="frame" x="0" y="-16" width="${width - 48}" height="${height - 40}"/>
    <use href="#lane_${id}" x="56" y="24"/>
    <path class="wire" d="M56,64 L96,64 L96,46 L166,46 L166,64 L236,64" marker-end="url(#edge_${id})"/>
    <line class="grid" x1="56" y1="76" x2="${width - 60}" y2="76"/>
    <text class="label" x="0" y="28">in<tspan dx="3">0</tspan></text>
    <text class="label" x="0" y="68">out</text>
  </g>
</svg>`;
}

const timingbox = (svg: string, index = 0) =>
  `<div class="timingbox"><div id="WaveDrom_Display_${index}">${svg}</div></div>`;

const WARNINGS = [
  'Warning (10230): Verilog HDL assignment warning at top.v(2): truncated value with size 32 to match size of target (1)',
  'Warning (10036): Verilog HDL or VHDL warning at top.v(3): object "spare" declared but not used',
];
const ERRORS = [
  'Error (10170): Verilog HDL syntax error at top.v(4) near text "endmodule"',
  'Compilation halted before simulation started',
];
// Lesson prose the provider renders beside its diagnostics. It belongs to the course, not to this submission.
const EXPLANATION = 'EXPLAINED_ONLY: this note describes what such a warning usually means for a design.';
const warningBlock = `<div class="msgbox msg_warn"><div class="warn_msgs">${WARNINGS.join('\n')}</div>`
  + `<div class="warn_expl">${EXPLANATION}</div></div>`;
const errorBlock = `<div class="msgbox msg_error"><div class="warn_msgs">${ERRORS.join('\n')}</div></div>`;

function resultPage(
  body: string, options: { status?: string; problemId?: string; script?: string } = {},
): string {
  const problemId = options.problemId ?? 'step_one';
  return `<!doctype html>
<html><head><title>${problemId}: Simulation - HDLBits</title><style>${PAGE_STYLE}</style></head>
<body><h2>${problemId} &mdash; Compile and simulate</h2><h2>Status: ${options.status ?? 'Incorrect'}</h2>
${body}
<script>${options.script ?? ''}</script>
</body></html>`;
}

async function serveResult(page: Page, body: string): Promise<void> {
  await page.context().route('**/runsim.php', route => route.fulfill({ contentType: 'text/html', body }));
}

async function submit(page: Page, source: string): Promise<void> {
  await page.getByRole('textbox', { name: 'Solution' }).fill(source);
  await page.getByRole('button', { name: 'Submit', exact: true }).click();
}

async function setFailedPublication(page: Page): Promise<void> {
  await page.getByLabel('Publish new failed attempts and their reports automatically').setChecked(true);
  await page.getByLabel('I understand failed attempts and reports will be publicly readable').check();
  await page.getByRole('button', { name: 'Save failed-attempt choice', exact: true }).click();
  await expect(page.locator('#failed-state')).toContainText('Failed attempts captured from now on are published');
}

interface StoredDiagram {
  name: string;
  mediaType: string;
  width: number;
  height: number;
  byteLength: number;
  hash: string;
}
interface StoredReport {
  schemaVersion: number;
  status: string;
  messages: { severity: string; text: string }[];
  diagrams?: StoredDiagram[];
  attribution?: { provider: string; problemUrl: string; notice: string };
  coverage: Record<string, unknown>;
}
interface StoredAttempt {
  id: string;
  state: string;
  problemId: string | null;
  source: string | null;
  report?: StoredReport;
}

async function storedAttempts(progress: Page): Promise<StoredAttempt[]> {
  return progress.evaluate(async () => {
    const reply = await chrome.runtime.sendMessage({ type: 'progress:list' }) as { attempts: StoredAttempt[] };
    return reply.attempts;
  }) as Promise<StoredAttempt[]>;
}

async function storedImages(progress: Page, attemptId: string): Promise<{ name: string; data: string }[] | null> {
  return progress.evaluate(async key => {
    const stored = await chrome.storage.local.get(key) as Record<string, unknown>;
    return (stored[key] ?? null) as { name: string; data: string }[] | null;
  }, `diagram-images-v1:${attemptId}`);
}

// The verdict is recorded before the artifact phase ends, so a report is only read once that phase concluded.
async function concludedAttempt(progress: Page, source?: string): Promise<StoredAttempt> {
  const pick = (attempts: StoredAttempt[]) => source === undefined
    ? attempts[0] : attempts.find(attempt => attempt.source?.startsWith(source.split('\n')[0] ?? ''));
  await expect.poll(async () => {
    const artifacts = pick(await storedAttempts(progress))?.report?.coverage.artifacts;
    return typeof artifacts === 'string' ? artifacts : null;
  }, { timeout: 15_000 }).toMatch(/^(complete|partial|none|deadline|rejected)$/);
  const attempt = pick(await storedAttempts(progress));
  if (!attempt?.report) throw new Error('Expected a concluded report.');
  return attempt;
}

function publishedRoot(files: Map<string, string>): string {
  const source = [...files.keys()].find(path => path.endsWith('/solution.v'));
  if (!source) throw new Error('Expected a published record.');
  return source.slice(0, -'/solution.v'.length);
}

function publishedImage(files: Map<string, string>, path: string): Buffer {
  const content = files.get(path);
  if (content === undefined) throw new Error(`Expected a published image at ${path}.`);
  return Buffer.from(content, 'latin1');
}

test('a failed result publishes the chart it drew beside its source, record and report', async ({
  extensionContext, progress, problem,
}) => {
  const { server, page } = await setup(extensionContext, progress);
  await setFailedPublication(page);
  await serveResult(problem, resultPage(`${warningBlock}${timingbox(waveform())}`));
  await submit(problem, submittedSource);
  await expect(progress.getByText('Failed attempt saved to GitHub', { exact: true })).toBeVisible();

  const root = publishedRoot(server.files);
  // Source, record, report and image are one commit: no reader ever sees a record without the image it names.
  expect([...server.files.keys()].filter(path => path.startsWith('progress/')).sort()).toEqual([
    `${root}/attempt.json`, `${root}/diagram-1.png`, `${root}/report.json`, `${root}/solution.v`,
  ]);
  expect(server.updates).toBe(1);
  expect(server.requestsValid).toBe(true);

  const record = JSON.parse(server.files.get(`${root}/attempt.json`) ?? 'null') as { reportHash: string };
  const reportContent = server.files.get(`${root}/report.json`) ?? '';
  expect(createHash('sha256').update(reportContent).digest('hex')).toBe(record.reportHash);
  const report = JSON.parse(reportContent) as StoredReport;
  expect(report.messages).toEqual(WARNINGS.map(text => ({ severity: 'warning', text })));
  expect(report.diagrams).toEqual([{
    name: 'diagram-1.png', mediaType: 'image/png', width: 360, height: 120,
    byteLength: expect.any(Number), hash: expect.stringMatching(/^[a-f0-9]{64}$/),
  }]);
  expect(report.attribution).toEqual({
    provider: 'HDLBits', problemUrl: PROBLEM_URL, notice: 'HDLBits does not endorse this extension.',
  });
  expect(report.coverage).toEqual({
    statusLine: true, diagnosticMessages: true, timingDiagram: true, artifacts: 'complete',
  });

  // The published bytes are the image the report describes, and they draw the waveform the page drew.
  const diagram = report.diagrams?.[0] as StoredDiagram;
  const bytes = publishedImage(server.files, `${root}/diagram-1.png`);
  expect(bytes.length).toBe(diagram.byteLength);
  expect(createHash('sha256').update(bytes).digest('hex')).toBe(diagram.hash);
  const image = decodePng(bytes);
  expect([image.width, image.height]).toEqual([360, 120]);
  expect(countColour(image, BLUE)).toBeGreaterThan(400);
  expect(countDrawn(image)).toBeGreaterThan(1000);
  expect(countColour(image, WHITE, 4)).toBeGreaterThan(360 * 120 / 2);

  // Nothing the provider explains, and no page markup, travels with the chart.
  const text = [...server.files].filter(([path]) => !path.endsWith('.png')).map(([, body]) => body).join('\n');
  expect(text).not.toContain('EXPLAINED_ONLY');
  expect(text).not.toContain('<svg');
  expect(consoleOutput(extensionContext).join('\n')).not.toContain(ACCESS_TOKEN);
  // The page that was graded is left exactly as it was.
  await expect(problem.getByRole('textbox', { name: 'Solution' })).toHaveValue(submittedSource);
  expect(server.files.get(`${root}/solution.v`)).toBe(submittedBytes);
});

test('a captured chart is shown from this profile with the exact bytes the report names', async ({
  progress, problem,
}) => {
  await serveResult(problem, resultPage(timingbox(waveform()), { status: 'Success!' }));
  await submit(problem, submittedSource);
  await expect(progress.getByText('Accepted locally - not saved to GitHub', { exact: true })).toBeVisible();
  const attempt = await concludedAttempt(progress);
  const diagram = attempt.report?.diagrams?.[0] as StoredDiagram;

  await expect(progress.getByRole('heading', { name: 'Timing diagrams', exact: true })).toBeVisible();
  await expect(progress.getByText('1 timing diagram stored; 0 not stored.', { exact: true })).toBeVisible();
  await expect(progress.getByText(
    'The captured images are held in this browser profile until the attempt is published or discarded.',
    { exact: true },
  )).toBeVisible();
  const figure = progress.locator('figure');
  await expect(figure).toHaveCount(1);
  const picture = figure.locator('img');
  await expect(picture).toHaveAttribute('alt', 'Timing diagram 1 captured for step_one');
  await expect(picture).toHaveAttribute('width', '360');
  await expect(figure.locator('figcaption'))
    .toHaveText(`diagram-1.png (360x120, SHA-256 ${diagram.hash})`);
  await expect(figure.getByRole('link', { name: 'Download diagram-1.png' }))
    .toHaveAttribute('download', 'diagram-1.png');

  // What is rendered is the stored image itself, not a reference to anything on the provider's page.
  const source = await picture.getAttribute('src') ?? '';
  expect(source.startsWith(IMAGE_PREFIX)).toBe(true);
  const bytes = Buffer.from(source.slice(IMAGE_PREFIX.length), 'base64');
  expect(createHash('sha256').update(bytes).digest('hex')).toBe(diagram.hash);
  expect(countColour(decodePng(bytes), BLUE)).toBeGreaterThan(400);
  const held = await storedImages(progress, attempt.id);
  expect(held?.map(image => image.name)).toEqual(['diagram-1.png']);

  await expect(progress.getByText('Rendered by HDLBits from this submission', { exact: true })).toBeVisible();
  await expect(progress.getByText('HDLBits does not endorse this extension.', { exact: true })).toBeVisible();
  const link = progress.getByRole('link', { name: `Problem page: ${PROBLEM_URL}` });
  await expect(link).toHaveAttribute('href', PROBLEM_URL);
  await expect(link).toHaveAttribute('rel', 'noopener noreferrer');
});

// The drawing is held in a template and moved into place later, the way a provider renders a chart only once its
// simulation data has arrived.
const DRAW_LATER = (delay: number) => `setTimeout(() => {
  const box = document.createElement('div');
  box.id = 'WaveDrom_Display_0';
  box.append(document.querySelector('#later').content.cloneNode(true));
  document.querySelector('#host').append(box);
}, ${delay});`;
const withTemplate = (page: string, svg: string) =>
  page.replace('</body>', `<template id="later">${svg}</template></body>`);

test('a chart drawn after the verdict is still captured', async ({ progress, problem }) => {
  await serveResult(problem, withTemplate(
    resultPage('<div class="timingbox" id="host"></div>', { script: DRAW_LATER(1500) }), waveform(),
  ));
  await submit(problem, submittedSource);
  await expect(progress.getByText('Incorrect - not saved to GitHub', { exact: true })).toBeVisible();

  const attempt = await concludedAttempt(progress);
  expect(attempt.report?.coverage).toEqual({
    statusLine: true, diagnosticMessages: false, timingDiagram: true, artifacts: 'complete',
  });
  expect(attempt.report?.diagrams?.[0]).toMatchObject({ name: 'diagram-1.png', width: 360, height: 120 });
  const held = await storedImages(progress, attempt.id);
  expect(countColour(decodePng(Buffer.from(held?.[0]?.data ?? '', 'base64')), BLUE)).toBeGreaterThan(400);
});

test('a chart replaced, then changed again, is captured as it finally stands', async ({ progress, problem }) => {
  const first = waveform({ id: '0', width: 200, height: 60 })
    .replace(/class="wire"/g, 'stroke="#ff0000" stroke-width="3" fill="none"');
  // The drawing is replaced at 900 ms and one of its lines is restyled at 1500 ms. Each change restarts the
  // settling window, so a capture that took the first quiet second would hold the wrong picture.
  await serveResult(problem, withTemplate(resultPage(timingbox(first), {
    script: `setTimeout(() => {
      document.querySelector('#WaveDrom_Display_0')
        .replaceChildren(document.querySelector('#later').content.cloneNode(true));
    }, 900);
    setTimeout(() => {
      const wire = document.querySelector('#svgcontent_0 > g > path');
      wire.removeAttribute('class');
      wire.setAttribute('stroke', '#00ff00');
      wire.setAttribute('stroke-width', '3');
      wire.setAttribute('fill', 'none');
    }, 1500);`,
  }), waveform()));
  await submit(problem, submittedSource);
  await expect(progress.getByText('Incorrect - not saved to GitHub', { exact: true })).toBeVisible();

  const attempt = await concludedAttempt(progress);
  expect(attempt.report?.diagrams).toHaveLength(1);
  // The stored image is the replacement, not the drawing that was there when the verdict was stated.
  expect(attempt.report?.diagrams?.[0]).toMatchObject({ width: 360, height: 120 });
  const held = await storedImages(progress, attempt.id);
  const image = decodePng(Buffer.from(held?.[0]?.data ?? '', 'base64'));
  expect(countColour(image, RED)).toBe(0);
  // The lane drawn from the replacement is still blue; the restyled wire is the later change.
  expect(countColour(image, BLUE)).toBeGreaterThan(200);
  expect(countColour(image, GREEN)).toBeGreaterThan(200);
});

test('a result still redrawing when the window closes states that its chart was not captured', async ({
  progress, problem,
}) => {
  await serveResult(problem, resultPage(timingbox(waveform()), {
    script: `let step = 0;
      setInterval(() => {
        const wire = document.querySelector('#svgcontent_0 g path');
        if (wire) wire.setAttribute('transform', 'translate(0,' + (step++ % 5) + ')');
      }, 200);`,
  }));
  await submit(problem, submittedSource);
  await expect(progress.getByText('Incorrect - not saved to GitHub', { exact: true })).toBeVisible();

  const attempt = await concludedAttempt(progress);
  expect(attempt.report?.diagrams).toBeUndefined();
  expect(attempt.report?.attribution).toBeUndefined();
  expect(attempt.report?.coverage).toEqual({
    statusLine: true, diagnosticMessages: false, timingDiagram: false,
    artifacts: 'deadline', rejected: ['deadline'],
  });
  expect(await storedImages(progress, attempt.id)).toBeNull();
  await expect(progress.getByText(
    'A timing diagram did not finish rendering within the observation window, so it was not captured.',
    { exact: true },
  )).toBeVisible();
  await expect(progress.getByText(
    'Not stored: A diagram was still changing when the observation window ended.', { exact: true },
  )).toBeVisible();
});

test('more charts than are stored per attempt are kept in order with the rest named as not stored', async ({
  progress, problem,
}) => {
  const charts = [0, 1, 2, 3, 4]
    .map(index => timingbox(waveform({ id: String(index), offset: index * 4 }), index)).join('');
  await serveResult(problem, resultPage(charts));
  await submit(problem, submittedSource);
  await expect(progress.getByText('Incorrect - not saved to GitHub', { exact: true })).toBeVisible();

  const attempt = await concludedAttempt(progress);
  const diagrams = attempt.report?.diagrams ?? [];
  expect(diagrams.map(diagram => diagram.name))
    .toEqual(['diagram-1.png', 'diagram-2.png', 'diagram-3.png', 'diagram-4.png']);
  expect(new Set(diagrams.map(diagram => diagram.hash)).size).toBe(4);
  expect(attempt.report?.coverage).toEqual({
    statusLine: true, diagnosticMessages: false, timingDiagram: true, artifacts: 'partial', rejected: ['limit'],
  });
  const held = await storedImages(progress, attempt.id);
  expect(held).toHaveLength(4);
  for (const [index, diagram] of diagrams.entries()) {
    const bytes = Buffer.from(held?.[index]?.data ?? '', 'base64');
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(diagram.hash);
    expect(countColour(decodePng(bytes), BLUE)).toBeGreaterThan(400);
  }
  await expect(progress.getByText('4 timing diagrams stored; 1 not stored.', { exact: true })).toBeVisible();
  await expect(progress.getByText(
    'Not stored: More diagrams were present, or more image bytes, than are stored per attempt.', { exact: true },
  )).toBeVisible();
});

test('a chart larger than the supported size is named as not stored', async ({ progress, problem }) => {
  await serveResult(problem, resultPage(timingbox(waveform({ width: 5000, height: 120 }))));
  await submit(problem, submittedSource);
  await expect(progress.getByText('Incorrect - not saved to GitHub', { exact: true })).toBeVisible();

  const attempt = await concludedAttempt(progress);
  expect(attempt.report?.diagrams).toBeUndefined();
  expect(attempt.report?.coverage).toEqual({
    statusLine: true, diagnosticMessages: false, timingDiagram: false,
    artifacts: 'rejected', rejected: ['unsupported'],
  });
  expect(await storedImages(progress, attempt.id)).toBeNull();
  await expect(progress.getByText(
    'A timing diagram was present but none of it could be stored safely.', { exact: true },
  )).toBeVisible();
  await expect(progress.getByText(
    'Not stored: A diagram used an unsupported structure.', { exact: true },
  )).toBeVisible();
});

const HOSTILE = 'HOSTILE_PAYLOAD_MARKER';
const hostileChart = `<svg id="svgcontent_0" width="360" height="120" viewBox="0 0 360 120">
  <style>@import url("https://hdlbits.01xz.net/evidence.css");</style>
  <script>window.__marker = '${HOSTILE}';</script>
  <defs><g id="lane_0"><path class="wire" d="M0,0 L60,0 L60,-20 L140,-20 L140,0 L200,0"/></g></defs>
  <image href="https://hdlbits.01xz.net/evidence.png" x="0" y="0" width="360" height="120"/>
  <foreignObject x="0" y="0" width="360" height="120">
    <div xmlns="http://www.w3.org/1999/xhtml" style="width:360px;height:120px;background:#ff0000">${HOSTILE}</div>
  </foreignObject>
  <a href="javascript:void(0)"><rect x="0" y="0" width="360" height="24" fill="#00ff00"/></a>
  <g transform="translate(24,70)">
    <use href="#lane_0" x="20" y="0"/>
    <rect x="250" y="-12" width="60" height="24" fill="#0000ff" onload="window.__marker = '${HOSTILE}'"/>
    <text class="label" x="0" y="6">out</text>
  </g>
</svg>`;

test('a chart carrying external, scripted or embedded content is stored as its drawing only', async ({
  extensionContext, progress, problem,
}) => {
  const requested: string[] = [];
  extensionContext.on('request', request => { requested.push(request.url()); });
  await serveResult(problem, resultPage(timingbox(hostileChart)));
  await submit(problem, submittedSource);
  await expect(progress.getByText('Incorrect - not saved to GitHub', { exact: true })).toBeVisible();

  const attempt = await concludedAttempt(progress);
  expect(attempt.report?.diagrams).toHaveLength(1);
  expect(attempt.report?.coverage).toEqual({
    statusLine: true, diagnosticMessages: false, timingDiagram: true, artifacts: 'complete',
  });
  // Only the result page's own render asked for these; the capture added no request of its own.
  expect(requested.filter(url => url.endsWith('/evidence.png'))).toHaveLength(1);
  expect(requested.filter(url => url.endsWith('/evidence.css'))).toHaveLength(1);

  const held = await storedImages(progress, attempt.id);
  const image = decodePng(Buffer.from(held?.[0]?.data ?? '', 'base64'));
  expect([image.width, image.height]).toEqual([360, 120]);
  // The wire and the rect the page drew survive; the embedded document and the linked shape do not.
  expect(countColour(image, BLUE)).toBeGreaterThan(400);
  expect(countColour(image, RED)).toBe(0);
  expect(countColour(image, GREEN)).toBe(0);
  expect(JSON.stringify(attempt.report)).not.toContain(HOSTILE);
  await expect(progress.getByText(HOSTILE, { exact: false })).toHaveCount(0);
  expect(consoleOutput(extensionContext).join('\n')).not.toContain(HOSTILE);
});

test('a compile failure states its errors and that it drew no chart', async ({ progress, problem }) => {
  await serveResult(problem, resultPage(errorBlock));
  await submit(problem, submittedSource);
  await expect(progress.getByText('Incorrect - not saved to GitHub', { exact: true })).toBeVisible();

  const attempt = await concludedAttempt(progress);
  expect(attempt.report?.messages).toEqual(ERRORS.map(text => ({ severity: 'error', text })));
  expect(attempt.report?.coverage).toEqual({
    statusLine: true, diagnosticMessages: true, timingDiagram: false, artifacts: 'none',
  });
  // A result that drew nothing says so, rather than reading as a result whose diagrams are unsupported.
  await expect(progress.getByText('This result drew no timing diagram.', { exact: true })).toBeVisible();
  await expect(progress.getByText('Not stored:', { exact: false })).toHaveCount(0);
});

test('a worker restart during the artifact phase publishes once and states the chart was not captured', async ({
  extensionContext, progress, problem,
}) => {
  const { server, page } = await setup(extensionContext, progress);
  await setFailedPublication(page);
  await serveResult(problem, withTemplate(
    resultPage('<div class="timingbox" id="host"></div>', { script: DRAW_LATER(6000) }), waveform(),
  ));
  const started = Date.now();
  await submit(problem, submittedSource);
  await expect(progress.getByText('Incorrect - not saved to GitHub', { exact: true })).toBeVisible();

  // The document that was drawing cannot report to a worker that is gone, so the report concludes rather than
  // holding the recorded outcome back for ever.
  await restartExtensionWorker(extensionContext, progress, () => progress.reload());
  await expect(progress.getByText('Failed attempt saved to GitHub', { exact: true })).toBeVisible();
  const root = publishedRoot(server.files);
  const published = JSON.parse(server.files.get(`${root}/report.json`) ?? 'null') as StoredReport;
  expect(published.coverage).toEqual({
    statusLine: true, diagnosticMessages: false, timingDiagram: false, artifacts: 'deadline',
  });
  expect([...server.files.keys()].some(path => path.endsWith('.png'))).toBe(false);

  // The chart arrives after the receipt. It changes neither the committed report nor the commit count.
  await new Promise(resolve => setTimeout(resolve, Math.max(0, 9_000 - (Date.now() - started))));
  expect(server.updates).toBe(1);
  expect(server.requestsValid).toBe(true);
  const attempt = await concludedAttempt(progress);
  expect(attempt.report?.coverage.artifacts).toBe('deadline');
  expect(attempt.report?.diagrams).toBeUndefined();
});

test('a chart drawn in one tab belongs only to that tab report', async ({ extensionContext, progress, problem }) => {
  await extensionContext.route('**/runsim.php', route => {
    const drawn = (route.request().postData() ?? '').includes('// With a chart');
    return route.fulfill({
      contentType: 'text/html',
      body: resultPage(drawn ? `${warningBlock}${timingbox(waveform())}` : ''),
    });
  });
  const second = await extensionContext.newPage();
  await second.goto('https://hdlbits.01xz.net/wiki/Step_one');
  await submit(problem, `// With a chart\n${submittedSource}`);
  await submit(second, `// Without a chart\n${submittedSource}`);
  await expect(progress.getByText('Incorrect - not saved to GitHub', { exact: true })).toHaveCount(2);

  const drawn = await concludedAttempt(progress, '// With a chart');
  const plain = await concludedAttempt(progress, '// Without a chart');
  expect(drawn.id).not.toBe(plain.id);
  expect(drawn.report?.diagrams).toHaveLength(1);
  expect(drawn.report?.messages).toHaveLength(2);
  expect(plain.report?.diagrams).toBeUndefined();
  expect(plain.report?.messages).toEqual([]);
  expect(plain.report?.coverage).toEqual({
    statusLine: true, diagnosticMessages: false, timingDiagram: false, artifacts: 'none',
  });
  expect(await storedImages(progress, plain.id)).toBeNull();
  expect(await storedImages(progress, drawn.id)).toHaveLength(1);
  await second.close();
});

const ATTEMPT_ID = '44444444-4444-4444-8444-444444444444';
const OBSERVED_AT = '2026-01-01T00:00:01.000Z';
const PUBLISHED_IMAGE = buildPng(120, 40, BLUE);

// A published failed record exactly as this extension writes one, including the image its report names.
function savedRecord(changes: { image?: Buffer | null } = {}): Map<string, string> {
  const root = `progress/hdlbits/step_one/failed-${ATTEMPT_ID}`;
  const report = JSON.stringify({
    schemaVersion: 1, kind: 'report', provider: 'hdlbits', problemId: 'step_one', attemptId: ATTEMPT_ID,
    outcome: 'incorrect', observedAt: OBSERVED_AT, status: 'Status: Incorrect', messages: [],
    diagrams: [{
      name: 'diagram-1.png', mediaType: 'image/png', width: 120, height: 40,
      byteLength: PUBLISHED_IMAGE.length, hash: createHash('sha256').update(PUBLISHED_IMAGE).digest('hex'),
    }],
    attribution: {
      provider: 'HDLBits', problemUrl: PROBLEM_URL, notice: 'HDLBits does not endorse this extension.',
    },
    coverage: { statusLine: true, diagnosticMessages: false, timingDiagram: true, artifacts: 'complete' },
    provenance: { capture: 'browser-post', origin: 'https://hdlbits.01xz.net' },
  }, null, 2) + '\n';
  const files = new Map([
    [`${root}/solution.v`, submittedBytes],
    [`${root}/report.json`, report],
    [`${root}/attempt.json`, JSON.stringify({
      schemaVersion: 1, kind: 'failed', accepted: false, provider: 'hdlbits', problemId: 'step_one',
      attemptId: ATTEMPT_ID, outcome: 'incorrect',
      sourceHash: createHash('sha256').update(submittedBytes, 'utf8').digest('hex'),
      sourceBytes: Buffer.byteLength(submittedBytes, 'utf8'),
      submittedAt: '2026-01-01T00:00:00.000Z', observedAt: OBSERVED_AT,
      reportHash: createHash('sha256').update(report, 'utf8').digest('hex'),
      reportBytes: Buffer.byteLength(report, 'utf8'),
      provenance: { capture: 'browser-post', verdict: 'incorrect', origin: 'https://hdlbits.01xz.net' },
    }, null, 2) + '\n'],
  ]);
  const image = changes.image === undefined ? PUBLISHED_IMAGE : changes.image;
  if (image !== null) files.set(`${root}/diagram-1.png`, image.toString('latin1'));
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
  await expect(destination.getByRole('status'))
    .toHaveText(/^Verified destination: fixture-user\/progress-solutions @ /);
  return remote;
}

test('a published chart is read back from GitHub only as the bytes the report names', async ({
  extensionContext, progress,
}) => {
  const remote = await readSaved(extensionContext, progress, savedRecord());
  await expect(progress.locator('#recovery-status'))
    .toHaveText('0 recorded accepted; 1 recorded failed; 0 imported unverified; 0 unverified saved entries.');
  await expect(progress.getByText('Recorded failed attempt from GitHub - not accepted', { exact: true }))
    .toBeVisible();
  await expect(progress.getByText('1 timing diagram stored; 0 not stored.', { exact: true })).toBeVisible();
  const hash = createHash('sha256').update(PUBLISHED_IMAGE).digest('hex');
  await expect(progress.getByText(`diagram-1.png (120x40, SHA-256 ${hash})`, { exact: true })).toBeVisible();
  // Nothing is read from GitHub until the record's own image is asked for.
  await expect(progress.locator('figure img')).toHaveCount(0);

  await progress.getByRole('button', { name: 'Show diagram-1.png' }).click();
  const picture = progress.locator('figure img');
  await expect(picture).toHaveAttribute('alt', 'Timing diagram 1 captured for step_one');
  const source = await picture.getAttribute('src') ?? '';
  expect(Buffer.from(source.slice(IMAGE_PREFIX.length), 'base64').equals(PUBLISHED_IMAGE)).toBe(true);
  await expect(progress.getByText('Rendered by HDLBits from this submission', { exact: true })).toBeVisible();
  expect(remote.writes).toBe(0);
});

for (const scenario of [
  {
    name: 'no image file at all', files: savedRecord({ image: null }),
    message: 'The submission report names a timing diagram image that is not stored with it.',
  },
  {
    name: 'an image of a different size than the report states',
    files: savedRecord({ image: buildPng(60, 20, RED) }),
    message: 'A stored timing diagram image does not match the byte count, path, or file type the report states.',
  },
]) {
  test(`a published record with ${scenario.name} stays explicitly unverified`, async ({
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

test('a published image whose bytes were changed after publication is refused, not rendered', async ({
  extensionContext, progress,
}) => {
  await readSaved(extensionContext, progress, savedRecord({ image: corruptPng(PUBLISHED_IMAGE) }));
  // The file is the size and path the report states, so the record still reads back; only its bytes are wrong.
  await expect(progress.getByText('Recorded failed attempt from GitHub - not accepted', { exact: true }))
    .toBeVisible();
  await progress.getByRole('button', { name: 'Show diagram-1.png' }).click();
  await expect(progress.getByText(
    'The published image could not be read, or its bytes do not match the report that names it.'
    + ' Nothing was rendered.', { exact: true },
  )).toBeVisible();
  await expect(progress.locator('figure img')).toHaveCount(0);
});
