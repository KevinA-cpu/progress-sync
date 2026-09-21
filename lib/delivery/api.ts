import { z } from '../schema';
import {
  DELIVERY_TEXT, GIT_BLOB_HASH_ALGORITHM, GIT_MODE, GIT_OBJECT, GIT_RECURSIVE, MAX_METADATA_BYTES, MAX_PUBLICATION_REBASES,
  deliveryPaths, deliveryRef, deliveryRoot,
} from '../constants/delivery';
import { GRADING_VERDICT, HDL_ORIGIN } from '../constants/progress';
import { IMPORT_PROVENANCE, IMPORT_TEXT, importPaths, importRoot } from '../constants/import';
import { importJobId, importRecordId, importRecordSchema, type ImportRecord } from '../import/schemas';
import { hashSource, sourceByteLength } from '../progress';
import { GITHUB_COMPARISON, GITHUB_HTTP_STATUS, GITHUB_PAGINATION } from '../constants/github';
import { destinationApi } from '../destination/api';
import { githubRest } from '../github/rest';
import { githubWrite, GithubWriteRejected } from '../github/errors';
import { decodeGitBlob, InvalidRemoteFile } from '../github/blob';
import type { ConnectedSession } from '../github/schemas';
import {
  acceptanceRecordSchema, DeliveryBlocked, DeliveryFault, gitCommitSchema, gitComparisonSchema, gitObjectSchema,
  gitRefSchema, gitTreeSchema, isImportedSnapshot, metadataBlobSchema, pathCommitsSchema, parseDelivery,
  type DeliveryJob, type PublicationCandidate,
} from './schemas';

type GitTree = z.infer<typeof gitTreeSchema>;
type GitCommit = z.infer<typeof gitCommitSchema>;
interface PublicationHooks {
  beforeWrite(): Promise<void>;
  prepared(candidate: PublicationCandidate): Promise<void>;
}
class PublicationConflict extends DeliveryFault {
  constructor(readonly baseCommitSha: string, readonly rejection: GithubWriteRejected | null = null) {
    super(DELIVERY_TEXT.headChanged);
  }
}

