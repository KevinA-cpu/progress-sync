import { DELIVERY_FAILURE, DELIVERY_RETRY, DELIVERY_TEXT } from '../constants/delivery';
import { GITHUB_HTTP_STATUS, RATE_LIMIT_SIGNAL } from '../constants/github';
import { AuthFault } from '../github/schemas';
import { DestinationFault } from '../destination/schemas';
import { githubRateLimit, githubResponseStatus, GithubWriteRejected } from '../github/errors';
import { DeliveryBlocked, DeliveryFault, type DeliveryRetry } from './schemas';

export type DeliveryFailure = (typeof DELIVERY_FAILURE)[keyof typeof DELIVERY_FAILURE];

const settledFaults: readonly string[] = [
  DELIVERY_TEXT.existingPath, DELIVERY_TEXT.invalidResponse, DELIVERY_TEXT.invalidData,
  DELIVERY_TEXT.invalidAttempt,
];

export function classifyDeliveryFailure(error: unknown, now: number): DeliveryFailure {
  const status = error instanceof GithubWriteRejected ? error.status : githubResponseStatus(error);
  if (error instanceof AuthFault || status === GITHUB_HTTP_STATUS.unauthorized) return DELIVERY_FAILURE.authorization;
  const limit = githubRateLimit(error, now);
  if (limit) {
    return limit.kind === RATE_LIMIT_SIGNAL.wait ? DELIVERY_FAILURE.rateLimited : DELIVERY_FAILURE.unsupportedDelay;
  }
  if (error instanceof DestinationFault || status === GITHUB_HTTP_STATUS.forbidden
    || status === GITHUB_HTTP_STATUS.notFound) return DELIVERY_FAILURE.authorization;
  if (error instanceof DeliveryBlocked || error instanceof GithubWriteRejected) return DELIVERY_FAILURE.permanent;
  if (error instanceof DeliveryFault && settledFaults.includes(error.message)) return DELIVERY_FAILURE.permanent;
  if (status === null || status === GITHUB_HTTP_STATUS.requestTimeout
    || status >= GITHUB_HTTP_STATUS.serverErrorStart) return DELIVERY_FAILURE.transient;
  return DELIVERY_FAILURE.permanent;
}

export function rateLimitNotBefore(error: unknown, now: number): number | null {
  const limit = githubRateLimit(error, now);
  return limit && limit.delayMs > 0 ? now + limit.delayMs : null;
}

export function nextDeliveryAttempt(
  failure: DeliveryFailure, attempts: number, error: unknown, now: number,
): DeliveryRetry {
  const eligible = failure === DELIVERY_FAILURE.transient || failure === DELIVERY_FAILURE.rateLimited;
  if (!eligible || attempts >= DELIVERY_RETRY.maxAttempts) {
    return { attempts, nextAttemptAt: null, failure, reservedAt: null };
  }
  const backoff = Math.min(DELIVERY_RETRY.initialDelayMs * DELIVERY_RETRY.factor ** attempts, DELIVERY_RETRY.maxDelayMs);
  const requested = failure === DELIVERY_FAILURE.rateLimited ? githubRateLimit(error, now)?.delayMs ?? 0 : 0;
  return {
    attempts, nextAttemptAt: new Date(now + Math.max(backoff, requested)).toISOString(), failure, reservedAt: null,
  };
}

export function resumeAfterReservation(retry: DeliveryRetry, now: number): DeliveryRetry {
  return nextDeliveryAttempt(
    retry.failure === DELIVERY_FAILURE.rateLimited ? DELIVERY_FAILURE.rateLimited : DELIVERY_FAILURE.transient,
    retry.attempts, null, now,
  );
}

export function retryExhausted(retry: DeliveryRetry | null | undefined): boolean {
  return retry !== null && retry !== undefined && retry.nextAttemptAt === null
    && retry.attempts >= DELIVERY_RETRY.maxAttempts;
}
