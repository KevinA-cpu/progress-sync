import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { chromium, expect, test } from '@playwright/test';
import { IMPORT_PAGE_FETCH } from '../lib/constants/import';
import { sameProblemPage } from '../lib/import/page';

const SITE = 'https://hdlbits.01xz.net';
const problemPage = '<!doctype html><html lang="en"><body><select id="uiload_select"></select></body></html>';

interface Route { status: number; location?: string; body?: string }

async function serve(
  routes: (path: string) => Route, shared = false,
): Promise<{ origin: string; close: () => Promise<void> }> {
  const server: Server = createServer((request, response) => {
    const route = routes(request.url ?? '/');
    // A server that would share across origins keeps the mode, not the server, as what refuses the hop.
    const allowed = shared ? { 'access-control-allow-origin': '*' } : {};
    response.writeHead(route.status, route.location
      ? { location: route.location, ...allowed }
      : { 'content-type': 'text/html; charset=utf-8', ...allowed });
    response.end(route.body ?? '');
  });
  await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', resolve); });
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>(resolve => {
      server.closeAllConnections();
      server.close(() => { resolve(); });
    }),
  };
}

// Whatever a redirect chain does on the way, content is only read as the problem that was asked for.
test('the final URL of a page read decides which problem it came from', () => {
  expect(IMPORT_PAGE_FETCH).toEqual({
    credentials: 'same-origin', mode: 'same-origin', redirect: 'follow', cache: 'no-store',
  });
  for (const url of [`${SITE}/wiki/zero`, `${SITE}/wiki/Zero`, `${SITE}/wiki/%5Aero`, `${SITE}/wiki/zero?print=1`]) {
    expect(sameProblemPage(url, 'zero')).toBe(true);
  }
  for (const url of [
    `${SITE}/wiki/zero2`, `${SITE}/wiki/mux2to1`, `${SITE}/wiki/zero/history`, `${SITE}/index.php?title=zero`,
    'http://hdlbits.01xz.net/wiki/zero', 'https://hdlbits.01xz.net.example.com/wiki/zero',
    'https://example.com/wiki/zero', `${SITE}/wiki/%zz`, '/wiki/zero', 'not a url',
  ]) {
    expect(sameProblemPage(url, 'zero')).toBe(false);
  }
});

// Two local servers stand in for the site and for anywhere else, so the browser's own redirect handling
// under these exact request options is what is measured.
test('a page read survives case canonicalization and fails outright on a hop off the origin', async () => {
  const elsewhere = await serve(path =>
    path === '/wiki/away' ? { status: 200, body: problemPage } : { status: 404 }, true);
  const site = await serve(path => {
    if (path === '/wiki/zero') return { status: 301, location: '/wiki/Zero' };
    if (path === '/wiki/away') return { status: 301, location: `${elsewhere.origin}/wiki/away` };
    if (path === '/wiki/sibling') return { status: 301, location: '/wiki/Mux2to1' };
    if (path === '/wiki/Zero' || path === '/wiki/Mux2to1') return { status: 200, body: problemPage };
    return { status: 404 };
  });
  const browser = await chromium.launch({ channel: 'chromium', headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(`${site.origin}/wiki/Zero`);
    const reads = await page.evaluate(async options => {
      const read = async (path: string, init: RequestInit) => {
        try {
          const response = await fetch(path, init);
          return { ok: response.ok, url: response.url, failed: '' };
        } catch (error) {
          return { ok: false, url: '', failed: error instanceof Error ? error.name : 'unknown' };
        }
      };
      return {
        canonical: await read('/wiki/zero', options),
        external: await read('/wiki/away', options),
        shared: await read('/wiki/away', { ...options, mode: 'cors' }),
        sibling: await read('/wiki/sibling', options),
      };
    }, { ...IMPORT_PAGE_FETCH });

    expect(reads.canonical).toEqual({ ok: true, url: `${site.origin}/wiki/Zero`, failed: '' });
    // Same-origin mode makes the hop itself a network error: no content arrives to be checked.
    expect(reads.external).toEqual({ ok: false, url: '', failed: 'TypeError' });
    // The same hop under a sharing mode does deliver, so the mode is what refused it above.
    expect(reads.shared).toEqual({ ok: true, url: `${elsewhere.origin}/wiki/away`, failed: '' });
    // A same-origin hop to another problem does deliver a page, so only the final URL check rejects it.
    expect(reads.sibling).toEqual({ ok: true, url: `${site.origin}/wiki/Mux2to1`, failed: '' });

    // The same final URLs as the adapter would see them, against the problem it asked for.
    const asSite = (url: string) => url.replace(site.origin, SITE);
    expect(sameProblemPage(asSite(reads.canonical.url), 'zero')).toBe(true);
    expect(sameProblemPage(asSite(reads.sibling.url), 'zero')).toBe(false);
  } finally {
    await browser.close();
    await site.close();
    await elsewhere.close();
  }
});
