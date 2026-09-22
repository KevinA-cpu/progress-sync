import { z } from '../schema';
import {
  DELIVERY_PATH, FAILED_PATH, GIT_MODE, GIT_OBJECT, GIT_RECURSIVE, MAX_METADATA_BYTES, RECORD_KIND, deliveryPaths,
  deliveryRoot, diagramPath, failedPaths, failedRoot, problemRecordRoot,
} from '../constants/delivery';
import { IMPORT_PATH, importPaths, importRoot } from '../constants/import';
import { GRADING_VERDICT, MAX_SOURCE_BYTES } from '../constants/progress';
import { MAX_REPORT_BYTES, REPORT_FILE } from '../constants/report';
import { decodeBase64, encodeBase64, hashBytes, readPng } from '../diagram';
import type { Diagram, DiagramImage } from '../report';
import {
  RECOVERY_ENTRY, RECOVERY_ISSUE, RECOVERY_SOURCE_SUFFIX, RECOVERY_TEXT,
} from '../constants/recovery';
import { destinationApi } from '../destination/api';
import type { DestinationTarget } from '../destination/schemas';
import { githubRest } from '../github/rest';
import { decodeGitBlob, InvalidRemoteFile } from '../github/blob';
import type { ConnectedSession } from '../github/schemas';
import {
  acceptanceRecordSchema, failedRecordSchema, gitCommitSchema, reportRecordSchema, type ReportRecord,
} from '../delivery/schemas';
import { importRecordId, importRecordSchema } from '../import/schemas';
import { hashSource, sourceByteLength, submittedSourceSchema } from '../progress';
import {
  parseRecovery, RecoveryFault, remoteBlobSchema, remoteFileSchema, remotePathSchema, remoteTreeSchema,
  type RecoveredEntry, type RecoveryIssue, type RemoteTreeEntry,
} from './schemas';

