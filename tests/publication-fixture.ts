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
const fileChangesSchema = z.record(pathSchema, z.string().nullable());
const metadataPathSegmentsSchema = z.tuple([
  z.literal('progress'), z.literal('hdlbits'), z.string().regex(/^[a-z0-9][a-z0-9_]{0,127}$/),
  z.uuid(), z.literal('acceptance.json'),
]);
const historyRequestSchema = z.strictObject({
  sha: shaSchema,
  path: pathSchema.refine(value => metadataPathSegmentsSchema.safeParse(value.split('/')).success),
  per_page: z.literal('100'),
  page: z.string().regex(/^[1-9][0-9]*$/).transform(Number).pipe(z.int().positive()),
});
const historyPageSizeSchema = z.int().min(1).max(100);
type Commit = z.infer<typeof commitSchema>;

interface PublicationFixture {
  head: string;
  files: Map<string, string>;
  writes: Array<{ method: string; path: string; body: unknown }>;
  reads: Array<{ path: string; page: number | null }>;
  updates: number;
  refCompletions: number;
  uniqueCommitIds: boolean;
  requestsValid: boolean;
  writeGate: Promise<void> | null;
  refGate: Promise<void> | null;
  failAt: WriteStage | null;
  failStatus: number;
  loseBeforeAt: WriteStage | null;
  loseResponseAt: WriteStage | null;
  historyPageSize: number | null;
  historyLinkUrl: string | null;
  advanceBeforeUpdate: boolean;
  onFirstWrite: (() => Promise<void>) | null;
  seedFiles(files: Record<string, string>): void;
  commitFiles(changes: Record<string, string | null>, message?: string): string;
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
  let commitSequence = 0;
  const server: PublicationFixture = {
    head: initialHead,
    files: new Map([
      ['README.md', 'Keep this learner file.\n'],
      ['.progress-sync.json', destination.markerContent || JSON.stringify({
        kind: 'progress-sync', schemaVersion: 1, initializationId: '12345678-1234-4234-8234-123456789abc',
      })],
    ]),
    writes: [],
    reads: [],
    updates: 0,
    refCompletions: 0,
    uniqueCommitIds: false,
    requestsValid: true,
    writeGate: null,
    refGate: null,
    failAt: null,
    failStatus: 403,
    loseBeforeAt: null,
    loseResponseAt: null,
    historyPageSize: null,
    historyLinkUrl: null,
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
    commitFiles(changes, message = 'Unrelated remote update') {
      const parsed = fileChangesSchema.safeParse(changes);
      if (!parsed.success) throw new Error('Invalid remote file change.');
      const parsedMessage = commitSchema.shape.message.safeParse(message);
      if (!parsedMessage.success) throw new Error('Invalid remote commit message.');
      if (!commits.has(server.head)) throw new Error('Remote commit parent is missing.');
      const files = new Map(server.files);
      for (const [path, content] of Object.entries(parsed.data)) {
        if (content === null) files.delete(path);
        else files.set(path, content);
      }
      if (hasFileDirectoryCollision(files)) throw new Error('Remote file conflicts with a directory.');
      startHistory();
      server.head = storeCommit(storeTree(files), server.head, parsedMessage.data);
      server.files = files;
      return server.head;
    },
  };

  function check(condition: unknown, detail: string): asserts condition {
    if (!condition) {
      server.requestsValid = false;
      throw new Error(`Unexpected publication fixture request: ${detail}`);
    }
  }

  function startHistory() {
    if (historyStarted) return;
    // Delay the initial snapshot so collision files can be seeded after onboarding.
    trees.set(initialTree, new Map(server.files));
    historyStarted = true;
  }

  function storeTree(files: ReadonlyMap<string, string>): string {
    const sha = hash(`tree\0${JSON.stringify([...files].sort(([left], [right]) => left.localeCompare(right)))}`);
    if (!trees.has(sha)) trees.set(sha, new Map(files));
    return sha;
  }

