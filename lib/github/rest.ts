import { SDK_HOOK } from '../constants/browser';
import { AUTH_ISSUE, GITHUB_API_ORIGIN } from '../constants/github';
import { Octokit } from '@octokit/core';
import { restEndpointMethods } from '@octokit/plugin-rest-endpoint-methods';
import { AuthFault } from './schemas';
import { githubRequestOptions } from './transport';

const RestOctokit = Octokit.plugin(restEndpointMethods);

export function githubRest(token: string, signal: AbortSignal) {
  const octokit = new RestOctokit({
    auth: token,
    request: githubRequestOptions([], signal),
  });
  octokit.hook.wrap(SDK_HOOK.request, async (request, options) => {
    const endpoint = octokit.request.endpoint(options);
    const url = new URL(endpoint.url);
    if (url.origin !== GITHUB_API_ORIGIN || url.username || url.password) {
      throw new AuthFault(AUTH_ISSUE.notAllowed);
    }
    options.request = { ...options.request, ...githubRequestOptions([endpoint.url], signal) };
    return request(options);
  });
  return octokit;
}