async function blobSha(content: string): Promise<string> {
  const encoder = new TextEncoder();
  // Git object IDs hash a byte-length header as well as the exact UTF-8 payload.
  const bytes = encoder.encode(`blob ${encoder.encode(content).length}\0${content}`);
  const digest = await crypto.subtle.digest(GIT_BLOB_HASH_ALGORITHM, bytes);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

// An import publishes under its own root, its own record shape, and a commit message that never claims acceptance.
function importedPublication(job: DeliveryJob) {
  const snapshot = job.snapshot;
  if (!isImportedSnapshot(snapshot)) return null;
  const root = importRoot(snapshot.provider, snapshot.problemId, snapshot.submissionId, snapshot.sourceHash);
  return {
    root, paths: importPaths(root), schema: importRecordSchema,
    message: IMPORT_TEXT.commitMessage(snapshot.provider, snapshot.problemId, snapshot.submissionId),
    metadata: importRecordSchema.parse({
      schemaVersion: 1, kind: snapshot.kind, provider: snapshot.provider, problemId: snapshot.problemId,
      submissionId: snapshot.submissionId, recordId: snapshot.recordId, importId: job.id, claim: snapshot.claim,
      verified: false, sourceHash: snapshot.sourceHash, sourceBytes: snapshot.sourceBytes,
      providerLabel: snapshot.providerLabel, providerStatus: snapshot.providerStatus,
      discoveredAt: snapshot.discoveredAt,
      provenance: { capture: IMPORT_PROVENANCE, origin: HDL_ORIGIN },
    }),
  };
}

function acceptedPublication(job: DeliveryJob) {
  const snapshot = job.snapshot;
  if (isImportedSnapshot(snapshot)) throw new DeliveryFault(DELIVERY_TEXT.invalidAttempt);
  const root = deliveryRoot(snapshot.provider, snapshot.problemId, job.id);
  return {
    root, paths: deliveryPaths(root), schema: acceptanceRecordSchema,
    message: DELIVERY_TEXT.commitMessage(snapshot.provider, snapshot.problemId, job.id),
    metadata: acceptanceRecordSchema.parse({
      schemaVersion: 1, provider: snapshot.provider, problemId: snapshot.problemId, attemptId: job.id,
      sourceHash: snapshot.sourceHash, submittedAt: snapshot.submittedAt, observedAt: snapshot.observedAt,
      provenance: { capture: snapshot.provenance.capture, verdict: GRADING_VERDICT.success },
    }),
  };
}

async function publicationFiles(
  plan: {
    root: string; paths: { source: string; metadata: string }; metadata: unknown;
    schema: z.ZodType<unknown>; message: string;
  },
  source: string,
) {
  const entries = [
    { path: plan.paths.source, mode: GIT_MODE.file, type: GIT_OBJECT.blob, content: source },
    {
      path: plan.paths.metadata, mode: GIT_MODE.file, type: GIT_OBJECT.blob,
      content: JSON.stringify(plan.metadata, null, 2) + '\n',
    },
  ];
  const objects = await Promise.all(entries.map(async entry => ({
    path: entry.path, mode: entry.mode, type: entry.type, sha: await blobSha(entry.content),
  })));
  return { ...plan, entries, objects };
}

async function expectedPublication(job: DeliveryJob) {
  const { snapshot } = job;
  const plan = importedPublication(job) ?? acceptedPublication(job);
  if (isImportedSnapshot(snapshot)) {
    // Source hash, derived identity, byte count, and destination binding are proven before anything is written.
    if (await hashSource(snapshot.source) !== snapshot.sourceHash
      || await importRecordId(snapshot) !== snapshot.recordId
      || sourceByteLength(snapshot.source) !== snapshot.sourceBytes
      || await importJobId(snapshot.recordId, job.target) !== job.id) {
      throw new DeliveryFault(IMPORT_TEXT.invalidImport);
    }
  }
  return publicationFiles({ ...plan, schema: plan.schema as z.ZodType<unknown> }, snapshot.source);
}
type ExpectedPublication = Awaited<ReturnType<typeof expectedPublication>>;

// Rediscovery in another browser produces the same bytes with a later timestamp and possibly a new label.
// Only those two may differ; the first published record stays authoritative and is never rewritten.
function sameImportIdentity(remote: ImportRecord, expected: ImportRecord): boolean {
  const identity = (record: ImportRecord) =>
    JSON.stringify({ ...record, discoveredAt: '', providerLabel: '' });
  return identity(remote) === identity(expected);
}

async function adoptImportedRecord(
  graph: ReturnType<typeof publicationGraph>, expected: ExpectedPublication, tree: GitTree, source: string,
): Promise<ExpectedPublication> {
  const entry = tree.tree.find(item => item.path === expected.paths.metadata);
  const current = importRecordSchema.safeParse(expected.metadata);
  if (!entry || !current.success || entry.type !== GIT_OBJECT.blob || entry.mode !== GIT_MODE.file
    || entry.sha === expected.objects[1]?.sha) return expected;
  const blob = await graph.call(
    () => graph.octokit.rest.git.getBlob({ ...graph.repo, file_sha: entry.sha }), metadataBlobSchema,
  );
  if (blob.sha !== entry.sha) throw new DeliveryFault(DELIVERY_TEXT.invalidResponse);
  let remote: unknown;
  try {
    remote = JSON.parse(decodeGitBlob(blob.content, blob.size, MAX_METADATA_BYTES));
  } catch (error) {
    if (error instanceof InvalidRemoteFile || error instanceof SyntaxError) return expected;
    throw error;
  }
  const parsed = importRecordSchema.safeParse(remote);
  if (!parsed.success || !sameImportIdentity(parsed.data, current.data)) return expected;
  const adopted = await publicationFiles({ ...expected, metadata: parsed.data }, source);
  // Adoption must reproduce the stored file exactly; anything else stays a blocked collision.
  return adopted.objects[1]?.sha === entry.sha ? adopted : expected;
}

function hasAttemptPath(tree: GitTree, expected: ExpectedPublication): boolean {
  return tree.tree.some(entry => entry.path === expected.root || entry.path.startsWith(`${expected.root}/`)
    || (expected.root.startsWith(`${entry.path}/`) && (entry.type !== GIT_OBJECT.tree || entry.mode !== GIT_MODE.tree)));
}
function isExpectedMutation(base: GitTree, proposed: GitTree, publication: ExpectedPublication): boolean {
  if (hasAttemptPath(base, publication)) return false;
  const expected = new Map(base.tree.map(entry => [entry.path, entry]));
  for (const entry of publication.objects) expected.set(entry.path, entry);
  const parents = new Set(publication.root.split('/').map((_, index, parts) => parts.slice(0, index + 1).join('/')));
  for (const entry of proposed.tree) {
    if (parents.has(entry.path)) {
      if (entry.type !== GIT_OBJECT.tree || entry.mode !== GIT_MODE.tree) return false;
      expected.delete(entry.path);
      continue;
    }
    const original = expected.get(entry.path);
    if (!original || entry.type !== original.type || entry.mode !== original.mode || entry.sha !== original.sha) {
      return false;
    }
    expected.delete(entry.path);
  }
  return expected.size === 0;
}

function hasNextPage(header: unknown): boolean {
  const link = parseDelivery(header, z.string().max(GITHUB_PAGINATION.maxLinkHeaderLength).optional());
  if (link === undefined) return false;
  let next = false;
  for (const item of link.split(/,\s*(?=<)/)) {
    const match = /^\s*<[^<>]+>\s*;\s*rel="([^"]+)"\s*$/.exec(item);
    if (!match?.[1]) throw new DeliveryFault(DELIVERY_TEXT.invalidResponse);
    next ||= match[1].split(/\s+/).includes(GITHUB_PAGINATION.nextRelation);
  }
  return next;
}

