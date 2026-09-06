import { createHash } from 'node:crypto';
import type { BrowserContext } from '@playwright/test';
import { z } from 'zod';
import type { destinationFixture } from './destination-fixture';
import { ACCESS_TOKEN } from './github-fixture';

const base = '/repos/fixture-user/progress-solutions';
const api = `https://api.github.com${base}`;
const shaSchema = z.string().regex(/^[0-9a-f]{40}$/);
const pathSchema = z.string().refine(value => !/[\\\0]/.test(value)
  && value.split('/').every(part => part !== '' && part !== '.' && part !== '..'));
const recoveryInputSchema = z.strictObject({
  files: z.map(pathSchema, z.string()).readonly(),
  head: shaSchema.optional(),
});
const treeEntrySchema = z.discriminatedUnion('type', [
  z.strictObject({
    path: pathSchema, mode: z.literal('100644'), type: z.literal('blob'),
    sha: shaSchema, size: z.number().int().nonnegative(), url: z.url(),
  }),
  z.strictObject({
    path: pathSchema, mode: z.literal('040000'), type: z.literal('tree'),
    sha: shaSchema, url: z.url(),
  }),
]).readonly();
const treeEntriesSchema = z.array(treeEntrySchema).readonly();
const blobSchema = z.strictObject({
  sha: shaSchema, size: z.number().int().nonnegative(),
  encoding: z.literal('base64'), content: z.string(),
}).readonly();
const credentialsSchema = z.object({
  authorization: z.literal(`token ${ACCESS_TOKEN}`),
  cookie: z.never().optional(),
});
const writeMethodSchema = z.enum(['POST', 'PUT', 'PATCH', 'DELETE']);
const readRequestSchema = z.strictObject({
  method: z.literal('GET'), body: z.null(), query: z.tuple([]),
});
const treeReadRequestSchema = readRequestSchema.extend({
  query: z.union([
    z.tuple([]),
    z.tuple([z.tuple([z.literal('recursive'), z.literal('1')])]),
  ]),
});
const gitPathSchema = z.union([
  z.tuple([z.literal('commits'), shaSchema]),
  z.tuple([z.literal('trees'), shaSchema]),
  z.tuple([z.literal('blobs'), shaSchema]),
]);
const readSchema = z.strictObject({ path: z.string(), recursive: z.boolean() });
type RecoveryInput = z.infer<typeof recoveryInputSchema>;
type TreeEntry = z.infer<typeof treeEntrySchema>;
type TreeEntries = z.infer<typeof treeEntriesSchema>;
type Blob = z.infer<typeof blobSchema>;
type GitPath = z.infer<typeof gitPathSchema>;
type RecoveryRead = z.infer<typeof readSchema>;

interface RecoveryFixture {
  reads: RecoveryRead[];
  writes: number;
  requestsValid: boolean;
  truncateRecursive: boolean;
  truncateShallow: boolean;
  readGate: Promise<void> | null;
  failStatus: number | null;
}

