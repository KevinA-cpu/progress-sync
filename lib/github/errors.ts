import { RequestError } from '@octokit/request-error';
import {
  AUTH_TEXT, GITHUB_HTTP_STATUS, GITHUB_RATE_LIMIT_HEADER, HTTP_DATE_PATTERN,
  MAX_SCHEDULED_RATE_LIMIT_DELAY_MS, MAX_TRUSTED_RATE_LIMIT_DELAY_MS, RATE_LIMIT_SIGNAL,
} from '../constants/github';
import { z } from '../schema';

export function githubResponseStatus(error: unknown): number | null {
  return error instanceof RequestError && error.response !== undefined
    ? error.response.status : null;
}

export type RateLimitSignal = {
  kind: (typeof RATE_LIMIT_SIGNAL)[keyof typeof RATE_LIMIT_SIGNAL]; delayMs: number;
};

export class GithubWriteRejected extends Error {
  constructor(readonly status: number, readonly rateLimit: RateLimitSignal | null = null) {
    super(AUTH_TEXT.writeRejected);
  }
}

const rateLimitSecondsSchema = z.union([z.string().regex(/^\d{1,10}$/), z.int().nonnegative().max(9_999_999_999)])
  .transform(value => Number(value));
const httpDateSchema = z.string().regex(HTTP_DATE_PATTERN)
  .transform(value => Date.parse(value)).refine(Number.isFinite);
const rateLimitHeadersSchema = z.looseObject({
  [GITHUB_RATE_LIMIT_HEADER.retryAfter]: z.unknown().optional(),
  [GITHUB_RATE_LIMIT_HEADER.remaining]: z.unknown().optional(),
  [GITHUB_RATE_LIMIT_HEADER.reset]: z.unknown().optional(),
});

function signal(milliseconds: number): RateLimitSignal {
  const delayMs = Math.max(Math.trunc(milliseconds), 0);
  if (delayMs <= MAX_SCHEDULED_RATE_LIMIT_DELAY_MS) return { kind: RATE_LIMIT_SIGNAL.wait, delayMs };
  return {
    kind: RATE_LIMIT_SIGNAL.unsupported,
    delayMs: delayMs <= MAX_TRUSTED_RATE_LIMIT_DELAY_MS ? delayMs : 0,
  };
}

export function responseRateLimit(status: number, headers: unknown, now: number): RateLimitSignal | null {
  const throttled = status === GITHUB_HTTP_STATUS.tooManyRequests;
  if (!throttled && status !== GITHUB_HTTP_STATUS.forbidden) return null;
  const parsed = rateLimitHeadersSchema.safeParse(headers);
  if (!parsed.success) return throttled ? { kind: RATE_LIMIT_SIGNAL.wait, delayMs: 0 } : null;
  const after: unknown = parsed.data[GITHUB_RATE_LIMIT_HEADER.retryAfter];
  if (after !== undefined) {
    const seconds = rateLimitSecondsSchema.safeParse(after);
    if (seconds.success) return signal(seconds.data * 1000);
    const date = httpDateSchema.safeParse(after);
    if (date.success) return signal(date.data - now);
    return { kind: RATE_LIMIT_SIGNAL.unsupported, delayMs: 0 };
  }
  const remaining = rateLimitSecondsSchema.safeParse(parsed.data[GITHUB_RATE_LIMIT_HEADER.remaining]);
  const reset = rateLimitSecondsSchema.safeParse(parsed.data[GITHUB_RATE_LIMIT_HEADER.reset]);
  if (remaining.success && remaining.data === 0 && reset.success) return signal(reset.data * 1000 - now);
  return throttled ? { kind: RATE_LIMIT_SIGNAL.wait, delayMs: 0 } : null;
}

export function githubRateLimit(error: unknown, now: number): RateLimitSignal | null {
  if (error instanceof GithubWriteRejected) return error.rateLimit;
  if (!(error instanceof RequestError) || error.response === undefined) return null;
  return responseRateLimit(error.response.status, error.response.headers, now);
}

export async function githubWrite<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    const status = githubResponseStatus(error);
    // Only a response to this mutation can establish rejection. Timeouts remain ambiguous.
    if (status !== null && status >= GITHUB_HTTP_STATUS.clientErrorStart
      && status < GITHUB_HTTP_STATUS.serverErrorStart && status !== GITHUB_HTTP_STATUS.requestTimeout) {
      throw new GithubWriteRejected(status, error instanceof RequestError && error.response !== undefined
        ? responseRateLimit(status, error.response.headers, Date.now()) : null);
    }
    throw error;
  }
}
