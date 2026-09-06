import { createHash } from 'node:crypto';
import type { BrowserContext } from '@playwright/test';
import { z } from 'zod';
import type { destinationFixture } from './destination-fixture';
import { ACCESS_TOKEN } from './github-fixture';

type WriteStage = 'tree' | 'commit' | 'ref';
const shaSchema = z.string().regex(/^[0-9a-f]{40}$/);
const pathSchema = z.string().refine(value => !/[\\\0]/.test(value)
  && value.split('/').every(part => part !== '' && part !== '.' && part !== '..'));
const inlineEntrySchema = z.strictObject({
  path: pathSchema, mode: z.literal('100644'), type: z.literal('blob'), content: z.string(),
});
const treeRequestSchema = z.strictObject({
  base_tree: shaSchema, tree: z.array(z.unknown()),
});
const inlineEntriesSchema = z.tuple([inlineEntrySchema, inlineEntrySchema])
  .refine(([first, second]) => first.path !== second.path);
const commitSchema = z.strictObject({
  tree: shaSchema,
  parents: z.array(shaSchema).max(1).readonly(),
  message: z.string().refine(value => value.trim().length > 0),
});
const commitRequestSchema = commitSchema.extend({ parents: z.tuple([shaSchema]) });
const refRequestSchema = z.strictObject({ sha: shaSchema, force: z.literal(false) });
const seedFilesSchema = z.record(pathSchema, z.string());
type Commit = z.infer<typeof commitSchema>;

interface PublicationFixture {
  head: string;
  files: Map<string, string>;
  writes: Array<{ method: string; path: string; body: unknown }>;
  updates: number;
  requestsValid: boolean;
  writeGate: Promise<void> | null;
  failAt: WriteStage | null;
  failStatus: number;
  loseResponseAt: WriteStage | null;
  advanceBeforeUpdate: boolean;
  onFirstWrite: (() => Promise<void>) | null;
  seedFiles(files: Record<string, string>): void;
}

const base = '/repos/fixture-user/progress-solutions';
const api = `https://api.github.com${base}`;
const initialHead = 'a'.repeat(40);
const initialTree = 'b'.repeat(40);
const hash = (value: string) => createHash('sha1').update(value, 'utf8').digest('hex');
const blobHash = (content: string) => hash(`blob ${Buffer.byteLength(content, 'utf8')}\0${content}`);
const hasFileDirectoryCollision = (files: ReadonlyMap<string, string>) =>
  [...files.keys()].some(path => {
    const parts = path.split('/');
    return parts.slice(0, -1).some((_, index) => files.has(parts.slice(0, index + 1).join('/')));
  });

