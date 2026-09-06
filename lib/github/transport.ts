import { FETCH_POLICY } from '../constants/browser';
import { AUTH_ISSUE, AUTH_TEXT } from '../constants/github';
import { request } from '@octokit/request';
import { AuthFault } from './schemas';

export function githubRequestOptions(allowedUrls: readonly string[], signal: AbortSignal) {
  const fetchGithub: typeof fetch = (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (!allowedUrls.includes(url)) throw new AuthFault(AUTH_ISSUE.notAllowed);
    signal.throwIfAborted();
    return fetch(input, {
      ...init,
      signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
      credentials: FETCH_POLICY.credentials,
      redirect: FETCH_POLICY.redirect,
      cache: FETCH_POLICY.cache,
    });
  };
  return {
    fetch: fetchGithub,
    log: { warn: () => console.warn(AUTH_TEXT.deprecatedApi) },
  };
}

export function githubRequest(allowedUrls: readonly string[], signal: AbortSignal) {
  return request.defaults({ request: githubRequestOptions(allowedUrls, signal) });
}
