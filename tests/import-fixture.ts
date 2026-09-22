import { expect, type BrowserContext, type Page } from '@playwright/test';
import type { Browser } from 'wxt/browser';

declare const chrome: typeof Browser;

const IMPORT_TABS_KEY = 'import-pages-v1';
const origin = 'https://hdlbits.01xz.net';

export interface StoredSubmission {
  submissionId: string;
  recordedAt?: number;
  entries?: string;
  status?: number;
  source?: string;
  loadStatus?: number;
  loadType?: string;
  loadBody?: string;
}

// One row of the learner's own statistics table: original synthetic markup, not a copy of the site's page.
export interface StatsRow {
  problemId: string;
  successes: number;
  failures?: number;
  href?: string;
}

export interface ImportFixture {
  // Problem ids the currently served pages badge as solved.
  solved: string[];
  stored: Map<string, StoredSubmission | null>;
  missingPages: Set<string>;
  pageReads: string[];
  // null serves the statistics page as unavailable, so discovery falls back to the navigation list.
  stats: StatsRow[] | null;
  statsMarkup: string | null;
  statsStatus: number;
  statsReads: number;
  loads: Array<{ problemId: string; submissionId: string }>;
  credentialHeaders: string[];
  loadGate: Promise<void> | null;
  onLoad: ((problemId: string) => void | Promise<void>) | null;
}

// The provider's own recorded time for a stored success, in seconds, as its page literal carries it.
export const successRecordedAt = 1767322800;
export const successLabel = `Last success: ${new Date(successRecordedAt * 1000).toISOString()}`;
export const importedSource = "module top_module(output one);\nassign one = 1'b1;\nendmodule\n";
export const editorTemplate = '// Starter template. Not a stored submission.\n';

