import { z } from '../schema';
import { AuthFault, USER_URL, githubUserResponseSchema, type ConnectedSession } from '../github/schemas';
import { githubRequest } from '../github/transport';
import {
  DestinationFault, branchSchema, httpStatusSchema, installationSchema, markerSchema,
  repositorySchema, MARKER_PATH, type Installation, type Repository,
} from './schemas';

export function destinationApi(
  session: ConnectedSession, guard: () => Promise<void>, signal: AbortSignal,
) {
  async function call(method: 'GET' | 'POST' | 'PUT', path: string, body?: object) {
    await guard();
    const url = `https://api.github.com${path}`;
    const request = githubRequest([url], signal);
    const response = await request({ method, url, headers: { authorization: `token ${session.token}` }, ...body });
    await guard();
    return response;
  }
  async function read<T>(path: string, schema: z.ZodType<T>): Promise<T> {
    const response = await call('GET', path);
    const parsed = schema.safeParse(response.data);
    if (!parsed.success) throw new DestinationFault('invalid-response');
    return parsed.data;
  }
  async function identity() {
    const user = await read(new URL(USER_URL).pathname, githubUserResponseSchema);
    if (user.id !== session.user.id || user.login !== session.user.login) throw new AuthFault('not-allowed');
    return user;
  }
  async function installations(): Promise<Installation[]> {
    const items: Installation[] = [];
    for (let page = 1; page <= 100; page++) {
      const response = await read(`/user/installations?per_page=100&page=${page}`, z.object({
        total_count: z.int().nonnegative(), installations: z.array(installationSchema),
      }));
      items.push(...response.installations);
      if (items.length >= response.total_count) {
        return items.filter(item => item.client_id === session.clientId
          && item.account?.id === session.user.id && item.account.type === 'User'
          && item.suspended_at === null);
      }
      if (response.installations.length === 0) break;
    }
    throw new DestinationFault('invalid-response');
  }
  function base(name: string) {
    return `/repos/${encodeURIComponent(session.user.login)}/${encodeURIComponent(name)}`;
  }
  async function repository(name: string): Promise<Repository> {
    const repo = await read(base(name), repositorySchema);
    if (repo.owner.id !== session.user.id || repo.owner.type !== 'User'
      || repo.name.toLowerCase() !== name.toLowerCase() || repo.private) {
      throw new DestinationFault('repository-changed');
    }
    if (repo.archived || repo.disabled || !repo.permissions.push) throw new DestinationFault('permission-denied');
    return repo;
  }
  async function included(installationId: number, repositoryId: number) {
    let seen = 0;
    for (let page = 1; page <= 100; page++) {
      const response = await read(`/user/installations/${installationId}/repositories?per_page=100&page=${page}`, z.object({
        total_count: z.int().nonnegative(), repositories: z.array(z.object({ id: z.int().positive() })),
      }));
      if (response.repositories.some(repo => repo.id === repositoryId)) return;
      seen += response.repositories.length;
      if (seen >= response.total_count) throw new DestinationFault('repository-not-included');
      if (response.repositories.length === 0) break;
    }
    throw new DestinationFault('invalid-response');
  }
  async function empty(name: string) {
    const branches = await read(`${base(name)}/branches?per_page=1`, z.array(z.object({ name: z.string() })));
    return branches.length === 0;
  }
  async function branch(name: string, branchName: string) {
    try {
      const branch = await read(`${base(name)}/branches/${encodeURIComponent(branchName)}`, branchSchema);
      if (branch.name !== branchName) throw new DestinationFault('branch-unavailable');
      return branch;
    } catch (error) {
      if (status(error) === 404 || status(error) === 409) throw new DestinationFault('branch-unavailable');
      throw error;
    }
  }
  async function marker(name: string, ref: string) {
    let file;
    try {
      file = await read(`${base(name)}/contents/${MARKER_PATH}?ref=${encodeURIComponent(ref)}`, z.object({
        type: z.literal('file'), encoding: z.literal('base64'), content: z.string().max(16_384),
      }));
    } catch (error) {
      if (status(error) === 404) return null;
      throw error;
    }
    let value: unknown;
    try {
      value = JSON.parse(atob(file.content.replace(/\s/g, '')));
    } catch {
      throw new DestinationFault('incompatible-repository');
    }
    const parsed = markerSchema.safeParse(value);
    if (!parsed.success) throw new DestinationFault('incompatible-repository');
    return parsed.data;
  }
  async function initialize(name: string, branchName: string | null, operationId: string) {
    await call('PUT', `${base(name)}/contents/${MARKER_PATH}`, {
      message: 'Initialize Progress Sync repository',
      content: btoa(JSON.stringify({ kind: 'progress-sync', schemaVersion: 1, initializationId: operationId }, null, 2) + '\n'),
      ...(branchName === null ? {} : { branch: branchName }),
    });
  }
  async function create(name: string) {
    const response = await call('POST', '/user/repos', {
      name, private: false, auto_init: true, description: 'Progress Sync solutions and recorded progress',
    });
    const parsed = repositorySchema.safeParse(response.data);
    if (response.status !== 201 || !parsed.success) throw new DestinationFault('invalid-response');
    return parsed.data;
  }
  return { identity, installations, repository, included, empty, branch, marker, initialize, create };
}

export function status(error: unknown): number | null {
  const parsed = httpStatusSchema.safeParse(error);
  return parsed.success ? parsed.data.status : null;
}
