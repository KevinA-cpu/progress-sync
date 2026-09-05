import { request } from '@octokit/request';
import { AuthFault } from './schemas';

export function githubRequest(allowedUrls: readonly string[], signal: AbortSignal) {
  const fetchGithub: typeof fetch = (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (!allowedUrls.includes(url)) throw new AuthFault('not-allowed');
    signal.throwIfAborted();
    return fetch(input, {
      ...init,
      signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
      credentials: 'omit',
      redirect: 'error',
      cache: 'no-store',
    });
  };
  return request.defaults({
    request: {
      fetch: fetchGithub,
      log: { warn: () => console.warn('Progress Sync: GitHub reported an API deprecation.') },
    },
  });
}
