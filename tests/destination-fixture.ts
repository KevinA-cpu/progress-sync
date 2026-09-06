import type { BrowserContext } from '@playwright/test';
import { ACCESS_TOKEN, CLIENT_ID } from './github-fixture';

interface DestinationFixture {
  exists: boolean;
  empty: boolean;
  marker: boolean;
  defaultBranch: string;
  included: boolean;
  contentsWrite: boolean;
  administrationWrite: boolean;
  userPush: boolean;
  suspended: boolean;
  installationClientId: string;
  private: boolean;
  archived: boolean;
  loseCreationResponse: boolean;
  loseInitializationResponse: boolean;
  initializationFails: boolean;
  initializationUnknownFailure: boolean;
  removeMarkerAfterRead: boolean;
  creationDenied: boolean;
  laterInstallationPage: boolean;
  laterRepositoryPage: boolean;
  createGate: Promise<void> | null;
  repositoryId: number;
  creations: number;
  initializations: number;
  requestsValid: boolean;
  markerContent: string;
}

export async function destinationFixture(context: BrowserContext) {
  const server: DestinationFixture = {
    exists: false,
    empty: false,
    marker: false,
    defaultBranch: 'learning',
    included: true,
    contentsWrite: true,
    administrationWrite: true,
    userPush: true,
    suspended: false,
    installationClientId: CLIENT_ID,
    private: false,
    archived: false,
    loseCreationResponse: false,
    loseInitializationResponse: false,
    initializationFails: false,
    initializationUnknownFailure: false,
    removeMarkerAfterRead: false,
    creationDenied: false,
    laterInstallationPage: false,
    laterRepositoryPage: false,
    createGate: null,
    repositoryId: 101,
    creations: 0,
    initializations: 0,
    requestsValid: true,
    markerContent: '',
  };
  const repository = () => ({
    id: server.repositoryId, name: 'progress-solutions', owner: { id: 42, login: 'fixture-user', type: 'User' },
    private: server.private, archived: server.archived, disabled: false,
    default_branch: server.defaultBranch, permissions: { push: server.userPush, admin: true },
  });
  await context.route('https://api.github.com/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/user') return route.fallback();
    const headers = await request.allHeaders();
    server.requestsValid &&= headers.authorization === `token ${ACCESS_TOKEN}` && !headers.cookie;
    if (url.pathname === '/user/installations') {
      const installation = {
        id: 77, app_id: 99, client_id: server.installationClientId,
        account: { id: 42, login: 'fixture-user', type: 'User' },
        repository_selection: 'selected', suspended_at: server.suspended ? new Date().toISOString() : null,
        permissions: {
          contents: server.contentsWrite ? 'write' : 'read',
          administration: server.administrationWrite ? 'write' : 'read',
        },
      };
      return route.fulfill({ json: {
        total_count: server.laterInstallationPage ? 2 : 1,
        installations: server.laterInstallationPage && url.searchParams.get('page') === '1'
          ? [{ ...installation, id: 88, client_id: 'Iv1.different-app' }] : [installation],
      } });
    }
    if (url.pathname === '/user/installations/77/repositories') {
      return route.fulfill({ json: {
        total_count: server.exists && server.included ? server.laterRepositoryPage ? 2 : 1 : 0,
        repositories: server.exists && server.included
          ? server.laterRepositoryPage && url.searchParams.get('page') === '1'
            ? [{ ...repository(), id: 202 }] : [repository()] : [],
      } });
    }
    if (url.pathname === '/user/repos' && request.method() === 'POST') {
      server.creations++;
      const body = request.postDataJSON();
      server.requestsValid &&= body.name === 'progress-solutions' && body.private === false && body.auto_init === true;
      if (server.createGate) await server.createGate;
      if (server.creationDenied) return route.fulfill({ status: 403, json: { message: 'SYNTHETIC_PRIVATE_DIAGNOSTIC' } });
      if (server.exists) return route.fulfill({ status: 422, json: { message: 'Name already exists' } });
      server.exists = true;
      server.empty = false;
      if (server.loseCreationResponse) return route.abort('failed');
      return route.fulfill({ status: 201, json: repository() });
    }
    const base = '/repos/fixture-user/progress-solutions';
    if (!server.exists) return route.fulfill({ status: 404, json: { message: 'Not found' } });
    if (url.pathname === base) return route.fulfill({ json: repository() });
    if (url.pathname === `${base}/branches`) {
      return route.fulfill({ json: server.empty ? [] : [{ name: server.defaultBranch }] });
    }
    if (url.pathname === `${base}/branches/${encodeURIComponent(server.defaultBranch)}`) {
      return route.fulfill({ status: server.empty ? 404 : 200, json: server.empty ? {} : {
        name: server.defaultBranch, commit: { sha: 'a'.repeat(40) }, protected: false,
      } });
    }
    if (url.pathname === `${base}/contents/.progress-sync.json`) {
      if (request.method() === 'PUT') {
        server.initializations++;
        const body = request.postDataJSON();
        server.requestsValid &&= !('sha' in body);
        if (server.initializationUnknownFailure) return route.fulfill({ status: 500, json: { message: 'Unknown write outcome' } });
        if (server.initializationFails) return route.fulfill({ status: 403, json: { message: 'Branch rule denied' } });
        if (server.marker) return route.fulfill({ status: 409, json: { message: 'Already initialized' } });
        server.markerContent = Buffer.from(body.content, 'base64').toString('utf8');
        server.marker = true;
        server.empty = false;
        if (server.loseInitializationResponse) return route.abort('failed');
        return route.fulfill({ status: 201, json: { commit: { sha: 'a'.repeat(40) } } });
      }
      if (!server.marker) return route.fulfill({ status: 404, json: {} });
      const marker = server.markerContent || JSON.stringify({
        kind: 'progress-sync', schemaVersion: 1, initializationId: '12345678-1234-4234-8234-123456789abc',
      });
      if (server.removeMarkerAfterRead) {
        server.marker = false;
        server.removeMarkerAfterRead = false;
      }
      return route.fulfill({ json: { type: 'file', encoding: 'base64', content: Buffer.from(marker).toString('base64') } });
    }
    return route.fulfill({ status: 404, json: { message: 'Unexpected fixture endpoint' } });
  });
  return server;
}