function publicationGraph(job: DeliveryJob, session: ConnectedSession, guard: () => Promise<void>, signal: AbortSignal) {
  const octokit = githubRest(session.token, signal);
  const destination = destinationApi(session, guard, signal);
  const repo = { owner: job.target.owner, repo: job.target.name };
  const commits = new Map<string, GitCommit>();
  const trees = new Map<string, GitTree>();
  async function call<T>(operation: () => Promise<{ data: unknown }>, schema: z.ZodType<T>): Promise<T> {
    await guard();
    const response = await operation();
    await guard();
    return parseDelivery(response.data, schema);
  }
  async function commit(sha: string) {
    const cached = commits.get(sha);
    if (cached) {
      await guard();
      return cached;
    }
    const result = await call(() => octokit.rest.git.getCommit({ ...repo, commit_sha: sha }), gitCommitSchema);
    if (result.sha !== sha) throw new DeliveryFault(DELIVERY_TEXT.invalidResponse);
    commits.set(sha, result);
    return result;
  }
  async function tree(sha: string) {
    const cached = trees.get(sha);
    if (cached) {
      await guard();
      return cached;
    }
    const result = await call(() => octokit.rest.git.getTree({
      ...repo, tree_sha: sha, recursive: GIT_RECURSIVE,
    }), gitTreeSchema);
    if (result.sha !== sha) throw new DeliveryFault(DELIVERY_TEXT.invalidResponse);
    trees.set(sha, result);
    return result;
  }
  async function update(candidate: PublicationCandidate) {
    const ref = await call(() => githubWrite(() => octokit.rest.git.updateRef({
      ...repo, ref: deliveryRef(job.target.branch), sha: candidate.commitSha, force: false,
    })), gitRefSchema).catch((error: unknown) => {
      if (error instanceof GithubWriteRejected && (error.status === GITHUB_HTTP_STATUS.conflict
        || error.status === GITHUB_HTTP_STATUS.unprocessableEntity)) {
        throw new PublicationConflict(candidate.baseCommitSha, error);
      }
      throw error;
    });
    if (ref.ref !== `refs/${deliveryRef(job.target.branch)}` || ref.object.sha !== candidate.commitSha) {
      throw new DeliveryFault(DELIVERY_TEXT.invalidResponse);
    }
    return { commitSha: candidate.commitSha, treeSha: candidate.treeSha, confirmedAt: new Date().toISOString() };
  }
  async function ancestor(base: string, head: string): Promise<boolean> {
    if (base === head) return true;
    const comparison = await call(() => octokit.rest.repos.compareCommits({ ...repo, base, head }), gitComparisonSchema);
    if (comparison.base_commit.sha !== base) throw new DeliveryFault(DELIVERY_TEXT.invalidResponse);
    return comparison.status === GITHUB_COMPARISON.ahead && comparison.merge_base_commit.sha === base;
  }
  async function history(head: string, path: string, page: number) {
    await guard();
    const response = await octokit.rest.repos.listCommits({
      ...repo, sha: head, path, page, per_page: GITHUB_PAGINATION.pageSize,
    });
    await guard();
    const commits = parseDelivery(response.data, pathCommitsSchema);
    const next = hasNextPage(response.headers.link);
    if (next && commits.length === 0) throw new DeliveryFault(DELIVERY_TEXT.invalidResponse);
    return { commits, next };
  }
  async function complete(tree: GitTree, expected: ExpectedPublication): Promise<boolean> {
    const source = tree.tree.find(entry => entry.path === expected.paths.source);
    const metadata = tree.tree.find(entry => entry.path === expected.paths.metadata);
    if (!source || !metadata || source.type !== GIT_OBJECT.blob || source.mode !== GIT_MODE.file
      || metadata.type !== GIT_OBJECT.blob || metadata.mode !== GIT_MODE.file
      || source.sha !== expected.objects[0]?.sha) return false;
    if (metadata.sha === expected.objects[1]?.sha) return true;
    const blob = await call(() => octokit.rest.git.getBlob({ ...repo, file_sha: metadata.sha }), metadataBlobSchema);
    if (blob.sha !== metadata.sha) throw new DeliveryFault(DELIVERY_TEXT.invalidResponse);
    try {
      const parsed = expected.schema.safeParse(JSON.parse(decodeGitBlob(blob.content, blob.size, MAX_METADATA_BYTES)));
      return parsed.success && JSON.stringify(parsed.data) === JSON.stringify(expected.metadata);
    } catch (error) {
      if (error instanceof InvalidRemoteFile || error instanceof SyntaxError) return false;
      throw error;
    }
  }
  return { octokit, destination, repo, call, commit, tree, update, ancestor, history, complete };
}

