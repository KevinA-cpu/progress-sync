import { DESTINATION_ISSUE, DESTINATION_TEXT, MARKER_KIND, MARKER_PATH } from '../constants/destination';
import { AUTH_ISSUE, GITHUB_CONTENT, GITHUB_PAGINATION, GITHUB_PERSONAL_ACCOUNT_TYPE } from '../constants/github';
import { z } from '../schema';
import { AuthFault, githubUserResponseSchema, type ConnectedSession } from '../github/schemas';
import { githubRest } from '../github/rest';
import {
  DestinationFault, branchSchema, httpStatusSchema, installationSchema, markerSchema, repositorySchema,
  type Installation, type Repository,
} from './schemas';

export function destinationApi(
  session: ConnectedSession, guard: () => Promise<void>, signal: AbortSignal,
) {
  const octokit = githubRest(session.token, signal);
  function repositoryParameters(name: string) {
    return { owner: session.user.login, repo: name };
  }
  async function call<T>(operation: () => Promise<T>): Promise<T> {
    await guard();
    const response = await operation();
    await guard();
    return response;
  }
  async function read<T>(operation: () => Promise<{ data: unknown }>, schema: z.ZodType<T>): Promise<T> {
    const response = await call(operation);
    const parsed = schema.safeParse(response.data);
    if (!parsed.success) throw new DestinationFault(DESTINATION_ISSUE.invalidResponse);
    return parsed.data;
  }
  async function identity() {
    const user = await read(() => octokit.rest.users.getAuthenticated(), githubUserResponseSchema);
    if (user.id !== session.user.id || user.login !== session.user.login) throw new AuthFault(AUTH_ISSUE.notAllowed);
    return user;
  }
  async function installations(): Promise<Installation[]> {
    const items: Installation[] = [];
    for (let page = 1; page <= GITHUB_PAGINATION.maxPages; page++) {
      const response = await read(() => octokit.rest.apps.listInstallationsForAuthenticatedUser({
        per_page: GITHUB_PAGINATION.pageSize, page,
      }), z.object({
        total_count: z.int().nonnegative(), installations: z.array(installationSchema),
      }));
      items.push(...response.installations);
      if (items.length >= response.total_count) {
        return items.filter(item => item.client_id === session.clientId
          && item.account?.id === session.user.id && item.account.type === GITHUB_PERSONAL_ACCOUNT_TYPE
          && item.suspended_at === null);
      }
      if (response.installations.length === 0) break;
    }
    throw new DestinationFault(DESTINATION_ISSUE.invalidResponse);
  }
  async function repository(name: string): Promise<Repository> {
    const repo = await read(() => octokit.rest.repos.get(repositoryParameters(name)), repositorySchema);
    if (repo.owner.id !== session.user.id || repo.owner.type !== GITHUB_PERSONAL_ACCOUNT_TYPE
      || repo.name.toLowerCase() !== name.toLowerCase() || repo.private) {
      throw new DestinationFault(DESTINATION_ISSUE.repositoryChanged);
    }
    if (repo.archived || repo.disabled || !repo.permissions.push) throw new DestinationFault(DESTINATION_ISSUE.permissionDenied);
    return repo;
  }
  async function included(installationId: number, repositoryId: number) {
    let seen = 0;
    for (let page = 1; page <= GITHUB_PAGINATION.maxPages; page++) {
      const response = await read(() => octokit.rest.apps.listInstallationReposForAuthenticatedUser({
        installation_id: installationId, per_page: GITHUB_PAGINATION.pageSize, page,
      }), z.object({
        total_count: z.int().nonnegative(), repositories: z.array(z.object({ id: z.int().positive() })),
      }));
      if (response.repositories.some(repo => repo.id === repositoryId)) return;
      seen += response.repositories.length;
      if (seen >= response.total_count) throw new DestinationFault(DESTINATION_ISSUE.repositoryNotIncluded);
      if (response.repositories.length === 0) break;
    }
    throw new DestinationFault(DESTINATION_ISSUE.invalidResponse);
  }
  async function empty(name: string) {
    const branches = await read(() => octokit.rest.repos.listBranches({
      ...repositoryParameters(name), per_page: 1,
    }), z.array(z.object({ name: z.string() })));
    return branches.length === 0;
  }
  async function branch(name: string, branchName: string) {
    try {
      const branch = await read(() => octokit.rest.repos.getBranch({
        ...repositoryParameters(name), branch: branchName,
      }), branchSchema);
      if (branch.name !== branchName) throw new DestinationFault(DESTINATION_ISSUE.branchUnavailable);
      return branch;
    } catch (error) {
      if (status(error) === 404 || status(error) === 409) throw new DestinationFault(DESTINATION_ISSUE.branchUnavailable);
      throw error;
    }
  }
  async function marker(name: string, ref: string) {
    let file;
    try {
      file = await read(() => octokit.rest.repos.getContent({
        ...repositoryParameters(name), path: MARKER_PATH, ref,
      }), z.object({
        type: z.literal(GITHUB_CONTENT.file), encoding: z.literal(GITHUB_CONTENT.base64), content: z.string().max(16_384),
      }));
    } catch (error) {
      if (status(error) === 404) return null;
      throw error;
    }
    let value: unknown;
    try {
      value = JSON.parse(atob(file.content.replace(/\s/g, '')));
    } catch {
      throw new DestinationFault(DESTINATION_ISSUE.incompatibleRepository);
    }
    const parsed = markerSchema.safeParse(value);
    if (!parsed.success) throw new DestinationFault(DESTINATION_ISSUE.incompatibleRepository);
    return parsed.data;
  }
  async function initialize(name: string, branchName: string | null, operationId: string) {
    await call(() => octokit.rest.repos.createOrUpdateFileContents({
      ...repositoryParameters(name), path: MARKER_PATH,
      message: DESTINATION_TEXT.initializeCommit,
      content: btoa(JSON.stringify({ kind: MARKER_KIND, schemaVersion: 1, initializationId: operationId }, null, 2) + '\n'),
      ...(branchName === null ? {} : { branch: branchName }),
    }));
  }
  async function create(name: string) {
    const response = await call(() => octokit.rest.repos.createForAuthenticatedUser({
      name, private: false, auto_init: true, description: DESTINATION_TEXT.repositoryDescription,
    }));
    const parsed = repositorySchema.safeParse(response.data);
    if (response.status !== 201 || !parsed.success) throw new DestinationFault(DESTINATION_ISSUE.invalidResponse);
    return parsed.data;
  }
  return { identity, installations, repository, included, empty, branch, marker, initialize, create };
}

export function status(error: unknown): number | null {
  const parsed = httpStatusSchema.safeParse(error);
  return parsed.success ? parsed.data.status : null;
}