// One published image, read only when it is asked for. The bytes are accepted only if they are the exact ones
// the recovered report names: same length, same digest, and a PNG of the stated dimensions.
export async function recoverDiagramImage(
  target: DestinationTarget, session: ConnectedSession, guard: () => Promise<void>, signal: AbortSignal,
  request: { commitSha: string; root: string; diagram: Diagram },
): Promise<DiagramImage> {
  const octokit = githubRest(session.token, signal);
  await guard();
  const response = await octokit.rest.repos.getContent({
    owner: target.owner, repo: target.name, path: diagramPath(request.root, request.diagram.name),
    ref: request.commitSha,
  });
  await guard();
  const parsed = remoteFileSchema.safeParse(response.data);
  if (!parsed.success || parsed.data.size !== request.diagram.byteLength) {
    throw new RecoveryFault(RECOVERY_TEXT.imageUnavailable);
  }
  const bytes = decodeBase64(parsed.data.content.replace(/\s+/g, ''));
  const png = bytes ? readPng(bytes) : null;
  if (!bytes || !png || bytes.length !== request.diagram.byteLength || png.width !== request.diagram.width
    || png.height !== request.diagram.height || await hashBytes(bytes) !== request.diagram.hash) {
    throw new RecoveryFault(RECOVERY_TEXT.imageUnavailable);
  }
  await guard();
  return { name: request.diagram.name, data: encodeBase64(bytes) };
}

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
    return decodeGitBlob(parsed.data.content, parsed.data.size, limit);
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
  // A record names its report by hash and byte count, so only the exact published file is accepted, and only
  // when it describes the same attempt as the record that names it.
  async function readReport(
    path: string, reportHash: string, reportBytes: number,
    match: { provider: string; problemId: string; attemptId: string; outcome: string; observedAt: string },
  ): Promise<{ report: ReportRecord | null; issue: RecoveryIssue | null }> {
    const entry = files.get(path);
    if (!entry) return { report: null, issue: RECOVERY_ISSUE.reportMissing };
    try {
      const content = await text(entry, MAX_REPORT_BYTES);
      const parsed = reportRecordSchema.safeParse(JSON.parse(content));
      if (!parsed.success || await hashSource(content) !== reportHash || sourceByteLength(content) !== reportBytes
        || parsed.data.provider !== match.provider || parsed.data.problemId !== match.problemId
        || parsed.data.attemptId !== match.attemptId || parsed.data.outcome !== match.outcome
        || parsed.data.observedAt !== match.observedAt) {
        return { report: null, issue: RECOVERY_ISSUE.reportInvalid };
      }
      return { report: parsed.data, issue: null };
    } catch (error) {
      if (!(error instanceof InvalidRemoteFile) && !(error instanceof SyntaxError)) throw error;
      return { report: null, issue: RECOVERY_ISSUE.reportInvalid };
    }
  }
  // Every image a report names has to be stored beside it as a regular file of the size it states. The bytes
  // themselves are verified against the report when one is opened.
  function diagramIssue(root: string, report: ReportRecord): RecoveryIssue | null {
    let issue: RecoveryIssue | null = null;
    for (const diagram of report.diagrams ?? []) {
      const path = diagramPath(root, diagram.name);
      consumed.add(path);
      const entry = files.get(path);
      if (!entry) issue ??= RECOVERY_ISSUE.diagramMissing;
      else if (entry.type !== GIT_OBJECT.blob || entry.mode !== GIT_MODE.file
        || (entry.size !== undefined && entry.size !== diagram.byteLength)) {
        issue ??= RECOVERY_ISSUE.diagramInvalid;
      }
    }
    return issue;
  }
  // Both layouts are read, so a repository holding provider-first and problem-first records recovers all of them.
  // A problem-first record occupies exactly <problem>/<kind>-<identity>/, and its own metadata still has to name
  // the root it was found at.
  function records(root: string, metadata: string): RemoteTreeEntry[] {
    return [...files.values()].filter(entry => entry.path.endsWith(`/${metadata}`)
      && (entry.path.startsWith(`${root}/`) || entry.path.split('/').length === 3));
  }
  const metadataFiles = records(DELIVERY_PATH.root, DELIVERY_PATH.metadata);
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
    let report: ReportRecord | null = null;
    if (!metadata.success) issue = RECOVERY_ISSUE.metadataInvalid;
    else if (!(root === deliveryRoot(metadata.data.provider, metadata.data.problemId, metadata.data.attemptId)
      || root === problemRecordRoot(metadata.data.problemId, RECORD_KIND.passed, metadata.data.attemptId))
      || Date.parse(metadata.data.observedAt) < Date.parse(metadata.data.submittedAt)) {
      issue = RECOVERY_ISSUE.identityMismatch;
    } else if (source !== null && await hashSource(source) !== metadata.data.sourceHash) {
      issue = RECOVERY_ISSUE.hashMismatch;
    // An accepted record published with a report is recovered with it; one published without stays as it was.
    } else if (metadata.data.reportHash !== undefined && metadata.data.reportBytes !== undefined) {
      const reportPath = `${root}/${REPORT_FILE}`;
      consumed.add(reportPath);
      const read = await readReport(reportPath, metadata.data.reportHash, metadata.data.reportBytes, {
        provider: metadata.data.provider, problemId: metadata.data.problemId, attemptId: metadata.data.attemptId,
        outcome: GRADING_VERDICT.success, observedAt: metadata.data.observedAt,
      });
      issue = read.issue;
      report = read.report;
      if (report) issue = diagramIssue(root, report);
    }
    if (!issue && source !== null && metadata.success) {
      entries.push({
        state: RECOVERY_ENTRY.recorded, path: file.path, source, metadata: metadata.data,
        ...report ? { report } : {},
      });
    } else {
      entries.push({
        state: RECOVERY_ENTRY.unverified, path: file.path, source, issue: issue ?? RECOVERY_ISSUE.metadataInvalid,
      });
    }
  }
  // Failed records keep their own metadata file name and add a report, so an attempt.json never becomes an
  // acceptance and a failed folder without its exact report is reported rather than counted.
  const failedFiles = records(DELIVERY_PATH.root, FAILED_PATH.metadata);
  for (const file of failedFiles) {
    const root = file.path.slice(0, -(FAILED_PATH.metadata.length + 1));
    const paths = failedPaths(root);
    consumed.add(paths.source);
    consumed.add(paths.report);
    const recovered = await readSource(files.get(paths.source));
    const source = recovered.source;
    let issue = recovered.issue;
    let raw: unknown;
    try {
      raw = JSON.parse(await text(file, MAX_METADATA_BYTES));
    } catch (error) {
      if (!(error instanceof InvalidRemoteFile) && !(error instanceof SyntaxError)) throw error;
      issue = RECOVERY_ISSUE.metadataInvalid;
    }
    const metadata = failedRecordSchema.safeParse(raw);
    let report: ReportRecord | null = null;
    if (!metadata.success) issue = RECOVERY_ISSUE.metadataInvalid;
    else if (!(root === failedRoot(metadata.data.provider, metadata.data.problemId, metadata.data.attemptId)
      || root === problemRecordRoot(metadata.data.problemId, RECORD_KIND.failed, metadata.data.attemptId))
      || Date.parse(metadata.data.observedAt) < Date.parse(metadata.data.submittedAt)) {
      issue = RECOVERY_ISSUE.identityMismatch;
    } else if (source !== null && (await hashSource(source) !== metadata.data.sourceHash
      || sourceByteLength(source) !== metadata.data.sourceBytes)) {
      issue = RECOVERY_ISSUE.hashMismatch;
    } else {
      const read = await readReport(paths.report, metadata.data.reportHash, metadata.data.reportBytes, {
        provider: metadata.data.provider, problemId: metadata.data.problemId, attemptId: metadata.data.attemptId,
        outcome: metadata.data.outcome, observedAt: metadata.data.observedAt,
      });
      issue = read.issue;
      report = read.report;
      if (report) issue = diagramIssue(root, report);
    }
    if (!issue && source !== null && metadata.success && report) {
      entries.push({ state: RECOVERY_ENTRY.failed, path: file.path, source, metadata: metadata.data, report });
    } else {
      entries.push({
        state: RECOVERY_ENTRY.unverified, path: file.path, source, issue: issue ?? RECOVERY_ISSUE.metadataInvalid,
      });
    }
  }
  // Import records keep their own metadata file name, so an import.json never becomes an acceptance.
  const importFiles = records(IMPORT_PATH.root, IMPORT_PATH.metadata);
  for (const file of importFiles) {
    const root = file.path.slice(0, -(IMPORT_PATH.metadata.length + 1));
    const sourcePath = importPaths(root).source;
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
    const metadata = importRecordSchema.safeParse(raw);
    if (!metadata.success) issue = RECOVERY_ISSUE.metadataInvalid;
    else if (!(root === importRoot(
      metadata.data.provider, metadata.data.problemId, metadata.data.submissionId, metadata.data.sourceHash,
    ) || root === problemRecordRoot(metadata.data.problemId, RECORD_KIND.imported, metadata.data.recordId))) {
      issue = RECOVERY_ISSUE.identityMismatch;
    } else if (source !== null && await hashSource(source) !== metadata.data.sourceHash) {
      issue = RECOVERY_ISSUE.hashMismatch;
    // Byte count and record id are derived from the source here, so forged values cannot become an import.
    } else if (source !== null && (sourceByteLength(source) !== metadata.data.sourceBytes
      || await importRecordId(metadata.data) !== metadata.data.recordId)) {
      issue = RECOVERY_ISSUE.recordMismatch;
    }
    if (!issue && source !== null && metadata.success) {
      entries.push({ state: RECOVERY_ENTRY.imported, path: file.path, source, metadata: metadata.data });
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