async function verifyCandidate(
  graph: ReturnType<typeof publicationGraph>, candidate: PublicationCandidate, expected: ExpectedPublication,
) {
  const commit = await graph.commit(candidate.commitSha);
  if (commit.tree.sha !== candidate.treeSha || commit.parents.length !== 1
    || commit.parents[0]?.sha !== candidate.baseCommitSha) throw new DeliveryBlocked(DELIVERY_TEXT.invalidData);
  const base = await graph.commit(candidate.baseCommitSha);
  const tree = await graph.tree(candidate.treeSha);
  if (!isExpectedMutation(await graph.tree(base.tree.sha), tree, expected)) throw new DeliveryBlocked(DELIVERY_TEXT.invalidData);
  return commit;
}

async function publishAtHead(
  graph: ReturnType<typeof publicationGraph>,
  plan: { job: DeliveryJob; expected: ExpectedPublication; base: GitCommit; tree: GitTree },
  guard: () => Promise<void>, hooks: PublicationHooks,
) {
  const { job, expected, base, tree } = plan;
  if (hasAttemptPath(tree, expected)) throw new DeliveryFault(DELIVERY_TEXT.existingPath);
  await guard();
  await hooks.beforeWrite();
  const createdTree = await graph.call(() => githubWrite(() => graph.octokit.rest.git.createTree({
    ...graph.repo, base_tree: base.tree.sha, tree: expected.entries,
  })), gitObjectSchema);
  const proposed = await graph.tree(createdTree.sha);
  if (!isExpectedMutation(tree, proposed, expected)) throw new DeliveryFault(DELIVERY_TEXT.invalidResponse);
  const commit = await graph.call(() => githubWrite(() => graph.octokit.rest.git.createCommit({
    ...graph.repo, tree: createdTree.sha, parents: [base.sha], message: expected.message,
  })), gitCommitSchema);
  if (commit.tree.sha !== createdTree.sha || commit.parents.length !== 1 || commit.parents[0]?.sha !== base.sha) {
    throw new DeliveryFault(DELIVERY_TEXT.invalidResponse);
  }
  const candidate = { baseCommitSha: base.sha, treeSha: createdTree.sha, commitSha: commit.sha };
  await guard();
  await hooks.prepared(candidate);
  const latest = await graph.destination.branch(job.target.name, job.target.branch);
  if (latest.commit.sha !== base.sha) throw new PublicationConflict(base.sha);
  return graph.update(candidate);
}

export async function publishAttempt(
  job: DeliveryJob, session: ConnectedSession, guard: () => Promise<void>, signal: AbortSignal, hooks: PublicationHooks,
) {
  return deliverAttempt(job, session, guard, signal, hooks, false);
}

async function originalPublication(
  graph: ReturnType<typeof publicationGraph>, expected: ExpectedPublication, head: string,
) {
  const seen = new Set<string>();
  let original: GitCommit | null = null;
  for (let page = 1; page <= GITHUB_PAGINATION.maxPages; page++) {
    const result = await graph.history(head, expected.paths.metadata, page);
    for (const item of result.commits) {
      if (seen.has(item.sha)) throw new DeliveryFault(DELIVERY_TEXT.invalidResponse);
      seen.add(item.sha);
      const commit = await graph.commit(item.sha);
      if (commit.message?.trimEnd() !== expected.message
        || commit.parents.length !== 1 || !commit.parents[0]) continue;
      const parent = await graph.commit(commit.parents[0].sha);
      if (!isExpectedMutation(await graph.tree(parent.tree.sha), await graph.tree(commit.tree.sha), expected)) continue;
      if (!await graph.ancestor(commit.sha, head)) throw new DeliveryFault(DELIVERY_TEXT.invalidResponse);
      if (!original || await graph.ancestor(commit.sha, original.sha)) original = commit;
      else if (!await graph.ancestor(original.sha, commit.sha)) throw new DeliveryBlocked(DELIVERY_TEXT.receiptUnavailable);
    }
    if (!result.next) return original;
  }
  throw new DeliveryBlocked(DELIVERY_TEXT.receiptUnavailable);
}

