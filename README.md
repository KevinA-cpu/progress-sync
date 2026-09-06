# Progress Sync

Progress Sync records exact HDLBits submissions locally, supports GitHub App
device authorization, and creates or connects a verified public progress repository.
These slices implement [ticket #2](https://github.com/KevinA-cpu/progress-sync/issues/2),
[ticket #3](https://github.com/KevinA-cpu/progress-sync/issues/3), and
[ticket #4](https://github.com/KevinA-cpu/progress-sync/issues/4).
**Solution uploads and cross-browser progress recovery are not implemented yet.**

HDLBits login is not required. The extension's progress is separate from HDLBits'
official completion state.

## Development

Use Node.js 22 or newer and pnpm 10.26.1.

```sh
pnpm install --frozen-lockfile
pnpm exec playwright install chromium
pnpm run typecheck
pnpm test
```

The test command builds the actual extension before running Playwright. For a
focused run:

```sh
pnpm test -- capture.spec.ts -g "editing while grading"
pnpm test -- github.spec.ts
pnpm test -- destination.spec.ts
```

After a build, tests can be rerun without rebuilding:

```sh
pnpm exec playwright test capture.spec.ts
```

## Try the extension

1. Run `pnpm run build`.
2. Open Chrome's extension management page and enable developer mode.
3. Choose **Load unpacked** and select the generated `.output\chrome-mv3` directory.
4. Click the Progress Sync toolbar action to open its progress tab.
5. On an HTTPS HDLBits problem page, use the text editor and the in-page
   **Submit** button. Keep the progress tab open to see the observation.
6. Use **Connect GitHub** to open the dedicated connection tab. GitHub App
   configuration is required only for connecting, not for local HDLBits capture.
7. After connecting, open **Set up progress repository** and confirm the owner,
   installation, name, and public visibility before creating a repository.

Chromium 120 or newer is required. The currently tested browser version is
153.0.8010.12. The production build needs no local server.

## Configure the GitHub App

The repository deliberately ships with an unconfigured public client ID.
No App is registered and no credentials are obtained automatically.

1. Register a GitHub App for the intended audience using
   [GitHub's registration instructions](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/registering-a-github-app).
2. Enable **device flow** and **expiring user access tokens** in the App settings.
   No backend or client secret is required for the chosen device flow.
3. For automatic public-repository onboarding, configure repository
   **Administration: read/write**, **Contents: read/write**, and required metadata
   access. Administration is ongoing authority, not a create-only permission.
   When installation access is needed, select only intended repositories;
   do not silently grant all-repository access.
4. Replace `null` in [the bundled configuration](public/github-app.json) with the
   App's **public client ID**. This is not the numeric App ID, a client secret,
   private key, password, or personal access token. Never put secrets in that file.
5. Rebuild and reload the extension. Open its connection tab, choose **Connect
   GitHub**, and use the displayed code at **Open GitHub**. Check the App identity
   and consent information on GitHub before approving.

The public client ID is maintainer configuration bundled with the extension, not
something each learner must enter. Missing/invalid configuration produces setup
guidance without claiming a valid connection.

## GitHub connection behavior

- GitHub handles login/consent. Being logged into its website does not authorize
  the extension. The extension verifies the user through GitHub's API before
  displaying a connected identity.
- The dedicated extension tab owns authorization polling. A background-worker
  restart does not discard that tab's flow. Closing, reloading, or discarding
  the connection tab interrupts unfinished authorization.
- Device-code creation and exchange use Octokit's official
  `@octokit/oauth-methods` helpers with the GitHub App client type. We use these
  instead of the higher-level device strategy so waits are abortable and
  `slow_down` increases remain in effect for subsequent polls.
- Only an expiring access token is retained in trusted-context-only
  `chrome.storage.session`. Device codes and refresh tokens are not persisted.
  No token is placed in local/synchronized storage, webpage/content-script
  messages, logs, or exports.
  Credential-bearing communication is confined to privileged extension contexts.
- API calls omit website cookies, reject redirects, and are limited to the
  required GitHub authorization, user, installation, and repository operations. No client secret, App private
  key, broad OAuth `repo` scope, or general-purpose GitHub proxy is used.
- Session expiry is checked before credential use and scheduled with an alarm.
  Browser restart requires reconnection. **Check connection** revalidates the
  identity and clears rejected/revoked credentials; the displayed verification
  time is not a promise that a token cannot subsequently be revoked.
- Cancellation and disconnect invalidate the owning attempt. Late responses
  cannot restore it. Disconnect clears local credentials, not GitHub-side App
  authorization or local HDLBits records. Revoke App access separately on GitHub.
- A connected identity does not establish repository write access. Installation,
  repository, branch, and effective write-permission checks belong to onboarding.

## Public progress repository onboarding

**Create public repository** uses the authenticated personal user's GitHub App
user token, explicitly sends public visibility, and asks GitHub to initialize
the repository. This is not an installation token, a private default, or a manual
repository-creation requirement.

Onboarding verifies the current user, an installation of the configured App
on that account, installation permissions, selected-repository membership, the
repository's stable identity/public visibility, user push permission, and its
actual branch. It follows installation/repository pagination and never silently
expands installation access. If a newly created repository is not included,
use **Manage App installation access**, select that repository on GitHub, and
choose **Verify pending or saved repository**.

The version-1 `.progress-sync.json` marker identifies a compatible repository.
It contains `kind: "progress-sync"`, `schemaVersion: 1`, and a UUID
`initializationId`. It contains no credential, source code, or claim that any
solution passed grading. Creating the marker is the only content write in this
slice; initialization never supplies an existing file SHA or overwrites a file.
Solution and acceptance-record publication belong to the next ticket.

**Connect existing repository** is explicit and read-only for compatible
populated repositories. It discovers the default branch or verifies an entered
branch, including names containing slashes. An empty existing repository requires
the initialization checkbox before adding the marker. Unrelated populated
repositories are rejected; a checkbox alone cannot silently adopt them. Existing
repository visibility is never changed. This version supports only public
repositories owned by the authenticated personal account, not organizations.

A trusted local setup journal records the intended account, App/installation,
name, confirmed repository ID, operation phase, and branch. It is persisted before
creation or initialization requests. The journal survives worker/browser restart
but contains no token. Saved destinations require fresh verification; a saved
record is not an ongoing guarantee of write access.

- A name collision requires explicitly connecting the compatible existing
  repository or choosing another name.
- An uncertain creation response is not retried automatically. Inspect GitHub.
  To adopt the exact previously requested name explicitly, choose **Connect
  existing repository** and confirm initialization if its marker is still absent.
  Identity cannot be inferred from the name or lost response alone.
- An uncertain marker write is reconciled by checking its initialization ID,
  without issuing another write. A missing or mismatched marker remains blocked.
  A definite HTTP rejection is recorded separately: repair permissions or branch
  policy, then explicitly verify again to retry the previously authorized marker
  write. A read-only existing connection never acquires initialization permission
  merely because its marker disappears during or after verification.
- **Discard local setup record** never deletes a GitHub repository, files, local
  HDLBits attempts, or accepted solutions.
- Disconnecting or changing sessions invalidates old confirmations. An already
  issued request may still finish remotely, but its result cannot silently select
  a destination for a different session.
- Permissions are a point-in-time check. Branch rules, policy changes, and later
  revocation can still reject a future write; no future writability is promised.

## What is recorded

- The actual browser-observed submitted text, including form line-ending
  normalization, rather than editor contents read after grading.
- Its SHA-256 hash, provider/problem identity, attempt identity, timestamps,
  and request/result-document provenance.
- A distinct waiting, accepted-locally, or unverified state. Accepted locally
  **does not** mean backed up to GitHub.

Records stay in trusted-context-only local extension storage. Source text is
not sent anywhere by the extension. Local storage is not an encrypted vault;
clearing extension data, uninstalling, or losing the device can lose these
records. Keep independent backups.

Runtime data contracts use strict Zod schemas, with TypeScript types inferred
from those schemas rather than maintained separately. Submitted fields, runtime
requests/replies, and persisted records are validated without coercion or source
transformations. Accepted records must include the source, hash, observation
timestamp, and parent/result document provenance. Invalid stored records are
reported explicitly, not silently stripped, reset, or overwritten.

Zod's JIT compilation is disabled to respect Manifest V3's content security
policy without permitting `eval`. Schema validation checks data structure;
the browser request/document checks below still establish result correlation.

## Correlation and permissions

HDLBits posts the editor contents to its grading endpoint and navigates a result
iframe. The response identifies the problem and verdict but does not echo the
submitted source.

The extension joins a browser-observed POST, its successful non-cached HTTP
completion, a committed result document, and the isolated content script's
observation from that same document. It also checks the originating problem
document. It does not assume request and navigation events arrive in the same
order or infer acceptance from a historical solved badge.

Permissions:

- `storage`: local attempt records and separate session-only GitHub credentials,
  plus a credential-free local repository-setup journal, restricted to trusted
  extension contexts.
- `webRequest`: read-only observation of the HDLBits grading request body and
  request lifecycle. No cookie/header inspection, blocking, or traffic changes.
- `webNavigation`: HDLBits-filtered navigation observations and frame/document
  identity checks. This API permission is broader than the listener filter;
  the extension does not collect browsing history.
- `alarms`: expire the GitHub session without keeping a page open.
- Host access: HTTPS HDLBits, `github.com`, and `api.github.com` only. GitHub
  requests originate in privileged extension contexts; there are no GitHub
  content scripts and no all-sites access.

Basic tab lifecycle events are used only to invalidate the tracked authorization
owner when its tab closes, reloads, or is discarded; browsing history is not stored.

Page messages cannot select arbitrary operations or retrieve the progress
store. The result observer does not bridge `window.postMessage` into extension
requests. Page content is still an observation source, not a cryptographic
grading certificate: a compromised provider or browser is outside this proof.

## Current limits

- Only the in-page text-editor submission to a direct result iframe is supported.
  File uploads, new-window submissions, changed layouts, and other platforms
  must not be treated as accepted.
- Submitted source is limited to 256 KiB. Duplicate or unsupported source fields
  are unverified, not silently truncated.
- Only one simulation may be awaiting observation across the extension at a
  time. Overlapping simulations are held as unverified.
- Ambiguous or interrupted problem documents require a reload before another
  attempt can be trusted. This safety gate survives worker recreation.
  A page already open when the observer starts, or one with an untracked grading
  navigation, also requires a reload. This deliberately avoids associating an
  older result navigation with a newer POST.
  Ordinary, correlated incorrect results can be corrected and resubmitted
  without a reload.
- A result that takes more than two minutes is unverified. Worker suspension
  during an unfinished observation also makes it unverified; late success cannot
  promote it afterward. Accepted records survive page reload and worker restart.
- Existing files and previous guest history are not imported or reconstructed.

## Validation

Playwright tests use original, controlled HDLBits-shaped pages and responses,
not copied site code. They run the built extension's real request observation,
content script, message boundary, storage, and progress interface. The fixtures
block external traffic other than the controlled provider and extension assets.
Worker lifecycle and time are controlled through browser/runtime interfaces,
not by mocking internal modules.

GitHub tests use synthetic configuration in isolated copies of the built
extension and controlled GitHub responses, including worker-owned API requests.
They never use the host GitHub CLI credential or authorize a real account.
Coverage includes consent, pending/slowdown, denial, expiry, malformed grants,
cancellation races, identity checks, cookie omission, token redaction, worker
recreation, real browser restart, and denied session access from the actual
HDLBits content-script world.

Destination tests use controlled repository/installation APIs. They cover
public creation, collisions, compatible and empty existing repositories,
nonstandard branches, permission and membership failures, pagination, uncertain
creation/initialization, worker restart, changed repository identities, and
session-bound consent. They create no real repository or GitHub content.

Coverage includes accepted bytes, post-submit edits and hashes, failed and stale
results, ambiguous layouts and payloads, historical/forged observations,
timeouts, cross-tab overlap, page/worker recreation, correction after failure,
strict saved-data validation, runtime sender/operation checks, and CSP-safe
schema initialization.

A separate live guest check on 2026-09-05 used original constant-output Verilog
on HDLBits `step_one` with the built extension in Chromium 153.0.8010.12. Editing
the CodeMirror buffer during grading did not change the accepted snapshot. The
submitted CRLF/UTF-8 bytes matched SHA-256
`e792e08eb073133e384987694229526ad3da6b1d3bcff73bada595e5f934dc0d`.
No credentials, GitHub requests, or public repository writes were involved.
This establishes that observed path, not every HDLBits problem/layout or a
comprehensive security certification.

No live GitHub authorization, App registration, or repository creation was performed.
A live compatibility check requires a configured App and separate user consent.

Relevant platform contracts:

- [Chrome webRequest](https://developer.chrome.com/docs/extensions/reference/api/webRequest)
- [Chrome webNavigation and event ordering](https://developer.chrome.com/docs/extensions/reference/api/webNavigation)
- [Chrome storage access levels](https://developer.chrome.com/docs/extensions/reference/api/storage)
- [GitHub App user tokens and device flow](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app)
- [Octokit OAuth methods](https://github.com/octokit/oauth-methods.js)
- [User-access-token installations and permissions](https://docs.github.com/en/rest/apps/installations#list-app-installations-accessible-to-the-user-access-token)
- [Create a repository for the authenticated user](https://docs.github.com/en/rest/repos/repos#create-a-repository-for-the-authenticated-user)