  function storeCommit(tree: string, parent: string, message: string): string {
    const commit: Commit = { tree, parents: [parent], message };
    const sha = hash(`commit\0${JSON.stringify(commit)}${server.uniqueCommitIds ? `\0${++commitSequence}` : ''}`);
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

  function historyCommitResponse(sha: string, commit: Commit) {
    const gitCommit = commitResponse(sha, commit);
    return {
      sha, url: `${api}/commits/${sha}`,
      html_url: `https://github.com/fixture-user/progress-solutions/commit/${sha}`,
      commit: {
        message: gitCommit.message, tree: gitCommit.tree, url: gitCommit.url,
        author: gitCommit.author, committer: gitCommit.committer,
      },
      parents: gitCommit.parents,
    };
  }

  function commitHistory(sha: string) {
    const history: Array<{ sha: string; commit: Commit }> = [];
    let current: string | undefined = sha;
    while (current) {
      const commit = commits.get(current);
      check(commit, 'History commit is missing');
      history.push({ sha: current, commit });
      current = commit.parents[0];
    }
    return history;
  }

  // Register after identity/onboarding fixtures; their routes still own the marker.
  await context.route('https://api.github.com/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    const path = decodeURIComponent(url.pathname);
    const branchPath = `${base}/branches/${destination.defaultBranch}`;
    const historyPath = path === `${base}/commits`;
    const comparePath = path === `${base}/compare` || path.startsWith(`${base}/compare/`);
    if (path !== branchPath && path !== `${base}/git` && !path.startsWith(`${base}/git/`)
      && !historyPath && !comparePath) {
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
    const compareMatch = /^\/compare\/([0-9a-f]{40})\.\.\.([0-9a-f]{40})$/.exec(path.slice(base.length));
    const stage: WriteStage | null = method === 'POST' && path === `${base}/git/trees` ? 'tree'
      : method === 'POST' && path === `${base}/git/commits` ? 'commit'
        : method === 'PATCH' && path === `${base}/git/refs/heads/${destination.defaultBranch}` ? 'ref' : null;
    check((method === 'GET' && (commitMatch || treeMatch || blobMatch || compareMatch || historyPath)) || stage,
      `${method} ${path}`);
    let historyQuery: z.infer<typeof historyRequestSchema> | null = null;
    if (historyPath) {
      const parsed = historyRequestSchema.safeParse(Object.fromEntries(url.searchParams));
      check(url.searchParams.size === 4 && parsed.success, `${method} ${path}: expected pinned path history`);
      historyQuery = parsed.data;
    } else if (treeMatch) {
      check(url.searchParams.size === 1 && ['1', 'true'].includes(url.searchParams.get('recursive') ?? ''),
        `${method} ${path}: expected recursive tree`);
    } else {
      check(url.search === '', `${method} ${path}: query parameters`);
    }
    if (method === 'GET') {
      check(request.postData() === null, `${method} ${path}: unexpected body`);
      server.reads.push({ path, page: historyQuery?.page ?? null });
    }
    if (!destination.exists || destination.empty) {
      return route.fulfill({ status: 404, json: { message: 'Not found' } });
    }
    startHistory();
    if (compareMatch) {
      const [, baseSha, headSha] = compareMatch;
      check(baseSha && headSha, 'Missing comparison SHA');
      const baseCommit = commits.get(baseSha);
      if (!baseCommit || !commits.has(headSha)) {
        return route.fulfill({ status: 404, json: { message: 'Not found' } });
      }
      const baseHistory = commitHistory(baseSha);
      const headHistory = commitHistory(headSha);
      const baseAncestors = new Set(baseHistory.map(entry => entry.sha));
      const mergeBase = headHistory.find(entry => baseAncestors.has(entry.sha));
      check(mergeBase, 'Comparison merge base is missing');
      const ahead = headHistory.findIndex(entry => entry.sha === mergeBase.sha);
      const behind = baseHistory.findIndex(entry => entry.sha === mergeBase.sha);
      const status = baseSha === headSha ? 'identical' : behind === 0 ? 'ahead' : ahead === 0 ? 'behind' : 'diverged';
      return route.fulfill({ json: {
        url: `${api}/compare/${baseSha}...${headSha}`, status,
        ahead_by: ahead, behind_by: behind, total_commits: ahead,
        base_commit: historyCommitResponse(baseSha, baseCommit),
        merge_base_commit: historyCommitResponse(mergeBase.sha, mergeBase.commit),
        commits: headHistory.slice(0, ahead).reverse().map(entry => historyCommitResponse(entry.sha, entry.commit)),
        files: [],
      } });
    }
    if (historyQuery) {
      if (!commits.has(historyQuery.sha)) {
        return route.fulfill({ status: 404, json: { message: 'Not found' } });
      }
      const metadataPath = historyQuery.path;
      const history = commitHistory(historyQuery.sha).filter(({ commit }, index, entries) => {
        const files = trees.get(commit.tree);
        check(files, 'History commit tree is missing');
        const parent = entries[index + 1];
        const parentFiles = parent ? trees.get(parent.commit.tree) : undefined;
        check(!parent || parentFiles, 'History parent tree is missing');
        return files.get(metadataPath) !== parentFiles?.get(metadataPath);
      });
      const pageSize = historyPageSizeSchema.safeParse(server.historyPageSize ?? 100);
      check(pageSize.success, 'Invalid history page size');
      const offset = (historyQuery.page - 1) * pageSize.data;
      const nextQuery = new URLSearchParams({
        sha: historyQuery.sha, path: metadataPath, per_page: '100', page: String(historyQuery.page + 1),
      });
      const nextUrl = server.historyLinkUrl ?? `${api}/commits?${nextQuery}`;
      return route.fulfill({
        headers: offset + pageSize.data < history.length ? { link: `<${nextUrl}>; rel="next"` } : {},
        json: history.slice(offset, offset + pageSize.data).map(entry => historyCommitResponse(entry.sha, entry.commit)),
      });
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
    const refGate = stage === 'ref' ? server.refGate : null;
    if (stage === 'ref') server.refGate = null;
    if (firstWrite) {
      await server.onFirstWrite?.();
      if (server.writeGate) await server.writeGate;
    }
    if (refGate) await refGate;
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
        if (server.loseBeforeAt === stage) return route.abort('failed');
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
        if (server.loseBeforeAt === stage) return route.abort('failed');
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
        if (server.loseBeforeAt === stage) return route.abort('failed');
        if (server.advanceBeforeUpdate) {
          server.advanceBeforeUpdate = false;
          server.commitFiles({ 'concurrent.txt': 'Another writer.\n' }, 'Unrelated concurrent update');
        }
        if (parsed.data.sha !== server.head) {
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
        }
        server.refCompletions++;
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
