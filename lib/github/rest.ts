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
  octokit.hook.wrap('request', async (request, options) => {
    const endpoint = octokit.request.endpoint(options);
    const url = new URL(endpoint.url);
    if (url.origin !== 'https://api.github.com' || url.username || url.password) {
      throw new AuthFault('not-allowed');
    }
    options.request = { ...options.request, ...githubRequestOptions([endpoint.url], signal) };
    return request(options);
  });
  return octokit;
}
