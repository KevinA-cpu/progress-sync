import { RequestError } from '@octokit/request-error';
import { AUTH_TEXT, GITHUB_HTTP_STATUS } from '../constants/github';

export function githubResponseStatus(error: unknown): number | null {
  return error instanceof RequestError && error.response !== undefined
    ? error.response.status : null;
}

export class GithubWriteRejected extends Error {
  constructor() {
    super(AUTH_TEXT.writeRejected);
  }
}

export async function githubWrite<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    const status = githubResponseStatus(error);
    // Only a response to this mutation can establish rejection. Timeouts remain ambiguous.
    if (status !== null && status >= GITHUB_HTTP_STATUS.clientErrorStart
      && status < GITHUB_HTTP_STATUS.serverErrorStart && status !== GITHUB_HTTP_STATUS.requestTimeout) {
      throw new GithubWriteRejected();
    }
    throw error;
  }
}
