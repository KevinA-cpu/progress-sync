# Progress Sync

Progress Sync starts with a local record of exact HDLBits submissions. This first
slice implements [ticket #2](https://github.com/KevinA-cpu/progress-sync/issues/2).
**GitHub authorization, uploads, and cross-browser recovery are not implemented yet.**

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

Chromium 120 or newer is required. The currently tested browser version is
153.0.8010.12. The production build needs no local server.

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

- `storage`: local attempt records, restricted to trusted extension contexts.
- `webRequest`: read-only observation of the HDLBits grading request body and
  request lifecycle. No cookie/header inspection, blocking, or traffic changes.
- `webNavigation`: HDLBits-filtered navigation observations and frame/document
  identity checks. This API permission is broader than the listener filter;
  the extension does not collect browsing history.
- Host access: only `https://hdlbits.01xz.net/*`. No GitHub or all-sites access.

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

Relevant platform contracts:

- [Chrome webRequest](https://developer.chrome.com/docs/extensions/reference/api/webRequest)
- [Chrome webNavigation and event ordering](https://developer.chrome.com/docs/extensions/reference/api/webNavigation)
- [Chrome storage access levels](https://developer.chrome.com/docs/extensions/reference/api/storage)