function escape(value: string): string {
  return value.replace(/[&<>"]/g, character =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[character] ?? character);
}

// A representative statistics page: a header row naming its columns, a rate column that must not be mistaken
// for the success count, and one row per problem the learner attempted.
function statsPage(rows: StatsRow[]): string {
  const body = rows.map(row => {
    const attempts = row.successes + (row.failures ?? 0);
    const rate = attempts === 0 ? '0%' : `${Math.round((row.successes / attempts) * 100)}%`;
    const href = row.href ?? `/wiki/${escape(row.problemId)}`;
    return `<tr><td><a href="${escape(href)}">${escape(row.problemId)}</a></td>`
      + `<td>${attempts}</td><td>${row.successes}</td><td>${row.failures ?? 0}</td><td>${rate}</td></tr>`;
  }).join('');
  return `<!doctype html>
<html lang="en"><head><title>Statistics - HDLBits</title></head><body>
  <h1>Your statistics</h1>
  <table id="summary"><tr><th>Account</th><th>Joined</th></tr><tr><td>fixture-learner</td><td>2026-01-01</td></tr></table>
  <table id="per-problem">
    <thead><tr><th>Problem</th><th>Attempts</th><th>Successes</th><th>Failures</th><th>Success rate</th></tr></thead>
    <tbody>${body}</tbody>
  </table>
</body></html>`;
}

function page(problemId: string, server: ImportFixture): string {
  const stored = server.stored.get(problemId);
  // The site serves the load control empty and fills it from this literal, so the fixture does the same.
  const success = stored?.entries ?? (stored
    ? `['${stored.submissionId}','Last success',${stored.recordedAt ?? successRecordedAt}]`
    : "[null,'Last success',null]");
  const navigation = server.solved.map(id =>
    `<li><a href="/wiki/${escape(id)}">${escape(id)}<span class="hdlbits-stat-done">&#10003;</span></a></li>`).join('');
  return `<!doctype html>
<html lang="en"><head><title>${escape(problemId)} - HDLBits</title></head><body>
  <h1>${escape(problemId)}</h1>
  <span id="historical-status">Solved</span>
  <ul id="nav">${navigation}</ul>
  <form id="codeform" action="/runsim.php" method="post" enctype="multipart/form-data" target="compile_iframe">
    <label for="codesubmitbox">Solution</label>
    <textarea id="codesubmitbox" name="vlgcode_box">${escape(editorTemplate)}</textarea>
    <input type="hidden" name="tc" value="${escape(problemId)}">
    <button id="submitiframe" type="button">Submit</button>
  </form>
  <select id="uiload_select"><option value="" disabled selected>[Load a previous submission]</option></select>
  <button id="uiload_load" type="button">Load</button>
  <script type="text/javascript">
    (function(){;
      var d = [ ${success},['7000','Last non-success',${successRecordedAt + 7200}] ];
      var s = document.getElementById("uiload_select");
      for (var i=0;i<d.length;i++) {
        var o = document.createElement("option");
        var t;
        if (d[i][2] === null) {
          t=d[i][1] + ": none";
          o.disabled = true;
        } else {
          t=d[i][1] + ": " + new Date(d[i][2]*1000).toLocaleString();
        }
        o.appendChild(document.createTextNode(t));
        o.value = d[i][0];
        s.appendChild(o);
      }
    })();
  </script>
  <iframe id="compile_iframe" name="compile_iframe" title="Grading result"></iframe>
  <script>
    document.querySelector('#submitiframe').addEventListener('click', () => {
      document.querySelector('#codeform').submit();
    });
  </script>
</body></html>`;
}

// Registered after the shared provider routes so it owns problem pages and /load.php.
export async function importFixture(context: BrowserContext, stored: Record<string, StoredSubmission | null>) {
  const server: ImportFixture = {
    solved: Object.keys(stored),
    stored: new Map(Object.entries(stored)),
    missingPages: new Set(),
    pageReads: [],
    stats: null,
    statsMarkup: null,
    statsStatus: 200,
    statsReads: 0,
    loads: [],
    credentialHeaders: [],
    loadGate: null,
    onLoad: null,
  };

  await context.route(`${origin}/**`, async route => {
    const request = route.request();
    const url = new URL(request.url());
    const headers = await request.allHeaders();
    if (headers.authorization) server.credentialHeaders.push(headers.authorization);
    if (url.pathname === '/load.php') {
      if (request.method() !== 'POST') return route.fulfill({ status: 405, body: 'Method not allowed' });
      const fields = new URLSearchParams(request.postData() ?? '');
      const problemId = fields.get('tc') ?? '';
      const submissionId = fields.get('name') ?? '';
      server.loads.push({ problemId, submissionId });
      await server.onLoad?.(problemId);
      if (server.loadGate) await server.loadGate;
      const entry = server.stored.get(problemId);
      if (!entry || entry.submissionId !== submissionId) {
        return route.fulfill({ status: 404, contentType: 'application/json', body: '{"status":0,"data":""}' });
      }
      return route.fulfill({
        status: entry.loadStatus ?? 200,
        contentType: entry.loadType ?? 'application/json; charset=utf-8',
        // The site's own handler reads data only for status 2.
        body: entry.loadBody ?? JSON.stringify({ status: entry.status ?? 2, data: entry.source ?? importedSource }),
      });
    }
    if (url.pathname === '/wiki/Special:VlgStats/Me') {
      server.statsReads++;
      const markup = server.statsMarkup ?? (server.stats === null ? null : statsPage(server.stats));
      if (markup === null || server.statsStatus !== 200) {
        return route.fulfill({ status: server.statsStatus === 200 ? 404 : server.statsStatus, body: 'Not found' });
      }
      return route.fulfill({ contentType: 'text/html', body: markup });
    }
    if (!url.pathname.startsWith('/wiki/')) return route.fallback();
    const problemId = decodeURIComponent(url.pathname.slice('/wiki/'.length)).toLowerCase();
    server.pageReads.push(problemId);
    if (server.missingPages.has(problemId)) return route.fulfill({ status: 404, body: 'Not found' });
    return route.fulfill({ contentType: 'text/html', body: page(problemId, server) });
  });
  return server;
}

export async function openProblemPage(context: BrowserContext, problemId = 'step_one'): Promise<Page> {
  const page = await context.newPage();
  await page.goto(`${origin}/wiki/${problemId}`);
  await page.locator('#uiload_select').waitFor();
  return page;
}

// Discovery only addresses pages that announced themselves, so wait for that before clicking.
export async function importPages(progress: Page, count: number): Promise<void> {
  await expect.poll(async () => {
    const stored = await progress.evaluate(key => chrome.storage.session.get(key), IMPORT_TABS_KEY);
    const pages: unknown = stored[IMPORT_TABS_KEY];
    return Array.isArray(pages) ? pages.length : 0;
  }).toBe(count);
}
