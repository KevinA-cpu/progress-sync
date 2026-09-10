import { PROGRESS_TEXT } from './progress';

export const LIFECYCLE_TEXT = {
  discard: 'Discard local attempt',
  discardConfirmation: (attemptId: string) =>
    `Discard local attempt ${attemptId}? This removes its captured source and delivery job from this browser and cannot be undone. It does not delete anything on GitHub. Requests already issued may still complete; discarding does not prove the attempt was never published.`,
  originalAccount: (login: string, id: number) => `Original GitHub account: ${login} (ID ${id})`,
  appLabel: 'Original GitHub App ID',
  clientLabel: 'Original public App client ID',
  installationLabel: 'Original installation ID',
  repositoryLabel: 'Original repository ID',
  reconnect: 'Reconnect GitHub with the original account and App, then select and verify the original installation, repository, and branch. Until that verification, this job stays queued and no scheduled attempt is made.',
  destinationChanged: 'The selected destination does not match the original account, App, installation, repository, or branch for this job. Restore and verify the original destination before checking GitHub and retrying. This job will not be redirected.',
  operationActive: 'A GitHub delivery operation is active. Wait for it to finish, or disconnect GitHub to stop further requests, then refresh before discarding. Requests already issued may still complete.',
  submittedSource: `${PROGRESS_TEXT.submittedSource} (read-only)`,
} as const;
