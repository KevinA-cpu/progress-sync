import { browser } from 'wxt/browser';

export const PROGRESS_KEY = 'attempts-v1';
export const HDL_ORIGIN = 'https://hdlbits.01xz.net';
export const GRADING_URL = `${HDL_ORIGIN}/runsim.php`;
export const MAX_SOURCE_BYTES = 256 * 1024;
export const RESULT_TIMEOUT_MS = 120_000;

export interface Attempt {
  schemaVersion: 1;
  id: string;
  provider: 'hdlbits';
  problemId: string | null;
  source: string | null;
  sourceHash: string | null;
  submittedAt: string;
  observedAt: string | null;
  state: 'pending' | 'accepted' | 'unverified';
  reason: string;
  requiresReload: boolean;
  provenance: {
    capture: 'browser-post';
    requestId: string;
    tabId: number;
    frameId: number;
    parentDocumentId: string | null;
    resultDocumentId: string | null;
  };
}

export interface ResultObservation {
  type: 'hdlbits:result';
  problemId: string | null;
  verdict: 'success' | 'failure' | 'unknown';
}

export type ProgressReply =
  | { ok: true; attempts: Attempt[] }
  | { ok: false; error: string };

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isProblemId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z0-9][a-z0-9_]{0,127}$/.test(value);
}

export function isResultObservation(value: unknown): value is ResultObservation {
  return isObject(value) && Object.keys(value).length === 3
    && value.type === 'hdlbits:result'
    && (value.problemId === null || isProblemId(value.problemId))
    && typeof value.verdict === 'string'
    && ['success', 'failure', 'unknown'].includes(value.verdict);
}

function isAttempt(value: unknown): value is Attempt {
  if (!isObject(value) || !isObject(value.provenance)) return false;
  const provenance = value.provenance;
  return value.schemaVersion === 1 && value.provider === 'hdlbits'
    && typeof value.id === 'string'
    && (value.problemId === null || isProblemId(value.problemId))
    && (value.source === null || typeof value.source === 'string')
    && (value.sourceHash === null || (
      typeof value.sourceHash === 'string' && /^[a-f0-9]{64}$/.test(value.sourceHash)
    ))
    && typeof value.submittedAt === 'string'
    && (value.observedAt === null || typeof value.observedAt === 'string')
    && typeof value.state === 'string'
    && ['pending', 'accepted', 'unverified'].includes(value.state)
    && typeof value.reason === 'string'
    && typeof value.requiresReload === 'boolean'
    && provenance.capture === 'browser-post'
    && typeof provenance.requestId === 'string'
    && Number.isInteger(provenance.tabId) && Number.isInteger(provenance.frameId)
    && (provenance.parentDocumentId === null || typeof provenance.parentDocumentId === 'string')
    && (provenance.resultDocumentId === null || typeof provenance.resultDocumentId === 'string')
    && (value.state !== 'accepted' || (
      isProblemId(value.problemId) && typeof value.source === 'string'
      && typeof value.sourceHash === 'string' && typeof value.observedAt === 'string'
      && typeof provenance.resultDocumentId === 'string'
    ));
}

export function isAttemptList(value: unknown): value is Attempt[] {
  return Array.isArray(value) && value.every(isAttempt);
}

export async function readAttempts(): Promise<Attempt[]> {
  const stored: unknown = (await browser.storage.local.get(PROGRESS_KEY))[PROGRESS_KEY];
  if (stored === undefined) return [];
  if (!isAttemptList(stored)) {
    throw new Error('Local progress is invalid or unsupported. It has not been overwritten.');
  }
  return stored;
}

export async function hashSource(source: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(source));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}
