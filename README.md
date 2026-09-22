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
[ticket #7](https://github.com/KevinA-cpu/progress-sync/issues/7),
[ticket #8](https://github.com/KevinA-cpu/progress-sync/issues/8),
[ticket #9](https://github.com/KevinA-cpu/progress-sync/issues/9),
[ticket #10](https://github.com/KevinA-cpu/progress-sync/issues/10), and
[ticket #11](https://github.com/KevinA-cpu/progress-sync/issues/11).
Queued uploads drain automatically; see
[automatic resumption](#automatic-resumption-of-queued-uploads).
**Live GitHub runs on 2026-09-14 and 2026-09-20 exercised the core journey,
native provider state, credential isolation, and an interrupted delivery that
recovered, on one browser build and one account.** See
[release readiness](#release-readiness).

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
pnpm test -- remote-conflicts.spec.ts
pnpm test -- concurrency.spec.ts
pnpm test -- lifecycle.spec.ts
pnpm test -- lifecycle-rebase.spec.ts
pnpm test -- pending-identity.spec.ts
pnpm test -- journey.spec.ts
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

[The bundled configuration](public/github-app.json) carries the maintainer's
**public client ID** for [the Progress Sync App](https://github.com/settings/apps/progress-sync).
It holds no secret, and no credentials are obtained automatically. Registering a
different App for another audience means replacing that value with its own public
client ID.

1. Register a GitHub App for the intended audience using
   [GitHub's registration instructions](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/registering-a-github-app).
2. Enable **device flow** and **expiring user access tokens** in the App settings.
   No backend or client secret is required for the chosen device flow.
3. For automatic public-repository onboarding, configure repository
   **Administration: read/write**, **Contents: read/write**, and required metadata
   access. Administration is ongoing authority, not a create-only permission.
   When installation access is needed, select only intended repositories;
   do not silently grant all-repository access.
4. Put the App's **public client ID** in [the bundled configuration](public/github-app.json).
   This is not the numeric App ID, a client secret,
   private key, password, or personal access token. Never put secrets in that file.
5. Rebuild and reload the extension. Open its connection tab, choose **Connect
   GitHub**, and use the displayed code at **Open GitHub**. Check the App identity
   and consent information on GitHub before approving.

GitHub's **Only select repositories** installation screen requires at least one
existing repository, so installation cannot start from an empty account. Create a
single isolated public bootstrap repository for that purpose — for example
`progress-sync-app-setup` — and select only it. Leave the intended progress
repository name uncreated, so the extension's own automatic public creation is
what creates it; afterwards add that new repository explicitly to the
installation's selected access. In the 2026-09-14 live run the newly created
repository was already covered by the selected-repositories installation, so no
manual widening step was needed; that is not guaranteed, so keep the explicit
selection step available when access is missing. Never choose
**All repositories**, never add an existing project, and never widen
installation authority silently.

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
- Only an expiring access token is retained. Device codes and refresh tokens are
  never persisted. By default the token lives in trusted-context-only
  `chrome.storage.session` and ends with the browser session.
  No token is placed in synchronized storage, webpage/content-script messages,
  logs, or exports.
  Credential-bearing communication is confined to privileged extension contexts.
- "Remember GitHub on this device" is off by default and can only be turned on
  from the connection page, with the consent text shown at the moment of the
  choice. While it is on, the same access token is also written to
  trusted-context-only `chrome.storage.local`, so it survives a browser restart
  until the original `expiresAt` GitHub issued. It is never renewed, extended, or
  accompanied by a refresh token, and anyone with the Windows account and browser
  profile can use it until it expires.
- Restoring a remembered connection is read-only and never substitutes a target:
  the client configuration, the original account, and the exact repository,
  repository id, and branch that were already selected are revalidated before the
  session is installed and before any queued delivery resumes. A rejected
  credential, an expired one, a different account, a different client id, or a
  destination that is no longer authorized withdraws the stored copy; being
  unable to reach GitHub keeps it and retries on a bounded schedule. Turning the
  option off and disconnecting withdraw it immediately, and a disable or
  disconnect during a slow restore wins over the late response.
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
choose **Verify pending or saved repository**. A repository tab that was already
open when the GitHub session changed says so and disables its actions: choose
**Refresh installations** after reconnecting, then verify again.

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

### Layout for new saves

A verified destination also carries the layout future saves use. It is chosen
explicitly on the repository page and confirmed before it is stored; it is never
inferred from the repository name, its contents, or its history.

```text
provider-first (default)   progress/hdlbits/<problem>/<attempt>/…  imports/hdlbits/…
problem-first              <problem>/passed-<attempt>/  <problem>/failed-<attempt>/  <problem>/imported-<record>/
```

Provider-first remains the default, including for destinations that were set up
before this choice existed, so nothing already published moves or is rewritten.
Problem-first is dedicated to a single provider: a destination holding it rejects
another provider's records rather than sharing the namespace. Changing the choice
applies to later saves only. A delivery job takes its path and layout once, when
it is created, and keeps them through retries, reconciliation, worker restart,
and later settings changes. Recovery reads both layouts, and an existing marker
or record is never overwritten by either.

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

Each accepted attempt adds two files, plus a report and one file per captured
timing diagram when the result produced them:

```text
progress/hdlbits/<problem>/<attempt UUID>/solution.v
progress/hdlbits/<problem>/<attempt UUID>/acceptance.json
progress/hdlbits/<problem>/<attempt UUID>/report.json
progress/hdlbits/<problem>/<attempt UUID>/diagram-1.png
```

The source preserves the submitted UTF-8 bytes, including form-normalized CRLF
line endings. The strict version-1 acceptance record contains `provider`,
`problemId`, `attemptId`, `sourceHash` (SHA-256), `submittedAt`, `observedAt`, and
`provenance: { capture: "browser-post", verdict: "success" }`. It does not include
browser tab/document/request identifiers, diagnostics, credentials, or problem
statements. Where a report was captured, the record also pins that report's
SHA-256 and byte count, and the report itself names every published image with
its exact byte count, media type, pixel dimensions, and SHA-256. The source
itself is learner-controlled; do not submit secrets or material you cannot
publish.

Named Octokit Git Data methods create a tree based on the current branch's tree,
add every file of the attempt to a single-parent commit, and update the selected branch with
`force: false`. A changed head triggers bounded reconciliation and safe reapplication;
an inconsistent existing attempt path blocks publication. Matching source bytes
alone are not a delivery receipt. Truncated tree responses
are rejected rather than assuming missing entries are absent. Before committing,
the proposed tree is read back and checked for both exact Git blob IDs and
preserved unrelated entries/file modes. Git blob IDs use Git's SHA-1 object
format; the acceptance record continues to use SHA-256 for submitted source.
Unrelated remote
files are preserved. A saved receipt links to the confirmed complete commit and
is stored locally, outside its own committed metadata.

Actual permission/ruleset failures remain blocked with the accepted snapshot
intact. Lost responses and interrupted publication remain uncertain and are never
called successful, even if GitHub may have applied the update; they are resolved
by inspection, not by replaying the write. Worker/browser restart does not erase
these jobs. Creating Git objects can leave unreferenced objects if a later step
fails; only the final branch update makes the complete commit visible on the
selected branch.

### Automatic resumption of queued uploads

An accepted attempt that could not be delivered because of a temporary outage,
an explicit rate limit, or a stopped worker resumes without a popup or a manual
retry. Scheduling state lives in the durable job, not in worker memory:

- Each failed attempt stores a `retry` record with the spent unattended attempt
  count, the earliest next attempt time, and the failure classification.
  Jobs written before this feature have no record and stay manual-only.
- Work a stopped worker left `pending`, `publishing`, or `reconciling` is
  adopted on the next worker start and given the same bounded schedule.
- One durable write both spends an attempt and marks it reserved. A worker lost
  after that write but before its request leaves a reservation the next sweep
  adopts: the spent attempt stands, the wait moves to the next bounded step, and
  no free attempt is issued. A queued unattended request whose reservation no
  longer matches the stored job is abandoned, so a newer deadline or a permanent
  classification cannot be bypassed by an earlier wakeup.
- Writing one job never rewrites another. Normalizing an inactive
  `publishing` job at write time would erase the evidence its own adoption needs.
- A single named alarm (`delivery-retry-v1`) is always re-armed for the earliest
  future attempt time and cleared when nothing is scheduled, so alarms cannot
  accumulate. Overdue work is never given a zero-delay alarm; it waits for the
  next real trigger. Triggers are worker start, `runtime.onStartup`, that alarm,
  the completion of any delivery attempt, and a successful destination
  verification.
- The budget is **at most five** unattended attempts per job, spaced 1m, 4m,
  16m, 64m, then a 2h ceiling. The spent attempt is persisted *before* the
  request, so a worker lost mid-attempt cannot replay it for free. An explicit
  **Check GitHub and retry delivery** re-arms the budget; account and destination
  events never do.

Failures are classified rather than lumped together. Only transport failures,
408, 5xx, and explicit rate limiting are eligible. A bare 403 stays an ambiguous
permission failure. Authorization (401), permission, missing resources,
validation, unsupported responses, existing inconsistent paths, and branch-policy
rejections are never retried unattended; those jobs stay retained, visible, and
manually actionable, as do jobs that have spent their budget.

### Stated rate-limit deadlines

A `Retry-After` header — whole seconds or an HTTP date — or
`x-ratelimit-remaining: 0` with `x-ratelimit-reset` states a time before which
this client must not send again. That deadline is a **minimum this client never
shortens**: the internal backoff is bounded, the provider's own wait is not, and
the attempt is scheduled at whichever is later. Such a response also keeps the
destination selected rather than pausing it for lost access.

The deadline belongs to the authenticated owner and App, not to one job. It is
stored as a timestamp under an owner/App key — never a token and never provider
header text — and it holds back every queued job, every newly captured attempt,
and every explicit **Check GitHub and retry delivery** for that authority until
it passes.

The attempt's outcome and that deadline are written in **one** `storage.local`
transaction. A worker lost between two writes, or a failed second write, could
otherwise retain a throttled job with no shared floor and let the next job send
early. The deadline also takes effect in the running worker before the write, so
even a failed write cannot let this worker send for that authority; the next
sweep repairs the stored floor, and if that write fails too the failure is shown
rather than logged away. A floor that never reached storage cannot survive worker
death — but neither did the outcome, so the job stays mid-publication and its
next attempt reconciles before writing, at which point GitHub restates the wait. An explicit retry inside the window is refused with the time, rather
than being sent early. A deferred unattended attempt returns its reservation to
the budget, because nothing was sent.

A stated wait longer than 24 hours, or a `Retry-After` this client cannot read,
is not treated as "no delay" and is not silently shortened: the job is blocked
with an explanation, nothing is scheduled, and any recorded deadline still holds
back explicit retries. Deadlines beyond seven days are not trusted as timestamps
at all, so they block the job without locking the learner out indefinitely.

A scheduled attempt is not a shortcut. It re-resolves the current selection and
requires the original account, App, installation, repository, and branch; it
never redirects a job. After a disconnect or browser restart the credential is
gone, so scheduled work simply stays queued until the original account is
reauthorized and the original destination is verified again. Tokens are never
restored from durable storage. Every attempt runs through the same serialized,
idempotent publication path used by capture and manual retry, and interrupted or
uncertain work is reconciled against the complete remote record before any
replay, so duplicate wakeups and overlapping triggers cannot publish twice.

If a sweep cannot read, write, or register its wakeup, the progress view says so
in an alert and each queued job says that no automatic wakeup could be
registered, instead of claiming that no action is needed. Jobs and their
deadlines are left untouched, nothing retries in a loop, and the next real
trigger — a recreated worker, a verified destination, or a finished attempt —
re-arms the wakeup and clears the warning.

Undelivered work is stored only in this browser profile. Clearing extension
storage, removing the extension, or losing the device loses attempts that were
never saved to GitHub. Storage failures stay visible in the log and the progress
view instead of turning into a retry loop.

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
complete and the base is unchanged, retry reuses the exact prepared commit instead
of creating a second visible commit. If the branch has advanced, it first checks
for a complete publication, then safely reapplies the record as described below.
A late original request cannot fast-forward its obsolete commit over newer work.

Retries retain the original snapshot, account, App installation, repository, and
branch. A newly verified session for that same destination can retry explicitly;
a different destination cannot redirect the job. Repeated retry requests are
serialized and re-read the durable job before acting.

Incomplete or inconsistent remote records stay blocked without overwriting them.
A branch change that cannot be safely reconciled is also blocked; retry never
force-pushes. Read failures remain visible and retained; a transport read failure
may be rechecked on the bounded schedule above, never in a loop.

For older jobs without a prepared-commit checkpoint, a bounded metadata-path
history search can recover the original atomic introduction. If both the current
record and its history are absent, retry prepares the complete record from that
inspected head. Any subsequent advancement is re-inspected before reapplication;
competing late reference requests cannot both introduce the same record.
Removed or inconsistent historical records stay blocked. History requests retain
fixed repository/path/branch parameters rather than following response-provided URLs.

### Preserve concurrent remote changes

Initial publication and explicit retries use the same conflict coordinator. A head
change discovered before the reference update, or a reference-specific HTTP
409/422 rejection followed by a verified head advance, causes a fresh destination
verification and inspection of the current commit/tree. Other write rejections,
or a 409/422 with an unchanged head, do not trigger conflict retries. Lost responses
remain uncertain and require reconciliation rather than speculative replay.

Before rebuilding, the coordinator verifies the prepared commit and requires the
new head to descend from its original base. A complete existing publication
recovers its original receipt instead of creating a duplicate. An inconsistent
current attempt path, a detectable replacement of branch history, or evidence of
a removed attempt blocks reapplication. Absence checks inspect the whole attempt
directory's history, including source-only or other partial records. Removed
records are not recreated just to finish the queue item.

Safe reapplication adds the exact solution/metadata pair to a tree based on the
new head, checks that all unrelated entries and file modes are preserved, and
persists a new prepared-commit checkpoint before a non-force reference update.
The original account, installation, repository identity, and branch remain fixed;
every conflict inspection rechecks access and repository compatibility.

History is **additive by attempt UUID**, including multiple attempts for the same
problem. Older queued work adds its own record and never replaces a newer remote
attempt, edits that attempt's timestamps, or updates a shared "latest" pointer.
Existing unrelated and user-edited records remain untouched.

Each invocation permits at most **two rebases** after its initial/prepared
candidate. If the branch keeps advancing, the job retains its snapshot and
checkpoint with a visible blocked status and **Check GitHub and retry delivery**
action. This bounds conflict recovery within one invocation; it is separate from
the bounded resumption schedule. Protection, permission, validation, and
rate-limit failures never cause an unbounded retry loop.

## Failed attempts and submission reports

A correlated result is recorded with the outcome its status line states:
accepted, incorrect, compile error, or simulation error. Anything the current
result contract does not state — an unrecognized status line, a result that
cannot be tied to the observed POST and its own document, a late or interrupted
observation — stays **unverified**. An unverified result is never turned into a
failed or an accepted record, and a historical solved badge is still not
evidence of anything.

A recorded attempt keeps the report observed with it, accepted ones included,
in local storage: the provider's status line verbatim, whichever structured
compiler/simulator messages the result contract exposes, each timing diagram the
result drew as a static PNG, and a coverage note saying what the report does and
does not contain. Instructional explanations, expected or reference output
tables, test data, hidden sources, page markup, cookies, and URLs are not read
and not stored. Report text is inert: it is bounded per message and in total,
sanitized, never rendered as HTML, and no URL in a result is fetched. A report is
refused rather than trimmed when it is malformed or oversized, and an attempt
without a usable report stays unverified instead of being recorded as a failure.
Imported records get no report and no diagrams at all; none is invented for them.

### Timing diagrams

A result states its verdict before it finishes drawing. The verdict is recorded
immediately; diagrams and late messages are observed separately, by a mutation
observer on the result document, and the report stays **pending** until that
phase concludes. A relevant change — a chart inserted, replaced, resized, or
relabelled, a warning block revealed — restarts a 1 s settle window. The whole
phase is bounded at 8 s in the document and at a 12 s hold in the worker, after
which the report states that a diagram was not captured in time. Nothing waits
forever, nothing is published while pending, and a report is never mutated after
its receipt.

Each chart is rebuilt element by element into a standalone copy before anything
renders it. Only the shapes a waveform is drawn from survive (`svg`, `g`, `defs`,
`marker`, `symbol`, `clipPath`, `use`, `path`, `rect`, `line`, `polyline`,
`polygon`, `circle`, `ellipse`, `text`, `tspan`) with an allow-listed attribute
set; `script`, `style`, `a`, `image`, `filter`, and `foreignObject` have no entry
and are dropped with their subtrees. Event handlers, external schemes, and
`url()` references that do not name a surviving element of the same chart are
refused. Presentation the page supplies through its own stylesheet is copied as
resolved values so the image is not blank without it, and each value is checked
like any other attribute. The copy is never inserted into a document, so nothing
in it is resolved, fetched, or executed while it is built; no provider script is
run, and no waveform source is evaluated.

The copy is rasterized through a `data:` URL in an image's own static mode and
drawn on an opaque background, then read back as PNG bytes and parsed as a byte
structure: signature, every chunk length and CRC, an allow-listed chunk set, and
the dimensions the header itself states. Bounds are 4 per attempt, 4000×2000 px,
4 MP, 256 KiB per image, 512 KiB per attempt, and a storage ceiling well below
the profile quota. A chart that is oversized, unsupported, unreadable from the
canvas, rendered too late, or over budget is named in the report with its reason;
none is dropped silently, and a report that stored nothing says so rather than
reading as a result with no chart.

Images are published in the same commit as the source, the record, and the
report that names them, under the same per-attempt folder as `diagram-N.png`.
The report pins each image's byte count, media type, pixel dimensions, and
SHA-256, and the record pins the report. On recovery, an image whose bytes,
size, dimensions, or hash do not match what the report states is reported as
unverified rather than shown. Every diagram carries its attribution in the
report: `HDLBits` as the source, and the canonical
`https://hdlbits.01xz.net/wiki/<problem>` link, built from the validated problem
id alone and never from a URL read out of a page or a remote record. HDLBits
does not endorse this extension.

Publishing failed work is off by default. **Publish new failed attempts and
their reports automatically** can only be turned on for a verified public
destination, with the public-visibility consent given at the moment of the
choice. It applies from the moment it is turned on: attempts captured earlier
stay local, and each of them can only reach GitHub through its own confirmed
**Publish failed attempt and its report** action. Turning the setting on never
publishes history in bulk, and turning it off stops later automatic publication
without removing anything already published. Existing installations are not
opted in.

A published failed attempt adds three files, plus one per captured diagram:

```text
progress/hdlbits/<problem>/failed-<attempt UUID>/solution.v
progress/hdlbits/<problem>/failed-<attempt UUID>/attempt.json
progress/hdlbits/<problem>/failed-<attempt UUID>/report.json
progress/hdlbits/<problem>/failed-<attempt UUID>/diagram-1.png
```

The strict version-1 failed record carries `kind: "failed"`, `accepted: false`,
its outcome, the source hash and byte count, the report's own SHA-256 and byte
count, timestamps, and capture provenance. It has its own folder prefix and its
own file name, so no reader and no schema can mistake it for an acceptance: it
cannot satisfy the acceptance schema, it is counted separately in recovery, and
a record claiming acceptance, a missing report, or a report edited after
publication is reported as unverified rather than promoted. All of its files are
written in the same single commit through the same immutable transport,
idempotency, reconciliation, backoff, account binding, retry, and discard path
as accepted work; a partially written failed record cannot exist on the branch.
Failed source is learner-controlled code that will be publicly readable — the
same caution as accepted source applies, with the added fact that it did not
pass.

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
Discarding also does not forget which result documents already resolved, so a
removed attempt cannot let its old result poison a newer submission in that frame.
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

## Import earlier HDLBits solutions

Solutions finished before Progress Sync was installed can be imported without
resubmitting them. **Find earlier solutions** on the progress page reads HDLBits'
own *Load a previous submission* control through a problem page you already have
open, using your existing site session.

Imports are recorded and published as **unverified**. They are HDLBits' stored
copy plus the site's own `Last success` claim, not an acceptance this extension
observed. A historical solved badge is not evidence of acceptance and is not a
source of code: a problem marked solved whose page offers no stored submission is
reported as skipped, never as an import. Source is read only from a load the site
itself reports as successful — its own handler treats status `2` as the stored
submission and every other status as a failure carrying an error string. Any
other status is a skipped problem, and the value is still recorded verbatim as
`providerStatus` provenance, never as a verdict. Availability is also decided by
the site's own record of that problem and by validating the returned payload's
shape, encoding, and size. The problem page serves that control empty and fills
it from an inline list of its own stored submissions, so the fetched page is
parsed detached and that list is read as text; no fetched script is ever run, and
a page whose own entry states no stored success is skipped.

Which problems are looked at comes from the learner's own HDLBits statistics
page (`Special:VlgStats/Me`), read through that same open page and site session.
Its table is read through its own header row, never by column position: the
success column is the first header that names successes and is not a rate, a row
counts only when one of its own links resolves to a problem page on this origin
and its success cell holds a whole number. A page that presents no such table is
left unused rather than guessed at, and the status line then says the pass fell
back to the solved list the open page links to, which covers less. A row stating
zero successes is counted but never read for source, so a problem with failed
attempts only can never produce an imported record. Continuing a longer list
needs the statistics page again; if it cannot be read, the pass stops and says
so instead of counting against a list it did not see.

HDLBits addresses a stored submission by its **save slot** on the problem page,
and slot `0` is an ordinary slot, so it is labelled and recorded as a slot
reference rather than as a unique submission identifier.

Discovery is sequential and bounded, reports per-problem progress, and can be
cancelled; a cancelled or interrupted scan keeps whatever it already found and
says so. Each provider read has its own deadline and is dropped once it exceeds
its size budget, so a stalled or oversized response ends that problem instead of
the pass. Per-problem failures — an unreachable page, no stored success, an
unaddressable submission option, a load error, a rejected load status, a
malformed or oversized payload, a signed-out session, or an exhausted budget —
are listed individually rather than dropped.

One pass reads at most 100 solved problems and 2 MB of source. When the page
lists more than that, the status line reports how many of the listed problems
were read, and finding earlier solutions again continues from that point rather
than restarting or silently hiding the rest. A pass that fills the preview limit
says so instead of reporting a completed scan, and the next pass starts a new
preview list at the first problem it did not read. Nothing is published by
discovery: each import needs its own explicit confirmation of the public
destination. A discovery still running when the worker stops is reported as
interrupted, not resumed.

Discovery never opens or navigates a tab, never writes to the editor, and never
changes HDLBits' native completion state. Fetched markup is parsed detached from
the page, so nothing in it runs. Reads are same-origin requests. The site
canonicalizes a wiki path's case with a redirect, so a page read follows
redirects; the request mode makes any hop off the site's origin a network error,
and the page is used only when the final URL is still the problem that was asked
for. No limit on the number of same-origin hops is claimed or enforced — the
final URL is what decides. The load endpoint refuses redirects outright. Site
cookies stay with the site: they are not
read by the extension, exported, or sent to GitHub, and no site credential is
persisted. GitHub credentials are never sent to HDLBits or to content scripts.

Imported records are published under a separate `imports/` path, with their own
`import.json` metadata that pins `verified: false` and carries no verdict field.
They cannot be parsed as accepted captures, and `acceptance.json` is still only
read under `progress/`. Publication reuses the same immutable Git transport,
idempotency, reconciliation, backoff, and account binding as accepted records,
including **Check GitHub and retry delivery** and **Discard local attempt**.

A record's identity is its provider, problem, submission ID, and source hash, so
importing the same bytes again produces no second record and no second commit for
the same destination. Rediscovering the same solution in another browser profile
and publishing it to the same destination recognises the record already there:
the first record's provenance is kept, its original commit is reported as the
receipt, and nothing is written. A remote `import.json` that does not match that
identity blocks instead of being overwritten. If HDLBits returns different bytes
under the same submission identity, that is a distinct record at a distinct path:
nothing is overwritten and nothing is silently called a duplicate. Each
destination keeps its own job and its own confirmation; changing the GitHub
account or destination invalidates a previewed selection rather than redirecting
an existing record.

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

Records under `imports/` are recovered as their own imported-unverified state,
validated against the import schema, the path-to-identity association, the source
hash, the recorded byte count, and the record identity derived from the recovered
source. They stay unverified whatever their metadata claims: an edited file
asserting acceptance, a verdict, or a different state is rejected rather than
promoted, and an `import.json` placed under `progress/` is not read as acceptance.

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
- A distinct waiting, accepted-locally, recorded-failed, or unverified state,
  with the stated outcome for the first two. Accepted locally **does not** mean
  backed up to GitHub, and neither does a recorded failure.
- The submission report observed with that result: status line, supported
  structured messages, and what the report does not cover.

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

Concurrent submissions in separate tabs are tracked independently by browser
request ID, tab, result frame, and parent/result document identity. They may target
the same or different problems and finish out of order. Each accepted snapshot
enters the existing serialized, idempotent delivery coordinator with its own
attempt ID, source hash, metadata, and receipt. A failed reattempt does not change
an earlier accepted or saved attempt.

A repeated observation from an already resolved result document is rejected
without attaching it to a newer pending submission in that frame. That rejection
does not depend on the attempt still being retained locally. Malformed or
inactive-document messages cannot authorize publication. Ambiguity in one tab
does not invalidate an independent tab's observation.

Permissions:

- `storage`: local attempt records and separate session-only GitHub credentials,
  plus a credential-free local repository-setup journal, restricted to trusted
  extension contexts.
- `webRequest`: read-only observation of the HDLBits grading request body and
  request lifecycle. No cookie/header inspection, blocking, or traffic changes.
- `webNavigation`: HDLBits-filtered navigation observations and frame/document
  identity checks. This API permission is broader than the listener filter;
  the extension does not collect browsing history.
- `alarms`: expire the GitHub session and re-arm the single `delivery-retry-v1`
  wakeup for queued uploads, without keeping a page open.
- Host access: HTTPS HDLBits, `github.com`, and `api.github.com` only. GitHub
  requests originate in privileged extension contexts; there are no GitHub
  content scripts and no all-sites access.

Basic tab lifecycle events are used only to invalidate the tracked authorization
owner when its tab closes, reloads, or is discarded, and to forget a closed
HDLBits problem page that had announced itself for imports; browsing history is
not stored. Import discovery addresses only pages that announced themselves from
the HDLBits origin at a valid problem URL, and each scan is bound to that tab and
document, so a navigated, replaced, or closed page cannot continue one. That list
holds tab and document identifiers only, in session storage, not on disk.

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
- Overlapping submissions to the **same result frame** remain unsupported and
  unverified. Navigation commits do not provide the grading request ID, and the
  result does not echo a submission-specific source identifier; replacing an
  in-flight result cannot safely be treated as a new accepted attempt. Reload
  that problem and resubmit, or use separate tabs for concurrent work.
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
- Importing earlier solutions reaches only HDLBits' last successful stored
  submission per problem, because that is all the site's own load control
  exposes. Earlier versions of a solution, non-success submissions, current
  drafts, and the static editor starter template are out of reach and are never
  imported. Problems whose page offers no stored success yield nothing, however
  they are badged.
- Imports are always unverified and can never become accepted records. A load is
  read as source only when the site reports its own success status and the
  payload validates; any other status is a skipped problem. Imports need an open
  HDLBits problem page and whatever site session this browser already has,
  including a guest one with stored submissions; discovery does not open, sign
  in to, or navigate anything for you.
- One discovery pass covers at most 100 solved problems and 2 MB of source, and
  a page listing more than 2000 solved problems is not enumerated at all.
  Continuing a longer list takes repeated passes.
- **Timing diagrams are captured as images, within fixed limits.** What the
  extension captures and publishes for an attempt is the submitted source, the
  stated outcome, the status line, whichever structured compiler or simulator
  messages the current result contract exposes, and up to 4 charts the result
  drew, each rasterized to a static PNG within 4000×2000 px, 4 MP, 256 KiB per
  image and 512 KiB per attempt. Charts the result does not finish within the
  8 s observation window, or that exceed a limit or use an unsupported
  structure, are named in the report with their reason instead of being
  captured. Lesson explanations, expected or reference output tables, model
  answers, and test vectors are never copied. Where the result states only a
  status line, or drew nothing, the report says exactly that rather than
  implying a clean run or an unsupported capability. Imported history comes
  from the statistics page, so it carries no messages and no diagrams; none is
  invented for it.
- Publication waits for that observation to conclude, so a save can start up to
  8 s after the verdict. While a result is still being observed the attempt says
  so and offers no publish control; the recorded outcome itself is already
  durable.
- Failed publication is per-destination, opt-in, and forward-only. Attempts
  captured before it was turned on are published one at a time through their own
  confirmation, never in bulk, and nothing already published is removed when the
  setting is turned off.
- The layout choice applies to later saves only. Records already published keep
  their paths; there is no migration between layouts.
- A remembered GitHub token lasts only until the original expiry GitHub issued
  and is not renewed. While it is stored, anyone with this Windows account and
  browser profile can act as that GitHub identity within the App's permissions.
- Automatic resumption is local durability only. Undelivered jobs live in this
  browser profile; clearing extension storage, removing the extension, or losing
  the device loses them. Resumption also cannot outlast its bounded budget, run
  without a reauthorized original account and a verified original destination, or
  repair a permission, validation, or branch-policy rejection.

## Release readiness

The controlled tests below run the complete learner journey, including a composed
guest-to-recovery path, against synthetic credentials and controlled GitHub and
HDLBits responses. Controlled results are neither live compatibility proof nor a
security certification. **Every live gate item has now been exercised, on the one
configuration recorded here and no other.** No packaged release has been
published from this work.

Tested configuration: Chromium 153.0.8010.12, Playwright 1.63.0, pnpm 10.26.1 on
Windows, under Node.js 22 and Node.js 24.19.0. Other Chromium builds, browsers,
and platforms are untested. The earlier live guest HDLBits checks recorded under
[validation](#validation) cover only the observed capture path, not GitHub
delivery; the 2026-09-14 live run below additionally covers real GitHub
authorization, repository creation, publication, and recovery, and the
2026-09-20 live run covers native provider state, live credential isolation, and
an interrupted delivery that recovered.

### Live gate prerequisites

The remaining checks change real GitHub state, so all of the following are
required before any of them starts:

1. Explicit, current authorization from the account owner for each live run.
2. A dedicated test repository name on that explicitly authorized account,
   reserved for this check and holding no work worth keeping. A separate test
   account is optional, not required; what matters is that the destination is
   dedicated and that no unrelated repository is exposed.
3. A registered GitHub App with device flow and expiring user access tokens,
   repository **Administration: read/write** and **Contents: read/write**, and
   metadata access, installed on that account with only intended repositories
   selected.
4. That App's public client ID in [the bundled configuration](public/github-app.json).
   A client ID is never guessed or inferred; it comes from the App's own settings
   page.
5. Extension credentials obtained only through the extension's own device flow.
   A host GitHub CLI credential, personal access token, App private key, or client
   secret is never reused as an extension credential.

### Live gate checklist

Checked items record only what the 2026-09-14 and 2026-09-20 live runs actually
observed:

- [x] Device authorization completes in a real browser against the registered App.
- [x] The bundled libraries and the target browser version work together outside
      the test harness — for this Chromium build only; no other browser, channel,
      or profile type was exercised.
- [x] Administration and Contents authority is actually granted and observed.
- [x] Automatic creation of a public personal repository succeeds.
- [x] Installation selection and branch initialization behave as documented,
      with installation access left at selected repositories.
- [x] An accepted attempt is atomically published to that repository.
- [x] Guest HDLBits submissions correlate exactly, including post-submit editing
      and concurrent tabs, with the published source bytes and hash.
- [x] A fresh browser reauthorizes and recovers that saved progress independently
      of the old profile's cache, credentials, and guest state.
- [x] HDLBits' own native completion state is observed to be unaffected by a live
      run — for the site's own status region for the submitted problem, in this
      profile only.
- [x] Credential isolation is audited live, against real tokens and cookies, at
      four points of one run and across the surfaces listed below.
- [x] A live delivery is interrupted mid-publication and recovered.

Status as of 2026-09-14: an authorized live run on the account owner's own
account, with their explicit approval for this destination, completed the core
journey against the dedicated public repository
[KevinA-cpu/progress-sync-live-test](https://github.com/KevinA-cpu/progress-sync-live-test),
so prerequisites 1–5 were met for that run. The extension itself created that
public repository and verified its branch; four real guest HDLBits accepted
submissions were captured across two rounds — different problems, then the same
problem in two tabs — each round with two submissions pending at once and both
editors edited after their POSTs. Each attempt produced a distinct saved receipt
whose commit carries the solution and its metadata together and is absent from
the receipt's parent tree, confirmed by unauthenticated public reads; a genuinely
fresh profile then reauthorized and recovered all four records, leaving the
remote head unchanged. Nothing was deleted.

Status as of 2026-09-20: a second authorized live run, 07:54Z to 07:58Z on the
same dedicated public repository with the account owner approving the extension's
own device flow twice, closed the three remaining items. The repository held
10 files at head `818db00` and 14 files at head `abbd5bc` afterwards: exactly two
new commits adding exactly four paths for the run's two new attempts, each
receipt commit single-parent and introducing a solution and its metadata
together. Each published solution blob matched the captured snapshot's bytes and
hash, and each metadata file carried the matching attempt, provider, problem, and
source hash. All 10 pre-existing blob hashes were unchanged and nothing was
deleted.

The second attempt was interrupted deliberately: GitHub answered the real branch
update with HTTP 200, that response was held before the extension could record
the outcome, and the service worker was stopped. The stored job was then
`publishing` with no receipt. Restarting the worker reconciled it to the same
committed receipt, without resubmitting and without a second commit.

Native provider state was read through the site's own status region for the
submitted problem (one element, its state-bearing classes and attributes
included) in a provider page that submitted nothing. The reading taken while the
committed branch response was still held, with the worker running, was identical
to the reading taken after the extension recovered and finished publishing, and
no submission happened between them. That shows the indicator did not change in
this profile; it is not a statement about other provider states, accounts, or
browsers. The run used guest HDLBits submissions — no HDLBits site sign-in was
established, and the progress shown was the profile's own persisted guest
state — so this is not authenticated-account validation.

Credentials were audited live while connected, after the interruption, after
disconnect, and after reauthorization. The session store, the allowed credential
location, was inspected separately at each point and held 1, 1, 0, and 1 token.
The two token values seen were held in the driver's memory only, never logged or
written, and compared against 15 guarded surfaces: extension local and
synchronized storage, extension-origin IndexedDB, extension and provider page
markup, provider web storage, page-message replies, 6 console events captured
with page and service-worker monitoring retained across the worker restart, the
13 packaged extension files, and the 4 new public blobs, plus the non-GitHub
cookie jar. No credential value and no token-shaped value appeared outside the
session store, no cookie value was found in extension storage, no refresh token
was retained, and the console buffer did not overflow. Those are the surfaces
that were compared, not every surface that exists. The packaged App
configuration matched the bundled file and carried only a client ID. Cookies on
the GitHub authorization origin are that site's own traffic and are treated as
trusted, not as leakage. The public provider page had no external runtime channel
to the extension, which is an observation about that page, not an
arbitrary-message penetration audit.

Not covered by either live run: request and response headers and bodies, the
on-disk browser profile, other extensions, profiles, or browsers, worker console
output emitted before the observer attached, and any native provider state
outside the region described above. A local attempt captured in an earlier
aborted run stayed in its terminal unverified state throughout, was left
untouched, and is claimed by nothing here. Live results and the controlled tests
under [validation](#validation) together are still not a security certification.
The gate's own rules held for both runs: correlation was never weakened, broader
repository access and broader credentials were never requested, and no controlled
fixture was substituted for a live item.

Issue #12 tracks this gate. Its parent specification, issue #1, stays open and
unchanged, as that issue requires.

Completing the gate never requires deleting the test repository, its contents, or
retained local work. Record the tested browser and extension versions, the items
actually checked, and the observed limitations. Do not record credentials, device
codes, repository contents, or unnecessary account or browsing detail.

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
Conflict tests advance the remote branch before and during reference updates,
preserve same/different-problem history, reject edited or removed attempt records,
bound repeated conflicts, and reconcile lost responses and worker interruptions.

Lifecycle tests exercise retained jobs through expiry, rejected authorization,
access repair, account/repository/branch switches, delayed authorization and
reference responses, and a real browser restart. Local-discard tests cover
confirmation, credential/source removal, failed storage, active and queued jobs,
stale requests, repeated observations from a discarded attempt's result document,
and preservation of remote contents.

Resumption tests drive the real alarm, storage, and worker lifecycle interfaces
with controlled browser time and controlled network failures instead of waiting
out the production schedule. They cover offline-to-online recovery, worker
termination and re-arming, a real browser restart that waits for reauthorization
and destination verification, duplicate and overlapping wakeups that register no
alarm beyond the two named ones and none for delivery once the queue drains, an
exhausted budget, a permanent rejection that is never rescheduled, an attempt
reserved but never sent before the worker died, a write for one job that must not
disturb another left mid-publication, and injected alarm and storage failures that
must be visible and recoverable.

Rate-limit tests state deadlines in every form GitHub can use — long whole
seconds, an HTTP date, and a distant primary-limit reset — and require the
scheduled attempt and its wakeup to honour them in full. They also cover an
explicit retry refused inside a cooldown, a second captured attempt inheriting
the same authority-wide deadline, a deadline beyond the supported window, and an
unreadable `Retry-After`.

Recovery tests close the original browser and launch a fresh profile without
copying local storage or credentials. They reconnect through the real extension
and controlled GitHub boundary, retaining only the remote repository state.

Journey tests compose the whole path in one run instead of one slice at a time.
The first captures a guest attempt before any GitHub connection, then authorizes
through the device flow, creates the public repository automatically, initializes
its marker and carries that same marker into the published tree and the later
recovery, verifies the destination, captures and atomically publishes a new
attempt, publishes the older guest attempt through its explicit destination
choice, and restores both records in a separately launched browser profile that
starts with no local state, without touching the new profile's HDLBits editor or
solved state. The second keeps two tab submissions genuinely in flight, edits both
editors after their POSTs, returns the two results out of order, loses one
reference response, forces a rebase with a concurrent remote commit, disconnects
with a due wakeup that must send nothing, reauthorizes and verifies again, and
then issues duplicate retries and wakeups. It requires one effective publication
and one confirmed receipt per attempt — reconciliation and duplicate requests add
no commit or reference update, and the rebase's abandoned candidate is counted
rather than ignored — together with the exact original snapshots, distinct capture
provenance, and unmixed records.

Both journeys check credential handling while connected, after disconnect, and
after reauthorization: the access token stays in `chrome.storage.session`, and
synthetic sentinels are absent from published file contents, publication request
bodies, `chrome.storage.local`, `chrome.storage.sync`, every extension-origin
IndexedDB record, the progress page's own markup, and the console output of
extension pages, provider pages, and the extension service worker. Console capture
attaches once the worker is running and before the extension can obtain any GitHub
credential, and runs until the profile closes; output from the worker's first
moments of startup is therefore outside it. Separate tests plant each sentinel in
IndexedDB and log one from a page and from the service worker, including a worker
recreated after termination, and require the audit to report each. Four induced
IndexedDB failures — an unreadable store, a refused transaction, an unenumerable
database list, and a transaction aborted mid-read — fail the audit rather than
counting as clean, and the planted database is deleted afterwards to prove no
connection was left open. That check does not cover arbitrary page messages;
denied session access from the HDLBits content-script world and rejected page
messages are covered by the GitHub and concurrency tests instead. A third check
requires the packaged App configuration to match the bundled source configuration
exactly and to carry no credential value.

Remember-access tests use the same real browser restart. They cover the
session-only default, an opt-in restore that resumes only after its own
destination revalidates, a destination that is no longer authorized, an
unreachable GitHub and a refusal that is not a rejection both keeping the stored
copy, a rejected credential, a credential past its original expiry, an identity
that now answers as another account, turning the option off, disconnecting, a
disable racing a slow restore, and a page other than the connection page trying
to change the option. Each checks where the token is and is not, including
synchronized storage, IndexedDB, page markup, and console output.

Statistics-page tests drive the real discovery path over a controlled table read
by its header, including a success-rate column that must not be mistaken for a
count, a problem attempted many times and never passed, save slot `0`, a page
with no readable table and a signed-out page that both fall back to the solved
list, and a continuation whose statistics page has gone away. Layout tests cover
explicit adoption after work was already published under the default, a queued
job that keeps its original paths across the change, a repository dedicated to
another provider refusing a record, an import keeping its identity under the new
layout, and recovery reading a repository that holds both.

Failed-attempt tests run the whole path: the setting publishing only from the
moment it is turned on, an earlier failure needing its own confirmation, the
exact source, record, and pinned report written in one commit, a delayed failure
in one tab beside an acceptance in another, forged, malformed, and oversized
reports, a result page carrying explanations and a waveform whose extra content
must reach neither GitHub nor the interface, a confirmation for one kind of
attempt refused for the other, and recovery reading a published failed record
without ever counting it as an acceptance.

Timing-diagram tests drive original waveforms built from the element types a
result page draws with, and decode every stored image back to pixels rather than
reading its label: a failed result publishing source, record, report, and image
in one commit whose bytes match the hash, byte count, and dimensions the report
states; a chart inserted after the verdict; a chart replaced and then restyled,
each change restarting the settling window; a page that never stops redrawing,
reported as not captured in time; more charts than are stored, kept in order with
the rest named; an oversized chart refused; a chart carrying an external image, an
`@import`, a `foreignObject`, a link, an event handler, and a script, stored as
its drawing alone, with no request beyond the ones the page itself made and none
of its payload in files, interface, or console; a compile failure that drew
nothing; a worker restart mid-observation publishing once and stating the chart
was not captured; two tabs keeping their own charts; and recovery of a published
image, including a missing file, a file whose size contradicts the report, and
bytes changed after publication.

Coverage includes accepted bytes, post-submit edits and hashes, failed and stale
results, ambiguous layouts and payloads, historical/forged observations,
timeouts, independent cross-tab publication with out-of-order results, same-frame
ambiguity, stale document messages during a reattempt, page/worker recreation, correction after failure,
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

A live guest concurrency check on 2026-09-08 used a fresh Chromium 153.0.8010.12
profile and two `step_one` tabs with distinct, original constant-output solutions.
Both POSTs genuinely overlapped (about 10 seconds), returned fresh HTTP 200
results, and produced separate accepted snapshots with distinct tab, request,
parent-document, and result-document identities. Editing the first buffer after
submission did not change its captured bytes. Each submission was 102 UTF-8
bytes after form normalization, with SHA-256 hashes
`a7556de835994888e5c9abddc77e18206729161200ef6025220e7366f9515467` and
`0615819fff5faf86def377d7e9ad3519760abd55f035277c5ba926b44f268bb8`.
No credentials or GitHub requests were used. This verifies the distinct-tab
path, not same-frame overlap, other submission modes, or live GitHub delivery.
Same-frame overlap remains an explicit release limitation.

A live GitHub run on 2026-09-14 used extension 0.1.0 with Playwright 1.63.0 and
Node.js 22 on Windows, driving the same Chromium 153.0.8010.12 build. The
extension's own device flow authorized a real account with the owner present for
each consent screen, created the dedicated public repository, published four real
guest HDLBits attempts, and recovered them in a fresh profile; verification used
unauthenticated public reads only. Live credential isolation, HDLBits native
completion state, and mid-delivery interruption were not exercised there; a
second live run on 2026-09-20, same browser build under Node.js 24.19.0, covered
those three on the same dedicated repository and is recorded under
[release readiness](#release-readiness). Every future live run still requires
current, explicit account-owner authorization and a dedicated destination.

Importing earlier solutions was additionally checked against the real provider on
2026-09-21, read-only and with no GitHub involvement: no device flow, no publish,
no submission, no remote write. Discovery and preview ran from the options page in
the dedicated profile over the account owner's existing HDLBits session. Five
consecutive problems previewed, each labelled imported-unverified with the site's
own last-success claim and a load the site reported as status `2`; the open
problem page kept its editor contents, its native solved indicator, and its URL.
That check found two provider mismatches fixture pages had hidden — the site
canonicalizes a wiki path's case with a redirect, and it fills the previous
submission control from an inline list rather than serving it populated — both of
which are now part of the adapter and its fixtures.

Redirect handling is covered outside the extension fixture, because Playwright
does not re-intercept the hop a fulfilled redirect generates. Two local
`node:http` servers and a plain browser page issue the adapter's exact page-read
options: a same-origin case canonicalization is followed to its final URL, a hop
to another origin fails outright, and a same-origin hop to another problem still
returns a page, so only the final-URL check rejects it. That check is tested
directly over constructed URLs. No external site is contacted.

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
