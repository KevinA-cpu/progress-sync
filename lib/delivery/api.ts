import { z } from '../schema';
import {
  DELIVERY_TEXT, GIT_BLOB_HASH_ALGORITHM, GIT_MODE, GIT_OBJECT, GIT_RECURSIVE,
  deliveryPaths, deliveryRef, deliveryRoot,
} from '../constants/delivery';
import { GITHUB_PERMISSION } from '../constants/github';
import { GRADING_VERDICT } from '../constants/progress';
import { destinationApi } from '../destination/api';
import { DESTINATION_ISSUE } from '../constants/destination';
import { DestinationFault } from '../destination/schemas';
import { githubRest } from '../github/rest';
import type { ConnectedSession } from '../github/schemas';
import {
  acceptanceRecordSchema, DeliveryFault, gitCommitSchema, gitObjectSchema, gitRefSchema, gitTreeSchema,
  parseDelivery, type DeliveryJob,
} from './schemas';

async function blobSha(content: string): Promise<string> {
  const encoder = new TextEncoder();
  // Git object IDs hash a byte-length header as well as the exact UTF-8 payload.
  const bytes = encoder.encode(`blob ${encoder.encode(content).length}\0${content}`);
  const digest = await crypto.subtle.digest(GIT_BLOB_HASH_ALGORITHM, bytes);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

export async function publishAttempt(
  job: DeliveryJob, session: ConnectedSession, guard: () => Promise<void>, signal: AbortSignal,
  beforeWrite: () => Promise<void>,
) {
  const { target, snapshot } = job;
  const destination = destinationApi(session, guard, signal);
  const octokit = githubRest(session.token, signal);
  const repo = { owner: target.owner, repo: target.name };
  async function validatedCall<T>(operation: () => Promise<{ data: unknown }>, schema: z.ZodType<T>): Promise<T> {
    await guard();
    const response = await operation();
    await guard();
    return parseDelivery(response.data, schema);
  }
  await destination.identity();
  const installation = (await destination.installations()).find(item =>
    item.id === target.installationId && item.app_id === target.appId);
  if (!installation || installation.permissions.contents !== GITHUB_PERMISSION.write) {
    throw new DestinationFault(DESTINATION_ISSUE.permissionDenied);
  }
  const repository = await destination.repository(target.name);
  if (repository.id !== target.repositoryId) throw new DeliveryFault(DELIVERY_TEXT.sessionChanged);
  await destination.included(target.installationId, target.repositoryId);
  const branch = await destination.branch(target.name, target.branch);
  if (!await destination.marker(target.name, branch.commit.sha)) {
    throw new DestinationFault(DESTINATION_ISSUE.incompatibleRepository);
  }
  const base = await validatedCall(() => octokit.rest.git.getCommit({ ...repo, commit_sha: branch.commit.sha }), gitCommitSchema);
  if (base.sha !== branch.commit.sha) throw new DeliveryFault(DELIVERY_TEXT.invalidResponse);
  const tree = await validatedCall(() => octokit.rest.git.getTree({
    ...repo, tree_sha: base.tree.sha, recursive: GIT_RECURSIVE,
  }), gitTreeSchema);
  if (tree.sha !== base.tree.sha) throw new DeliveryFault(DELIVERY_TEXT.invalidResponse);
  const root = deliveryRoot(snapshot.provider, snapshot.problemId, job.id);
  for (const entry of tree.tree) {
    if (entry.path === root || entry.path.startsWith(`${root}/`)
      || (root.startsWith(`${entry.path}/`) && entry.type !== GIT_OBJECT.tree)) {
      throw new DeliveryFault(DELIVERY_TEXT.existingPath);
    }
  }
  const paths = deliveryPaths(root);
  const metadata = acceptanceRecordSchema.parse({
    schemaVersion: 1, provider: snapshot.provider, problemId: snapshot.problemId, attemptId: job.id,
    sourceHash: snapshot.sourceHash, submittedAt: snapshot.submittedAt, observedAt: snapshot.observedAt,
    provenance: { capture: snapshot.provenance.capture, verdict: GRADING_VERDICT.success },
  });
  const entries = [
    { path: paths.source, mode: GIT_MODE.file, type: GIT_OBJECT.blob, content: snapshot.source },
    { path: paths.metadata, mode: GIT_MODE.file, type: GIT_OBJECT.blob, content: JSON.stringify(metadata, null, 2) + '\n' },
  ];
  await guard();
  await beforeWrite();
  const createdTree = await validatedCall(() => octokit.rest.git.createTree({
    ...repo, base_tree: base.tree.sha,
    tree: entries,
  }), gitObjectSchema);
  const proposed = await validatedCall(() => octokit.rest.git.getTree({
    ...repo, tree_sha: createdTree.sha, recursive: GIT_RECURSIVE,
  }), gitTreeSchema);
  if (proposed.sha !== createdTree.sha) throw new DeliveryFault(DELIVERY_TEXT.invalidResponse);
  const expected = new Map(tree.tree.map(entry => [entry.path, entry]));
  for (const entry of entries) {
    expected.set(entry.path, { path: entry.path, mode: entry.mode, type: entry.type, sha: await blobSha(entry.content) });
  }
  const parents = new Set(root.split('/').map((_, index, parts) => parts.slice(0, index + 1).join('/')));
  for (const entry of proposed.tree) {
    if (parents.has(entry.path)) {
      if (entry.type !== GIT_OBJECT.tree || entry.mode !== GIT_MODE.tree) throw new DeliveryFault(DELIVERY_TEXT.invalidResponse);
      expected.delete(entry.path);
      continue;
    }
    const original = expected.get(entry.path);
    if (!original || entry.type !== original.type || entry.mode !== original.mode || entry.sha !== original.sha) {
      throw new DeliveryFault(DELIVERY_TEXT.invalidResponse);
    }
    expected.delete(entry.path);
  }
  if (expected.size !== 0) throw new DeliveryFault(DELIVERY_TEXT.invalidResponse);
  const commit = await validatedCall(() => octokit.rest.git.createCommit({
    ...repo, tree: createdTree.sha, parents: [base.sha],
    message: DELIVERY_TEXT.commitMessage(snapshot.provider, snapshot.problemId, job.id),
  }), gitCommitSchema);
  if (commit.tree.sha !== createdTree.sha || commit.parents.length !== 1 || commit.parents[0]?.sha !== base.sha) {
    throw new DeliveryFault(DELIVERY_TEXT.invalidResponse);
  }
  const latest = await destination.branch(target.name, target.branch);
  if (latest.commit.sha !== base.sha) throw new DeliveryFault(DELIVERY_TEXT.headChanged);
  const ref = await validatedCall(() => octokit.rest.git.updateRef({
    ...repo, ref: deliveryRef(target.branch), sha: commit.sha, force: false,
  }), gitRefSchema);
  if (ref.ref !== `refs/${deliveryRef(target.branch)}` || ref.object.sha !== commit.sha) {
    throw new DeliveryFault(DELIVERY_TEXT.invalidResponse);
  }
  return { commitSha: commit.sha, treeSha: createdTree.sha, confirmedAt: new Date().toISOString() };
}
