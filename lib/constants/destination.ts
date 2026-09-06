export const MARKER_PATH = '.progress-sync.json';
export const MARKER_KIND = 'progress-sync';
export const DESTINATION_STORAGE_PREFIX = 'destination-v1:';
export const DESTINATION_FAULT_NAME = 'DestinationFault';
export const DESTINATION_MESSAGE_PREFIX = 'destination:';
export const DESTINATION_MESSAGE = {
  load: 'destination:load',
  create: 'destination:create',
  connect: 'destination:connect',
  verify: 'destination:verify',
  discard: 'destination:discard',
} as const;
export const DESTINATION_PHASE = {
  creating: 'creating', created: 'created', initializing: 'initializing',
  initializationRejected: 'initialization-rejected', ready: 'ready',
} as const;
export const DESTINATION_ISSUE = {
  notConnected: 'not-connected',
  sessionChanged: 'session-changed',
  invalidInput: 'invalid-input',
  permissionDenied: 'permission-denied',
  installationRequired: 'installation-required',
  repositoryNotIncluded: 'repository-not-included',
  nameCollision: 'name-collision',
  creationUncertain: 'creation-uncertain',
  creationRejected: 'creation-rejected',
  incompatibleRepository: 'incompatible-repository',
  initializationRequired: 'initialization-required',
  initializationUncertain: 'initialization-uncertain',
  initializationRejected: 'initialization-rejected',
  branchUnavailable: 'branch-unavailable',
  repositoryChanged: 'repository-changed',
  invalidResponse: 'invalid-response',
  networkError: 'network-error',
  storedDataInvalid: 'stored-data-invalid',
  pendingOperation: 'pending-operation',
  selectionRequired: 'selection-required',
} as const;

export const DESTINATION_MESSAGES = {
  [DESTINATION_ISSUE.notConnected]: 'Connect GitHub before setting up a repository.',
  [DESTINATION_ISSUE.sessionChanged]: 'The GitHub session changed or expired. Reconnect and verify the destination again.',
  [DESTINATION_ISSUE.invalidInput]: 'Check the repository name, branch, installation, and confirmation.',
  [DESTINATION_ISSUE.permissionDenied]: 'Repository writing or creation permission is missing or denied. Review App and account permissions.',
  [DESTINATION_ISSUE.installationRequired]: 'Install this GitHub App on your personal account, then refresh installations.',
  [DESTINATION_ISSUE.repositoryNotIncluded]: 'The repository is not accessible to the selected App installation. Select it on GitHub, then verify again.',
  [DESTINATION_ISSUE.nameCollision]: 'That repository already exists. Explicitly connect it or choose another name.',
  [DESTINATION_ISSUE.creationUncertain]: 'Creation may have completed. Inspect GitHub and explicitly connect the repository; it will not be created again automatically.',
  [DESTINATION_ISSUE.creationRejected]: 'GitHub rejected repository creation. Review the repository name, account policy, and any rate limit before trying again.',
  [DESTINATION_ISSUE.incompatibleRepository]: 'This is not a compatible public Progress Sync repository. No existing files were changed.',
  [DESTINATION_ISSUE.initializationRequired]: 'This repository is empty. Confirm initialization before connecting it.',
  [DESTINATION_ISSUE.initializationUncertain]: 'Initialization may have completed. Verify the pending repository before any further writes.',
  [DESTINATION_ISSUE.initializationRejected]: 'Initialization was rejected. Fix permissions or branch policy, then verify again.',
  [DESTINATION_ISSUE.branchUnavailable]: 'The selected branch is unavailable or the repository has not finished initializing. Verify again.',
  [DESTINATION_ISSUE.repositoryChanged]: 'The repository identity, owner, or visibility changed. Select the destination explicitly again.',
  [DESTINATION_ISSUE.invalidResponse]: 'GitHub returned an unsupported response. The destination is not verified.',
  [DESTINATION_ISSUE.networkError]: 'GitHub could not be reached. The destination is not verified; try verification again.',
  [DESTINATION_ISSUE.storedDataInvalid]: 'Saved destination data is invalid. It has not been overwritten.',
  [DESTINATION_ISSUE.pendingOperation]: 'A repository operation is unresolved. Verify it or explicitly discard its local setup record first.',
  [DESTINATION_ISSUE.selectionRequired]: 'Select and verify a public progress repository first.',
} satisfies Record<(typeof DESTINATION_ISSUE)[keyof typeof DESTINATION_ISSUE], string>;

export const DESTINATION_TEXT = {
  initializeCommit: 'Initialize Progress Sync repository',
  repositoryDescription: 'Progress Sync solutions and recorded progress',
  verificationIncomplete: 'Progress Sync: destination verification did not complete.',
  operationFailed: 'Progress Sync: destination operation failed.',
  interfaceIncomplete: 'Destination interface is incomplete.',
  noSelection: 'No destination selected.',
  selectAction: 'Select a repository action. Saved destinations must be verified again before use.',
  alreadyRunning: 'A repository operation is already running. Wait for it to finish.',
  checking: 'Checking GitHub destination...',
  interrupted: 'Destination setup was interrupted. Refresh and verify before retrying.',
  confirmPublic: 'Confirm public visibility before creating a repository.',
  confirmDiscard: 'Confirm discarding only the local setup record.',
  sessionChanged: 'GitHub session changed. Refresh to verify your identity.',
  owner: (login: string) => `Owner: ${login}`,
  installation: (appId: number, id: number, selection: string) =>
    `App ${appId}, installation ${id} (${selection} repositories)`,
  savedSetup: (owner: string, name: string, phase: string, repositoryId: number | null) =>
    `Saved setup: ${owner}/${name} (${phase}). Repository ID: ${repositoryId ?? 'not confirmed'}.`,
  verified: (owner: string, name: string, branch: string | null) =>
    `Verified destination: ${owner}/${name} @ ${branch}`,
} as const;
