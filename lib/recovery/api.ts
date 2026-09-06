import { z } from '../schema';
import { DELIVERY_PATH, GIT_MODE, GIT_OBJECT, GIT_RECURSIVE, deliveryPaths, deliveryRoot } from '../constants/delivery';
import { MAX_SOURCE_BYTES } from '../constants/progress';
import {
  MAX_METADATA_BYTES, RECOVERY_ENCODING, RECOVERY_ENTRY, RECOVERY_ISSUE, RECOVERY_SOURCE_SUFFIX, RECOVERY_TEXT,
} from '../constants/recovery';
import { destinationApi } from '../destination/api';
import type { DestinationTarget } from '../destination/schemas';
import { githubRest } from '../github/rest';
import type { ConnectedSession } from '../github/schemas';
import { acceptanceRecordSchema, gitCommitSchema } from '../delivery/schemas';
import { hashSource, submittedSourceSchema } from '../progress';
import {
  parseRecovery, RecoveryFault, remoteBlobSchema, remotePathSchema, remoteTreeSchema,
  type RecoveredEntry, type RecoveryIssue, type RemoteTreeEntry,
} from './schemas';

class InvalidRemoteFile extends Error {}

export async function recoverProgress(
  target: DestinationTarget, session: ConnectedSession, guard: () => Promise<void>, signal: AbortSignal,
) {
  const destination = destinationApi(session, guard, signal);
  const octokit = githubRest(session.token, signal);
  const repo = { owner: target.owner, repo: target.name };
  async function request<T>(operation: () => Promise<{ data: unknown }>, schema: z.ZodType<T>): Promise<T> {
    await guard();
    const response = await operation();
    await guard();
    return parseRecovery(response.data, schema);
  }
  const branch = await destination.verify(target);
  const commit = await request(() => octokit.rest.git.getCommit({ ...repo, commit_sha: branch.commit.sha }), gitCommitSchema);
  if (commit.sha !== branch.commit.sha) throw new RecoveryFault(RECOVERY_TEXT.incomplete);
  async function readTree(sha: string, recursive: boolean) {
    const tree = await request(() => octokit.rest.git.getTree({
      ...repo, tree_sha: sha, ...(recursive ? { recursive: GIT_RECURSIVE } : {}),
    }), remoteTreeSchema);
    if (tree.sha !== sha) throw new RecoveryFault(RECOVERY_TEXT.incomplete);
    return tree;
  }
  async function allEntries(): Promise<RemoteTreeEntry[]> {
    const recursive = await readTree(commit.tree.sha, true);
    if (!recursive.truncated) return recursive.tree;
    const result: RemoteTreeEntry[] = [];
    const pending: { sha: string; prefix: string; ancestors: string[] }[] = [
      { sha: commit.tree.sha, prefix: '', ancestors: [] },
    ];
    while (true) {
      const next = pending.pop();
      if (!next) return result;
      const tree = await readTree(next.sha, false);
      if (tree.truncated) throw new RecoveryFault(RECOVERY_TEXT.incomplete);
      for (const entry of tree.tree) {
        if (entry.path.includes('/')) throw new RecoveryFault(RECOVERY_TEXT.incomplete);
        const path = parseRecovery(next.prefix + entry.path, remotePathSchema);
        if (entry.type === GIT_OBJECT.tree) {
          if (entry.sha === next.sha || next.ancestors.includes(entry.sha)) throw new RecoveryFault(RECOVERY_TEXT.incomplete);
          pending.push({ sha: entry.sha, prefix: `${path}/`, ancestors: [...next.ancestors, next.sha] });
        } else {
          result.push({ ...entry, path });
        }
      }
    }
  }
  const files = new Map((await allEntries()).filter(entry => entry.type !== GIT_OBJECT.tree).map(entry => [entry.path, entry]));

  async function text(entry: RemoteTreeEntry, limit: number): Promise<string> {
    if (entry.type !== GIT_OBJECT.blob || entry.mode !== GIT_MODE.file || (entry.size !== undefined && entry.size > limit)) {
      throw new InvalidRemoteFile();
    }
    await guard();
    const response = await octokit.rest.git.getBlob({ ...repo, file_sha: entry.sha });
    await guard();
    const parsed = remoteBlobSchema.safeParse(response.data);
    if (!parsed.success || parsed.data.sha !== entry.sha || parsed.data.size > limit) throw new InvalidRemoteFile();
    try {
      const bytes = Uint8Array.from(atob(parsed.data.content.replace(/\s/g, '')), character => character.charCodeAt(0));
      if (bytes.length !== parsed.data.size || bytes.length > limit) throw new InvalidRemoteFile();
      return new TextDecoder(RECOVERY_ENCODING, { fatal: true, ignoreBOM: true }).decode(bytes);
    } catch (error) {
      if (error instanceof InvalidRemoteFile || error instanceof DOMException || error instanceof TypeError) {
        throw new InvalidRemoteFile();
      }
      throw error;
    }
  }
  async function readSource(entry: RemoteTreeEntry | undefined): Promise<{ source: string | null; issue: RecoveryIssue | null }> {
    if (!entry) return { source: null, issue: RECOVERY_ISSUE.sourceMissing };
    try {
      const parsed = submittedSourceSchema.safeParse(await text(entry, MAX_SOURCE_BYTES));
      return parsed.success ? { source: parsed.data, issue: null } : { source: null, issue: RECOVERY_ISSUE.sourceInvalid };
    } catch (error) {
      if (!(error instanceof InvalidRemoteFile)) throw error;
      return { source: null, issue: RECOVERY_ISSUE.sourceInvalid };
    }
  }
  const entries: RecoveredEntry[] = [];
  const consumed = new Set<string>();
  const metadataFiles = [...files.values()].filter(entry =>
    entry.path.startsWith(`${DELIVERY_PATH.root}/`) && entry.path.endsWith(`/${DELIVERY_PATH.metadata}`));
  for (const file of metadataFiles) {
    const root = file.path.slice(0, -(DELIVERY_PATH.metadata.length + 1));
    const sourcePath = deliveryPaths(root).source;
    consumed.add(sourcePath);
    const recovered = await readSource(files.get(sourcePath));
    const source = recovered.source;
    let issue = recovered.issue;
    let raw: unknown;
    try {
      raw = JSON.parse(await text(file, MAX_METADATA_BYTES));
    } catch (error) {
      if (!(error instanceof InvalidRemoteFile) && !(error instanceof SyntaxError)) throw error;
      issue = RECOVERY_ISSUE.metadataInvalid;
    }
    const metadata = acceptanceRecordSchema.safeParse(raw);
    if (!metadata.success) issue = RECOVERY_ISSUE.metadataInvalid;
    else if (root !== deliveryRoot(metadata.data.provider, metadata.data.problemId, metadata.data.attemptId)
      || Date.parse(metadata.data.observedAt) < Date.parse(metadata.data.submittedAt)) {
      issue = RECOVERY_ISSUE.identityMismatch;
    } else if (source !== null && await hashSource(source) !== metadata.data.sourceHash) {
      issue = RECOVERY_ISSUE.hashMismatch;
    }
    if (!issue && source !== null && metadata.success) {
      entries.push({ state: RECOVERY_ENTRY.recorded, path: file.path, source, metadata: metadata.data });
    } else {
      entries.push({
        state: RECOVERY_ENTRY.unverified, path: file.path, source, issue: issue ?? RECOVERY_ISSUE.metadataInvalid,
      });
    }
  }
  for (const file of files.values()) {
    if (!file.path.toLowerCase().endsWith(RECOVERY_SOURCE_SUFFIX) || consumed.has(file.path)) continue;
    const recovered = await readSource(file);
    entries.push({
      state: RECOVERY_ENTRY.unverified, path: file.path,
      source: recovered.source, issue: recovered.issue ?? RECOVERY_ISSUE.metadataMissing,
    });
  }
  await guard();
  return {
    commitSha: commit.sha, recoveredAt: new Date().toISOString(),
    entries: entries.sort((left, right) => left.path.localeCompare(right.path)),
  };
}
