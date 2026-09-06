# Progress Sync

Progress Sync records exact HDLBits submissions locally, supports GitHub App
device authorization, creates or connects a verified public progress repository,
publishes accepted solutions with their progress metadata atomically, and
restores saved progress in another browser.
These slices implement [ticket #2](https://github.com/KevinA-cpu/progress-sync/issues/2),
[ticket #3](https://github.com/KevinA-cpu/progress-sync/issues/3),
[ticket #4](https://github.com/KevinA-cpu/progress-sync/issues/4),
[ticket #5](https://github.com/KevinA-cpu/progress-sync/issues/5),
[ticket #6](https://github.com/KevinA-cpu/progress-sync/issues/6),
[ticket #7](https://github.com/KevinA-cpu/progress-sync/issues/7), and
[ticket #8](https://github.com/KevinA-cpu/progress-sync/issues/8).
**Automatic queue draining and conflict rebasing are not implemented yet.**

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
pnpm test -- publication.spec.ts
pnpm test -- recovery.spec.ts
pnpm test -- reconciliation.spec.ts
pnpm test -- lifecycle.spec.ts
```

After a build, tests can be rerun without rebuilding:

```sh
pnpm exec playwright test capture.spec.ts
```

### Test-runner performance

The runner uses two workers, including parallel tests within a file. Every test
still gets its own extension copy, browser profile, storage, and API fixtures.
Authentication state is never shared between tests for speed.

Use fewer workers on a constrained machine, or a focused selector while editing:

```sh
pnpm test -- --workers=1
pnpm exec playwright test github.spec.ts -g "slowdown"
```

The second command skips the build; rebuild first if extension code, dependencies,
or bundled configuration changed. The regular `pnpm test` command always builds.

Polling backoff and cancellation tests use a paused Playwright clock installed
before their connection page loads. They advance virtual time while exercising
the real authorization code and record requests against the same virtual clock.
Assertions still verify the full required backoff intervals and absence of
requests after cancellation; production timing is unchanged. Browser/worker
restart tests retain their real lifecycle behavior.

### Runtime constants

Runtime strings are grouped by domain under [lib/constants](lib/constants):

- [Browser constants](lib/constants/browser.ts): trusted storage access, storage
  areas, extension page paths, transport policy, and browser event identifiers.
- [GitHub constants](lib/constants/github.ts): permitted URLs, message/state/error
  codes, authentication messages, and pagination settings.
- [Progress constants](lib/constants/progress.ts): provider identity, capture
  states, grading verdicts, persistence keys, and progress messages.
- [Destination constants](lib/constants/destination.ts): marker identity,
  operation phases, setup message/error codes, and destination messages.
- [Delivery constants](lib/constants/delivery.ts): job states, publication paths,
  constrained messages, and delivery diagnostics.
- [Recovery constants](lib/constants/recovery.ts): read-only recovery messages,
  cache states, file limits, and stable warning codes.
- [Lifecycle constants](lib/constants/lifecycle.ts): retained-work identity,
  destination-mismatch guidance, and local-discard confirmation.

Zod schemas and runtime switches consume the same literal-valued constant
objects. Existing wire values, storage keys, and UI messages are unchanged.
HTML/CSS selectors, syntax delimiters, and schema property names stay with their
definitions; test fixture values and expectations remain independent of
production constants so the tests can detect accidental contract changes.

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
- REST operations use named, typed Octokit methods from `@octokit/core` and
  `@octokit/plugin-rest-endpoint-methods`, including repository creation, branch
  and content reads, installation checks, and authenticated identity. The SDK
  builds endpoint URLs and encodes parameters; Zod still validates responses.
  The shared restricted transport and session checks remain in effect. No retry
  or throttling plugin is installed: uncertain writes require explicit
  reconciliation before any replay.
- Write errors are classified at the individual Octokit mutation boundary using
  its official `RequestError` type and actual HTTP response, not an arbitrary
  exception's `status` field. A client-error response (4xx, except request timeout
  408) is treated as a rejection; 429 is a rejection, not a missing response.
  Timeouts, missing responses, server errors, and failures after a successful response remain
  conservative. Only the mutation wrapper can produce a write-rejection result;
  read failures, validation, cancellation, and local receipt persistence cannot
  impersonate one. This is a protocol policy, not proof from GitHub's remote
  state: uncertain writes still require reconciliation before retry or success.
- Session expiry is checked before credential use and scheduled with an alarm.
  Browser restart requires reconnection. **Check connection** revalidates the
  identity and clears rejected/revoked credentials; the displayed verification
  time is not a promise that a token cannot subsequently be revoked.
- An actual GitHub 401 response during a connected operation also clears that
  session's credential. A late rejection cannot clear a newer connection.
  Lost required repository access pauses the selected destination until explicit
  verification succeeds again. A 403 may also mean rate limiting or policy denial;
  the UI does not claim it proves credential revocation.
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

Pagination calls the typed list methods with an explicit page number, a 100-page
bound, response validation, and session checks on every request. It does not
automatically follow URLs supplied in response headers.
`GITHUB_PAGINATION.pageSize` is the 100-item GitHub API page size;
`GITHUB_PAGINATION.maxPages` is our separate 100-page safety cap. Both are named
in the GitHub constants rather than repeated as unexplained numbers.

The version-1 `.progress-sync.json` marker identifies a compatible repository.
It contains `kind: "progress-sync"`, `schemaVersion: 1`, and a UUID
`initializationId`. It contains no credential, source code, or claim that any
solution passed grading. Initialization never supplies an existing file SHA or
overwrites a file. Accepted solutions use the separate atomic publication flow below.

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

## Atomic accepted-solution publication

After destination setup, newly submitted and accepted attempts are automatically
assigned to that destination. A connection and destination must both have been
verified before the submission. Older or otherwise unassigned accepted attempts
stay local until the learner explicitly chooses the displayed destination from
the progress tab. Changing settings never redirects an existing job.

Before making publication requests, the worker persists a version-1 delivery job
with the immutable accepted snapshot, attempt/idempotency ID, original account,
App/installation/repository identities, and explicit branch. Credentials remain
separate in session storage. The progress view distinguishes locally accepted,
awaiting delivery, blocked, uncertain, and saved work.

Durable intake does not wait behind network publication: a second accepted
attempt is saved as its own bound job even while an earlier upload is outstanding.
Local job updates are serialized independently to avoid losing either record.
Rechecking an unchanged connection or destination refreshes verification without
changing the original selection time or invalidating its consent. Actual account,
connection, installation, repository, selection, or branch changes still block
old jobs rather than redirecting them.
An intake failure is recorded on its local accepted attempt; it does not disable
subsequent capture or progress reads. No publication starts without the job write.

Each accepted attempt adds two files:

```text
progress/hdlbits/<problem>/<attempt UUID>/solution.v
progress/hdlbits/<problem>/<attempt UUID>/acceptance.json
```

The source preserves the submitted UTF-8 bytes, including form-normalized CRLF
line endings. The strict version-1 acceptance record contains `provider`,
`problemId`, `attemptId`, `sourceHash` (SHA-256), `submittedAt`, `observedAt`, and
`provenance: { capture: "browser-post", verdict: "success" }`. It does not include
browser tab/document/request identifiers, diagnostics, credentials, problem
statements, or diagrams. The source itself is learner-controlled; do not submit
secrets or material you cannot publish.

Named Octokit Git Data methods create a tree based on the current branch's tree,
add both files to a single-parent commit, and update the selected branch with
`force: false`. A changed head or an existing attempt path blocks publication;
matching source bytes alone are not a delivery receipt. Truncated tree responses
are rejected rather than assuming missing entries are absent. Before committing,
the proposed tree is read back and checked for both exact Git blob IDs and
preserved unrelated entries/file modes. Git blob IDs use Git's SHA-1 object
format; the acceptance record continues to use SHA-256 for submitted source.
Unrelated remote
files are preserved. A saved receipt links to the confirmed complete commit and
is stored locally, outside its own committed metadata.

Actual permission/ruleset failures remain blocked with the accepted snapshot
intact. Lost responses and interrupted publication remain uncertain and are not
automatically retried or called successful, even if GitHub may have applied the
update. Worker/browser restart does not erase these jobs. Creating Git objects
can leave unreferenced objects if a later step fails; only the final branch update
makes the complete commit visible on the selected branch. Automatic retry
scheduling and conflict rebasing are later tickets.

### Check GitHub and retry delivery

For retained pending, blocked, or uncertain jobs, **Check GitHub and retry
delivery** first inspects the complete expected solution and acceptance metadata
at the original destination. It never treats matching source alone as success,
and never uses the current editor or an unverified import as accepted work.
Metadata values must match the retained record; harmless JSON whitespace or key
ordering changes are allowed, but unknown or changed fields are not.

New jobs record a prepared commit checkpoint before requesting a branch update.
If that complete commit is already on the intended branch, reconciliation
recovers its receipt without another publication. If a reference request did not
complete, retry reuses the exact prepared commit instead of creating a second
visible commit. A late original response and a repeated reference update therefore
converge on the same commit.

Retries retain the original snapshot, account, App installation, repository, and
branch. A newly verified session for that same destination can retry explicitly;
a different destination cannot redirect the job. Repeated retry requests are
serialized and re-read the durable job before acting.

Incomplete or inconsistent remote records stay blocked without overwriting them.
A changed branch that cannot accept the prepared commit non-destructively is
also blocked; retry does not force-push or silently rebase. Read failures remain
visible and retained, with no automatic retry loop.

For older jobs without a prepared-commit checkpoint, a bounded metadata-path
history search can recover the original atomic introduction. If both the current
record and its history are absent, retry prepares the complete record from that
same inspected head, never a silently refreshed or rebased head. Competing late
reference requests cannot both fast-forward different publication commits.
Removed or inconsistent historical records stay blocked. History requests retain
fixed repository/path/branch parameters rather than following response-provided URLs.

## Retained work and local discard

Disconnect and browser restart remove session credentials, not captured attempts,
delivery jobs, receipts, or recovered-progress caches. Retained jobs remain visible
with their original GitHub account ID, App installation, repository ID, and branch.
Selecting another account or destination does not rewrite those bindings. Reconnect
and explicitly verify the original destination before checking GitHub and retrying.
That check revalidates identity, installation membership, required permissions, and
the branch; the UI's last verification is not a guarantee of continuing access.

**Discard local attempt** requires confirmation and removes an unresolved delivery
job and its local captured source together. This cannot be undone: an unsaved
snapshot and its delivery checkpoint can no longer be recovered from this device.
A source-free attempt-ID tombstone prevents stale requests from publishing the
discarded attempt again. Other captures and independently recovered GitHub records
are not removed. Saved receipts are not discarded by this pending-work action.
If delivery is active, wait for it to settle or disconnect first, then discard.
Storage failure leaves the attempt retained and reports the failure.

Local discard does not make GitHub requests or delete remote files. Disconnect
cannot undo a request already sent: it may have completed remotely even if the
extension never received confirmation. Such jobs remain unresolved until checked
against their original destination, or explicitly discarded with that warning.

Local disconnect is also not GitHub-side revocation. Use GitHub settings to
[revoke an authorized GitHub App](https://github.com/settings/apps/authorizations)
or [manage installed GitHub Apps and repository access](https://github.com/settings/installations).
GitHub website login alone grants no API authority to the extension.

## Recover saved progress

In a fresh browser, connect GitHub and explicitly choose **Connect existing
repository** for the same public Progress Sync repository and branch. Successful
connection or verification starts a read-only recovery. The progress tab also
provides **Refresh saved progress**.

Recovery pins a verified branch commit and reads its Git tree and blobs. It
validates the supported acceptance schema, provider/problem/attempt path
association, provenance, timestamps, and exact UTF-8 source SHA-256 before
showing recorded acceptance. A recursive tree response that is truncated is not
treated as complete: recovery reads the non-recursive subtrees instead. Git tree
responses use subtree traversal rather than numbered pagination; installation
and repository-access lists still use their paginated APIs. An incomplete or
failed scan is reported, not silently published as a complete recovery.

Existing Verilog files without valid acceptance metadata are **unverified**.
Malformed or unsupported metadata, missing source, invalid encoding, and source
hash mismatches also produce warnings instead of accepted progress. Imported
source and metadata are never executed, and remote fields cannot select another
account, repository, branch, URL, or privileged operation.

Recovered progress is displayed separately from locally captured submissions.
Its snapshot link identifies the commit that was read, not necessarily the
original publication commit. Recovery never changes the current HDLBits editor
or native completion state, writes remote content, creates duplicate uploads, or
converts an uncertain local delivery job into a confirmed receipt.

These records are extension-observed provenance, **not signed grading
certificates**. Repository owners can edit source and metadata. GitHub cannot
recover unsaved guest history or another device's undelivered local jobs.

The recovery cache uses extension-origin IndexedDB through `idb`, not Chrome's
10 MB `storage.local` area. The worker and trusted progress page read it locally;
complete archives are not sent through size-limited runtime messages. No extra
storage permission is requested. Available browser disk/memory still applies;
a storage failure is reported rather than silently dropping records.

The cache is scoped to the account, App installation, repository ID, and branch.
A failed refresh retains a previous complete snapshot only with
an explicit stale-cache notice. Worker interruption is reported and can be
retried with **Refresh saved progress**. A stale or superseded request cannot
replace a newer selection's snapshot. Invalid cached data is reported rather than
shown as a successful recovery; local captured attempts and delivery jobs remain
separate.

Source files retain the existing 256 KiB byte limit; acceptance metadata is
limited to 16 KiB per file. Oversized or unsupported files are unverified, not
silently truncated. Base64 line wrapping is supported and UTF-8 decoding preserves
a source byte-order mark. These are file-validation limits, not a cap on the
number of saved attempts scanned from the repository.

## What is recorded

- The actual browser-observed submitted text, including form line-ending
  normalization, rather than editor contents read after grading.
- Its SHA-256 hash, provider/problem identity, attempt identity, timestamps,
  and request/result-document provenance.
- A distinct waiting, accepted-locally, or unverified state. Accepted locally
  **does not** mean backed up to GitHub.

Records stay in trusted-context-only local extension storage. Accepted source is
published only to an intentionally selected public destination. Local storage is not an encrypted vault;
clearing extension data, uninstalling, or losing the device can lose these
records. Keep independent backups.

Extension-owned data contracts use strict Zod schemas, with TypeScript types inferred
from those schemas rather than maintained separately. Submitted fields, runtime
requests/replies, and persisted records are validated without coercion or source
transformations. Accepted records must include the source, hash, observation
timestamp, and parent/result document provenance. Invalid stored records are
reported explicitly, not silently stripped, reset, or overwritten.

GitHub transport-response schemas validate the fields consumed by the extension
and allow additional GitHub fields, matching the SDK's extensible responses.
This does not apply to acceptance metadata, extension messages, or saved records:
those remain strict and reject unknown fields.

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
- Existing source without valid acceptance metadata can only be shown as
  unverified. Unsaved guest history cannot be reconstructed.

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

Publication tests extend that boundary with immutable Git trees/commits and a
non-force branch update. They run real onboarding, capture, and publication and
check exact remote files together with the visible receipt or failure state.

Lifecycle tests exercise retained jobs through expiry, rejected authorization,
access repair, account/repository/branch switches, delayed authorization and
reference responses, and a real browser restart. Local-discard tests cover
confirmation, credential/source removal, failed storage, active and queued jobs,
stale requests, and preservation of remote contents.

Recovery tests close the original browser and launch a fresh profile without
copying local storage or credentials. They reconnect through the real extension
and controlled GitHub boundary, retaining only the remote repository state.

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
- [Git trees and base-tree preservation](https://docs.github.com/en/rest/git/trees#create-a-tree)
- [Non-force reference updates](https://docs.github.com/en/rest/git/refs#update-a-reference)