export async function publicationFixture(
  context: BrowserContext,
  destination: Awaited<ReturnType<typeof destinationFixture>>,
) {
  const trees = new Map<string, ReadonlyMap<string, string>>();
  const commits = new Map<string, Commit>([
    [initialHead, { tree: initialTree, parents: [], message: 'Initial learner files' }],
  ]);
  let historyStarted = false;
  const server: PublicationFixture = {
    head: initialHead,
    files: new Map([
      ['README.md', 'Keep this learner file.\n'],
      ['.progress-sync.json', destination.markerContent || JSON.stringify({
        kind: 'progress-sync', schemaVersion: 1, initializationId: '12345678-1234-4234-8234-123456789abc',
      })],
    ]),
    writes: [],
    updates: 0,
    requestsValid: true,
    writeGate: null,
    failAt: null,
    failStatus: 403,
    loseResponseAt: null,
    advanceBeforeUpdate: false,
    onFirstWrite: null,
    seedFiles(files) {
      if (historyStarted) throw new Error('Seed remote files before publication starts.');
      const parsed = seedFilesSchema.safeParse(files);
      if (!parsed.success) throw new Error('Invalid seeded remote file.');
      const seeded = new Map(server.files);
      for (const [path, content] of Object.entries(parsed.data)) {
        seeded.set(path, content);
      }
      if (hasFileDirectoryCollision(seeded)) throw new Error('Seeded file conflicts with a directory.');
      server.files = seeded;
    },
  };

  function check(condition: unknown, detail: string): asserts condition {
    if (!condition) {
      server.requestsValid = false;
      throw new Error(`Unexpected publication fixture request: ${detail}`);
    }
  }

  function storeTree(files: ReadonlyMap<string, string>): string {
    const sha = hash(`tree\0${JSON.stringify([...files].sort(([left], [right]) => left.localeCompare(right)))}`);
    if (!trees.has(sha)) trees.set(sha, new Map(files));
    return sha;
  }

  function storeCommit(tree: string, parent: string, message: string): string {
    const commit: Commit = { tree, parents: [parent], message };
    const sha = hash(`commit\0${JSON.stringify(commit)}`);
    if (!commits.has(sha)) commits.set(sha, commit);
    return sha;
  }

  function treeResponse(sha: string, files: ReadonlyMap<string, string>) {
    const directories = new Set<string>();
    const tree = [...files].map(([path, content]) => {
      const parts = path.split('/');
      for (let index = 1; index < parts.length; index++) directories.add(parts.slice(0, index).join('/'));
      const size = Buffer.byteLength(content, 'utf8');
      const blob = blobHash(content);
      return { path, mode: '100644', type: 'blob', sha: blob, size, url: `${api}/git/blobs/${blob}` };
    });
    const directoryEntries = [...directories].map(path => {
      const prefix = `${path}/`;
      const contents = new Map([...files]
        .filter(([file]) => file.startsWith(prefix))
        .map(([file, content]) => [file.slice(prefix.length), content]));
      const directory = storeTree(contents);
      return { path, mode: '040000', type: 'tree', sha: directory, url: `${api}/git/trees/${directory}` };
    });
    return {
      sha, url: `${api}/git/trees/${sha}`, truncated: false,
      tree: [...tree, ...directoryEntries].sort((left, right) => left.path.localeCompare(right.path)),
    };
  }

  function commitResponse(sha: string, commit: Commit) {
    const author = { name: 'Fixture Learner', email: 'fixture@example.invalid', date: '2026-01-01T00:00:00Z' };
    return {
      sha, url: `${api}/git/commits/${sha}`, message: commit.message,
      author, committer: author, tree: { sha: commit.tree, url: `${api}/git/trees/${commit.tree}` },
      parents: commit.parents.map(parent => ({ sha: parent, url: `${api}/git/commits/${parent}` })),
    };
  }

  // Register after identity/onboarding fixtures; their routes still own the marker.
  await context.route('https://api.github.com/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    const path = decodeURIComponent(url.pathname);
    const branchPath = `${base}/branches/${destination.defaultBranch}`;
    if (path !== branchPath && path !== `${base}/git` && !path.startsWith(`${base}/git/`)) {
      return route.fallback();
    }
    const method = request.method();
    const headers = await request.allHeaders();
    check(headers.authorization === `token ${ACCESS_TOKEN}` && !headers.cookie, `${method} ${path}: credentials`);
    if (path === branchPath) {
      check(method === 'GET' && url.search === '' && request.postData() === null, `${method} ${path}`);
      return route.fulfill({
        status: destination.exists && !destination.empty ? 200 : 404,
        json: destination.exists && !destination.empty
          ? { name: destination.defaultBranch, commit: { sha: server.head }, protected: false }
          : { message: 'Not found' },
      });
    }

    const commitMatch = /^\/git\/commits\/([0-9a-f]{40})$/.exec(path.slice(base.length));
    const treeMatch = /^\/git\/trees\/([0-9a-f]{40})$/.exec(path.slice(base.length));
    const blobMatch = /^\/git\/blobs\/([0-9a-f]{40})$/.exec(path.slice(base.length));
    const stage: WriteStage | null = method === 'POST' && path === `${base}/git/trees` ? 'tree'
      : method === 'POST' && path === `${base}/git/commits` ? 'commit'
        : method === 'PATCH' && path === `${base}/git/refs/heads/${destination.defaultBranch}` ? 'ref' : null;
    check((method === 'GET' && (commitMatch || treeMatch || blobMatch)) || stage, `${method} ${path}`);
    if (treeMatch) {
      check(url.searchParams.size === 1 && ['1', 'true'].includes(url.searchParams.get('recursive') ?? ''),
        `${method} ${path}: expected recursive tree`);
    } else {
      check(url.search === '', `${method} ${path}: query parameters`);
    }
    if (method === 'GET') check(request.postData() === null, `${method} ${path}: unexpected body`);
    if (!destination.exists || destination.empty) {
      return route.fulfill({ status: 404, json: { message: 'Not found' } });
    }
    if (!historyStarted) {
      // Delay the initial snapshot so collision files can be seeded after onboarding.
      trees.set(initialTree, new Map(server.files));
      historyStarted = true;
    }
    if (commitMatch) {
      const sha = commitMatch[1];
      check(sha, 'Missing commit SHA');
      const commit = commits.get(sha);
      return route.fulfill({
        status: commit ? 200 : 404, json: commit ? commitResponse(sha, commit) : { message: 'Not found' },
      });
    }
    if (treeMatch) {
      const sha = treeMatch[1];
      check(sha, 'Missing tree SHA');
      const files = trees.get(sha);
      return route.fulfill({
        status: files ? 200 : 404, json: files ? treeResponse(sha, files) : { message: 'Not found' },
      });
    }

    if (blobMatch) {
      const sha = blobMatch[1];
      for (const files of trees.values()) {
        for (const content of files.values()) {
          if (blobHash(content) === sha) {
            return route.fulfill({ json: {
              sha, size: Buffer.byteLength(content, 'utf8'),
              encoding: 'base64', content: Buffer.from(content, 'utf8').toString('base64'),
            } });
          }
        }
      }
      return route.fulfill({ status: 404, json: { message: 'Not found' } });
    }
    check(stage, `${method} ${path}: missing write stage`);
    let body: unknown;
    try {
      body = request.postDataJSON();
    } catch {
      check(false, `${method} ${path}: invalid JSON`);
    }
    const firstWrite = server.writes.length === 0;
    server.writes.push({ method, path, body });
    if (firstWrite) {
      await server.onFirstWrite?.();
      if (server.writeGate) await server.writeGate;
    }
    const invalid = (message: string) => {
      server.requestsValid = false;
      return route.fulfill({ status: 422, json: { message } });
    };
    const fail = () => route.fulfill({
      status: server.failStatus, json: { message: 'SYNTHETIC_PRIVATE_DIAGNOSTIC' },
    });
    check(z.looseObject({}).safeParse(body).success, `${method} ${path}: expected an object`);

    let response: unknown;
    switch (stage) {
      case 'tree': {
        const parsed = treeRequestSchema.safeParse(body);
        if (!parsed.success) return invalid('Expected a base tree and inline entries.');
        const entries = inlineEntriesSchema.safeParse(parsed.data.tree);
        if (!entries.success) {
          return invalid('Expected exactly two distinct UTF-8 file entries, without deletions.');
        }
        const baseFiles = trees.get(parsed.data.base_tree);
        if (!baseFiles) return invalid('Base tree does not exist.');
        const files = new Map(baseFiles);
        for (const entry of entries.data) files.set(entry.path, entry.content);
        if (hasFileDirectoryCollision(files)) return invalid('File conflicts with a directory.');
        if (server.failAt === stage) return fail();
        const sha = storeTree(files);
        response = treeResponse(sha, files);
        break;
      }
      case 'commit': {
        const parsed = commitRequestSchema.safeParse(body);
        if (!parsed.success) return invalid('Expected a message, tree, and exactly one parent.');
        const { tree, parents: [parent], message } = parsed.data;
        if (!commits.has(parent) || !trees.has(tree)) return invalid('Unknown tree or parent.');
        if (server.failAt === stage) return fail();
        const sha = storeCommit(tree, parent, message);
        const commit = commits.get(sha);
        check(commit, 'Created commit is missing');
        response = commitResponse(sha, commit);
        break;
      }
      case 'ref': {
        const parsed = refRequestSchema.safeParse(body);
        if (!parsed.success) return invalid('Expected a commit SHA and force: false.');
        if (server.failAt === stage) return fail();
        if (server.advanceBeforeUpdate) {
          server.advanceBeforeUpdate = false;
          const files = new Map(server.files);
          files.set('concurrent.txt', 'Another writer.\n');
          server.head = storeCommit(storeTree(files), server.head, 'Unrelated concurrent update');
          server.files = files;
        }
        const commit = commits.get(parsed.data.sha);
        if (!commit || commit.parents.length !== 1 || commit.parents[0] !== server.head) {
          return route.fulfill({ status: 422, json: { message: 'Update is not a fast forward' } });
        }
        const files = trees.get(commit.tree);
        check(files, 'Proposed commit tree is missing');
        if ([...server.files.keys()].some(file => !files.has(file))) return invalid('Publication cannot delete files.');
        server.head = parsed.data.sha;
        server.files = new Map(files);
        server.updates++;
        response = {
          ref: `refs/heads/${destination.defaultBranch}`, url: `${api}/git/refs/heads/${encodeURIComponent(destination.defaultBranch)}`,
          object: { type: 'commit', sha: server.head, url: `${api}/git/commits/${server.head}` },
        };
        break;
      }
    }
    if (server.loseResponseAt === stage) return route.abort('failed');
    return route.fulfill({ status: stage === 'ref' ? 200 : 201, json: response });
  });
  return server;
}
