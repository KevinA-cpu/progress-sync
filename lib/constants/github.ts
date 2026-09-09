export const AUTH_SESSION_KEY = 'github-connection-v1';
export const AUTH_EXPIRY_ALARM = 'github-connection-expiry';
export const GITHUB_ORIGIN = 'https://github.com';
export const GITHUB_API_ORIGIN = 'https://api.github.com';
export const GITHUB_HOST_MATCH = `${GITHUB_ORIGIN}/*`;
export const GITHUB_API_HOST_MATCH = `${GITHUB_API_ORIGIN}/*`;
export const DEVICE_CODE_URL = `${GITHUB_ORIGIN}/login/device/code`;
export const TOKEN_URL = `${GITHUB_ORIGIN}/login/oauth/access_token`;
export const VERIFICATION_URL = `${GITHUB_ORIGIN}/login/device`;
export const GITHUB_CLIENT_TYPE = 'github-app';
export const GITHUB_PERSONAL_ACCOUNT_TYPE = 'User';
export const GITHUB_TOKEN_TYPE = 'bearer';
export const GITHUB_APP_SCOPE = '';
export const AUTH_FAULT_NAME = 'AuthFault';
export const GITHUB_PAGINATION = {
  pageSize: 100,
  // Application safety cap, separate from GitHub's maximum items per page.
  maxPages: 100,
  maxLinkHeaderLength: 8192,
  nextRelation: 'next',
} as const;
export const GITHUB_COMPARISON = { ahead: 'ahead', behind: 'behind', diverged: 'diverged', identical: 'identical' } as const;

export const GITHUB_PERMISSION = { read: 'read', write: 'write' } as const;
export const REPOSITORY_SELECTION = { all: 'all', selected: 'selected' } as const;
export const GITHUB_CONTENT = { file: 'file', base64: 'base64' } as const;
export const GITHUB_TEXT_ENCODING = 'utf-8';
// Include line wrapping while decoded file limits remain independent.
export const githubBase64CharacterLimit = (byteLimit: number) => 8 * Math.ceil(byteLimit / 3);
export const GITHUB_HTTP_STATUS = {
  created: 201, clientErrorStart: 400, unauthorized: 401, forbidden: 403, notFound: 404,
  requestTimeout: 408, conflict: 409, unprocessableEntity: 422, serverErrorStart: 500,
} as const;
export const AUTH_STATUS = {
  disconnected: 'disconnected', authorizing: 'authorizing', connected: 'connected', unavailable: 'unavailable',
} as const;

export const AUTH_MESSAGE_PREFIX = 'github:';
export const AUTH_MESSAGE = {
  state: 'github:state',
  begin: 'github:begin',
  permit: 'github:permit',
  complete: 'github:complete',
  cancel: 'github:cancel',
  disconnect: 'github:disconnect',
  check: 'github:check',
} as const;

export const AUTH_ISSUE = {
  notConnected: 'not-connected',
  configurationRequired: 'configuration-required',
  configurationInvalid: 'configuration-invalid',
  configurationUnavailable: 'configuration-unavailable',
  cancelled: 'cancelled',
  interrupted: 'interrupted',
  expired: 'expired',
  denied: 'denied',
  flowExpired: 'flow-expired',
  networkError: 'network-error',
  providerError: 'provider-error',
  identityFailed: 'identity-failed',
  expiringTokensRequired: 'expiring-tokens-required',
  invalidSession: 'invalid-session',
  notAllowed: 'not-allowed',
} as const;

export const OAUTH_ERROR = {
  accessDenied: 'access_denied',
  expiredToken: 'expired_token',
  incorrectClientCredentials: 'incorrect_client_credentials',
  deviceFlowDisabled: 'device_flow_disabled',
  authorizationPending: 'authorization_pending',
  slowDown: 'slow_down',
} as const;

export const AUTH_MESSAGES = {
  [AUTH_ISSUE.notConnected]: 'Not connected to GitHub.',
  [AUTH_ISSUE.configurationRequired]: 'Configure the public GitHub App client ID, then rebuild and reload the extension.',
  [AUTH_ISSUE.configurationInvalid]: 'Check the public GitHub App client ID and enable device flow in the App settings.',
  [AUTH_ISSUE.configurationUnavailable]: 'GitHub App configuration could not be loaded. Reload the extension.',
  [AUTH_ISSUE.cancelled]: 'GitHub authorization cancelled.',
  [AUTH_ISSUE.interrupted]: 'GitHub authorization was interrupted. Start a new connection.',
  [AUTH_ISSUE.expired]: 'The GitHub session expired. Connect again.',
  [AUTH_ISSUE.denied]: 'GitHub authorization was denied. You can try again.',
  [AUTH_ISSUE.flowExpired]: 'The GitHub verification code expired. Start a new connection.',
  [AUTH_ISSUE.networkError]: 'GitHub could not be reached. Check your connection and try again.',
  [AUTH_ISSUE.providerError]: 'GitHub returned an unsupported authorization response. Try connecting again.',
  [AUTH_ISSUE.identityFailed]: 'GitHub identity could not be verified. Connect again.',
  [AUTH_ISSUE.expiringTokensRequired]: 'Enable expiring user access tokens in the GitHub App settings, then reconnect.',
  [AUTH_ISSUE.invalidSession]: 'Stored GitHub connection data was invalid and has been cleared. Connect again.',
  [AUTH_ISSUE.notAllowed]: 'This GitHub connection request is no longer permitted.',
} satisfies Record<(typeof AUTH_ISSUE)[keyof typeof AUTH_ISSUE], string>;

export const AUTH_TEXT = {
  interfaceIncomplete: 'GitHub connection interface is incomplete.',
  alreadyRunning: 'An authorization attempt is already running in this tab.',
  starting: 'Starting GitHub authorization...',
  waiting: 'Waiting for GitHub authorization...',
  anotherTab: 'Authorization is in progress in another connection tab.',
  verifying: 'Verifying GitHub identity...',
  invalidIdentity: 'GitHub identity response is invalid.',
  storageFailed: 'Progress Sync: GitHub connection storage operation failed.',
  requestFailed: 'Progress Sync: GitHub connection request failed.',
  obsoleteResult: 'Progress Sync: obsolete authorization result discarded.',
  cancellationUnconfirmed: 'Progress Sync: authorization cancellation could not be confirmed.',
  interruptionUnrecorded: 'Progress Sync: GitHub authorization interruption could not be recorded.',
  expiryUnchecked: 'Progress Sync: GitHub session expiry could not be checked.',
  deprecatedApi: 'Progress Sync: GitHub reported an API deprecation.',
  writeRejected: 'GitHub rejected this write request.',
  connected: (login: string) => `Connected as ${login}`,
  connectionDetails: (verifiedAt: string, expiresAt: string) =>
    `Identity verified at ${verifiedAt}. Session expires at ${expiresAt}.`,
  verificationExpiry: (expiresAt: string) => `Verification code expires at ${expiresAt}.`,
} as const;