export async function recoveryFixture(
  context: BrowserContext,
  destination: Awaited<ReturnType<typeof destinationFixture>>,
  input: RecoveryInput,
): Promise<RecoveryFixture> {
  const snapshot = recoveryInputSchema.parse(input);
  const files = new Map(snapshot.files);
  const head = snapshot.head ?? 'a'.repeat(40);
  const blobs = new Map<string, Blob>();
  const trees = new Map<string, TreeEntries>();
  for (const path of files.keys()) {
    const parts = path.split('/');
    if (parts.slice(0, -1).some((_, index) => files.has(parts.slice(0, index + 1).join('/')))) {
      throw new Error('Recovery file conflicts with a directory.');
    }
  }

  function storeTree(contents: ReadonlyMap<string, string>): string {
    const entries: TreeEntry[] = [];
    const directories = new Map<string, Map<string, string>>();
    for (const [path, content] of contents) {
      const separator = path.indexOf('/');
      if (separator !== -1) {
        const directory = path.slice(0, separator);
        const children = directories.get(directory) ?? new Map<string, string>();
        children.set(path.slice(separator + 1), content);
        directories.set(directory, children);
        continue;
      }
      const bytes = Buffer.from(content, 'utf8');
      const sha = createHash('sha1').update(`blob ${bytes.length}\0`, 'utf8').update(bytes).digest('hex');
      blobs.set(sha, blobSchema.parse({
        sha, size: bytes.length, encoding: 'base64', content: bytes.toString('base64'),
      }));
      entries.push({ path, mode: '100644', type: 'blob', sha, size: bytes.length, url: `${api}/git/blobs/${sha}` });
    }
    for (const [path, children] of directories) {
      const sha = storeTree(children);
      entries.push({ path, mode: '040000', type: 'tree', sha, url: `${api}/git/trees/${sha}` });
    }
    entries.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
    const tree = treeEntriesSchema.parse(entries);
    const sha = createHash('sha1').update(`tree\0${JSON.stringify(tree)}`, 'utf8').digest('hex');
    trees.set(sha, tree);
    return sha;
  }

  function descendants(sha: string, prefix = ''): TreeEntry[] {
    const entries = trees.get(sha);
    if (!entries) throw new Error('Recovery snapshot references an unknown tree.');
    const result: TreeEntry[] = [];
    for (const entry of entries) {
      const path = `${prefix}${entry.path}`;
      result.push({ ...entry, path });
      switch (entry.type) {
        case 'blob':
          break;
        case 'tree':
          result.push(...descendants(entry.sha, `${path}/`));
          break;
      }
    }
    return result;
  }

  const root = storeTree(files);
  const server: RecoveryFixture = {
    reads: [],
    writes: 0,
    requestsValid: true,
    truncateRecursive: false,
    truncateShallow: false,
    readGate: null,
    failStatus: null,
  };

  // Register last so onboarding keeps its own reads, but cannot write during recovery.
  await context.route('https://api.github.com/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    const reject = (detail: string) => {
      server.requestsValid = false;
      return route.fulfill({ status: 403, json: { message: `Unexpected recovery fixture request: ${detail}` } });
    };
    let path: string;
    try {
      path = decodeURIComponent(url.pathname);
    } catch {
      return reject('Invalid encoded path.');
    }
    if (path !== '/repos' && !path.startsWith('/repos/')) return route.fallback();
    if (path !== base && !path.startsWith(`${base}/`)) return reject('Unexpected repository.');
    const method = request.method();
    if (writeMethodSchema.safeParse(method).success) {
      server.writes++;
      return reject('Recovery is read-only.');
    }
    if (!credentialsSchema.safeParse(await request.allHeaders()).success) return reject('Invalid credentials.');

    const readRequest = { method, body: request.postData(), query: [...url.searchParams] };
    if (path === `${base}/branches/${destination.defaultBranch}`) {
      if (!readRequestSchema.safeParse(readRequest).success) return reject('Invalid branch read.');
      return route.fulfill({
        status: destination.exists && !destination.empty ? 200 : 404,
        json: destination.exists && !destination.empty
          ? { name: destination.defaultBranch, commit: { sha: head }, protected: false }
          : { message: 'Not found' },
      });
    }
    if (path !== `${base}/git` && !path.startsWith(`${base}/git/`)) return route.fallback();
    const parsed = gitPathSchema.safeParse(path.slice(`${base}/git/`.length).split('/'));
    if (!parsed.success) return reject('Unsupported Git path.');
    const [kind, sha]: GitPath = parsed.data;
    const schema = kind === 'trees' ? treeReadRequestSchema : readRequestSchema;
    if (!schema.safeParse(readRequest).success) return reject('Invalid Git read.');

    const recursive = kind === 'trees' && url.searchParams.get('recursive') === '1';
    server.reads.push({ path, recursive });
    if (server.readGate) await server.readGate;
    if (server.failStatus !== null) {
      return route.fulfill({ status: server.failStatus, json: { message: 'SYNTHETIC_PRIVATE_DIAGNOSTIC' } });
    }
    if (!destination.exists || destination.empty) {
      return route.fulfill({ status: 404, json: { message: 'Not found' } });
    }
    switch (kind) {
      case 'commits':
        return route.fulfill({
          status: sha === head ? 200 : 404,
          json: sha === head
            ? { sha, url: `${api}/git/commits/${sha}`, tree: { sha: root, url: `${api}/git/trees/${root}` }, parents: [] }
            : { message: 'Not found' },
        });
      case 'trees': {
        const tree = trees.get(sha);
        if (!tree) return route.fulfill({ status: 404, json: { message: 'Not found' } });
        const entries = recursive ? descendants(sha) : tree;
        const truncated = recursive ? server.truncateRecursive : server.truncateShallow;
        return route.fulfill({
          json: {
            sha, url: `${api}/git/trees/${sha}`, truncated,
            tree: truncated ? entries.slice(0, 1) : entries,
          },
        });
      }
      case 'blobs': {
        const blob = blobs.get(sha);
        return route.fulfill({
          status: blob ? 200 : 404, json: blob ?? { message: 'Not found' },
        });
      }
    }
  });
  return server;
}
