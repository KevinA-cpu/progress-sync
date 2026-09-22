import { DESTINATION_ISSUE, DESTINATION_TEXT } from '../constants/destination';
import { GITHUB_HTTP_STATUS } from '../constants/github';
import { AuthFault, type ConnectedSession } from '../github/schemas';
import { githubRateLimit, githubResponseStatus } from '../github/errors';
import { RESTORE_AUTHORITY, type RestoreAuthority } from '../github/service';
import { destinationApi } from './api';
import { DestinationFault } from './schemas';
import type { DestinationService } from './service';

// Access is treated as withdrawn only for answers that name the destination itself; everything else is transient.
function withdrawn(error: unknown): boolean {
  if (error instanceof AuthFault) return true;
  if (error instanceof DestinationFault) {
    switch (error.issue) {
      case DESTINATION_ISSUE.permissionDenied:
      case DESTINATION_ISSUE.installationRequired:
      case DESTINATION_ISSUE.repositoryNotIncluded:
      case DESTINATION_ISSUE.repositoryChanged:
      case DESTINATION_ISSUE.branchUnavailable:
      case DESTINATION_ISSUE.incompatibleRepository:
      case DESTINATION_ISSUE.sessionChanged:
        return true;
      default:
        return false;
    }
  }
  if (githubRateLimit(error, Date.now()) !== null) return false;
  const status = githubResponseStatus(error);
  return status === GITHUB_HTTP_STATUS.unauthorized || status === GITHUB_HTTP_STATUS.forbidden
    || status === GITHUB_HTTP_STATUS.notFound;
}

// Revalidates, read only, the destination this connection had already selected. It never looks for another one:
// a remembered connection whose own repository and branch no longer check out resumes nothing.
export function createRestoreAuthority(destination: DestinationService) {
  return async function authorize(
    session: ConnectedSession, current: () => Promise<boolean>,
  ): Promise<RestoreAuthority> {
    let target;
    try {
      target = await destination.selection(session);
    } catch (error) {
      // Nothing was selected, or the selection is already paused, so there is no queued work to authorize.
      if (error instanceof DestinationFault && error.issue === DESTINATION_ISSUE.selectionRequired) {
        return RESTORE_AUTHORITY.authorized;
      }
      return RESTORE_AUTHORITY.unavailable;
    }
    const controller = new AbortController();
    try {
      await destinationApi(session, () => Promise.resolve(), controller.signal).verify(target);
      return RESTORE_AUTHORITY.authorized;
    } catch (error) {
      if (!withdrawn(error)) {
        console.warn(DESTINATION_TEXT.verificationIncomplete);
        return RESTORE_AUTHORITY.unavailable;
      }
      // The answer describes the connection this restore started with. Once that connection is no longer the one
      // being restored - the user disconnected, or signed in again - it pauses nothing.
      if (!await current()) return RESTORE_AUTHORITY.unavailable;
      // Nothing resumes either way, but a pause that was not written leaves the selection looking usable, so it
      // is reported rather than swallowed. The failure itself is not logged; only this fixed line is.
      await destination.pauseAfterFailure(target, error)
        .catch(() => { console.error(DESTINATION_TEXT.pauseUnrecorded); });
      return RESTORE_AUTHORITY.unauthorized;
    }
  };
}