async function hasAttemptHistory(
  graph: ReturnType<typeof publicationGraph>, expected: ExpectedPublication, head: string,
): Promise<boolean> {
  const history = await graph.history(head, expected.root, 1);
  return history.commits.length !== 0;
}

export async function reconcileAttempt(
  job: DeliveryJob, session: ConnectedSession, guard: () => Promise<void>, signal: AbortSignal, hooks: PublicationHooks,
) {
  return deliverAttempt(job, session, guard, signal, hooks, true);
}

async function deliverAttempt(
  job: DeliveryJob, session: ConnectedSession, guard: () => Promise<void>, signal: AbortSignal,
  hooks: PublicationHooks, reconcile: boolean,
) {
  const graph = publicationGraph(job, session, guard, signal);
  const imported = isImportedSnapshot(job.snapshot);
  let expected = await expectedPublication(job);
  let candidate = job.candidate;
  let conflict: PublicationConflict | null = null;
  let rebases = 0;
  const checkpointHooks: PublicationHooks = {
    beforeWrite: hooks.beforeWrite,
    async prepared(prepared) {
      await hooks.prepared(prepared);
      candidate = prepared;
    },
  };
  while (true) {
    const branch = await graph.destination.verify(job.target);
    const head = await graph.commit(branch.commit.sha);
    const tree = await graph.tree(head.tree.sha);
    if (imported) expected = await adoptImportedRecord(graph, expected, tree, job.snapshot.source);
    // The same import rediscovered in another browser finds its own record already published and adopts it.
    const existing = imported && hasAttemptPath(tree, expected);
    if (conflict) {
      // A 409/422 alone can also mean branch policy or validation failure, not a race.
      if (head.sha === conflict.baseCommitSha) {
        throw conflict.rejection ?? new DeliveryBlocked(DELIVERY_TEXT.headChanged);
      }
      if (!await graph.ancestor(conflict.baseCommitSha, head.sha)) {
        throw new DeliveryBlocked(DELIVERY_TEXT.historyChanged);
      }
    }
    if (reconcile || conflict || existing) {
      if (await graph.complete(tree, expected)) {
        let original: GitCommit | null = null;
        if (candidate) {
          const prepared = await verifyCandidate(graph, candidate, expected);
          if (await graph.ancestor(prepared.sha, head.sha)) original = prepared;
        }
        original ??= await originalPublication(graph, expected, head.sha);
        if (!original) throw new DeliveryBlocked(DELIVERY_TEXT.receiptUnavailable);
        await guard();
        return { commitSha: original.sha, treeSha: original.tree.sha, confirmedAt: new Date().toISOString() };
      }
      if (hasAttemptPath(tree, expected)) throw new DeliveryBlocked(DELIVERY_TEXT.existingPath);
      if (!candidate && await hasAttemptHistory(graph, expected, head.sha)) {
        throw new DeliveryBlocked(candidate === undefined ? DELIVERY_TEXT.legacyUncertain : DELIVERY_TEXT.historyChanged);
      }
      if (candidate) {
        await verifyCandidate(graph, candidate, expected);
        if (head.sha !== candidate.baseCommitSha) {
          // An absent record is not permission to resurrect a remotely removed attempt.
          if (!await graph.ancestor(candidate.baseCommitSha, head.sha)
            || await graph.ancestor(candidate.commitSha, head.sha)
            || await hasAttemptHistory(graph, expected, head.sha)) {
            throw new DeliveryBlocked(DELIVERY_TEXT.historyChanged);
          }
          if (rebases >= MAX_PUBLICATION_REBASES) throw new DeliveryBlocked(DELIVERY_TEXT.conflictLimit);
          rebases++;
        }
      }
    }
    try {
      if (candidate && candidate.baseCommitSha === head.sha) {
        await guard();
        await hooks.beforeWrite();
        return await graph.update(candidate);
      }
      return await publishAtHead(graph, { job, expected, base: head, tree }, guard, checkpointHooks);
    } catch (error) {
      if (!(error instanceof PublicationConflict)) throw error;
      conflict = error;
    }
  }
}
