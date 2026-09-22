// A submission report holds the learner-specific parts of one graded result: the status line, the compiler and
// simulator messages the result states, and the timing diagrams it drew, rasterized to static images. Lesson
// explanations, reference solutions, hidden test definitions, and arbitrary page markup are never copied.
export const REPORT_KIND = 'report';
export const REPORT_FILE = 'report.json';
export const MAX_REPORT_STATUS = 512;
export const MAX_REPORT_MESSAGE = 1024;
export const MAX_REPORT_MESSAGES = 64;
export const MAX_REPORT_BYTES = 64 * 1024;
export const REPORT_SEVERITY = { error: 'error', warning: 'warning', info: 'info' } as const;

// Where the result states its own diagnostics. Only these containers are read, and the explanatory prose beside
// them is excluded: it is lesson material, not a message about this submission.
export const RESULT_SELECTOR = {
  messages: '.warn_msgs, .msgbox',
  excluded: '.warn_expl',
  severity: { error: '.msg_error', warning: '.msg_warn', info: '.msg_hint, .msg_none' },
  diagramContainer: '.timingbox, [id^="WaveDrom_Display"]',
  diagram: 'svg',
  unread: 'pre',
} as const;

// Diagram bounds. They cap what one result can put into local storage, into a message, and into a commit.
export const DIAGRAM_MEDIA_TYPE = 'image/png';
export const DIAGRAM_EXTENSION = '.png';
export const MAX_DIAGRAMS = 4;
export const MAX_DIAGRAM_WIDTH = 4000;
export const MAX_DIAGRAM_HEIGHT = 2000;
export const MAX_DIAGRAM_PIXELS = 4_000_000;
export const MAX_DIAGRAM_BYTES = 256 * 1024;
export const MAX_DIAGRAM_TOTAL_BYTES = 512 * 1024;
export const MAX_DIAGRAM_ELEMENTS = 20_000;
export const MAX_DIAGRAM_SOURCE_BYTES = 2 * 1024 * 1024;
// How many charts one result may be inspected for at all. Everything past this is refused as over the limit
// rather than rasterized, so a page full of invalid charts cannot spend the whole observation budget.
export const MAX_DIAGRAM_CANDIDATES = 8;
// One refusal is recorded per inspected chart, plus one for anything beyond the inspected count, plus one per
// stored image that later fails its integrity check. Every refusal fits, so none is ever dropped to make a
// report parse.
export const MAX_DIAGRAM_REJECTIONS = MAX_DIAGRAM_CANDIDATES + MAX_DIAGRAMS + 1;
export const DIAGRAM_NAME = (index: number) => `diagram-${index}${DIAGRAM_EXTENSION}`;
export const DIAGRAM_NAME_PATTERN = /^diagram-[1-9]\.png$/;
// Images are held outside the attempt list so reading progress never parses megabytes, and one key per attempt
// means discarding an attempt drops exactly its own images.
export const DIAGRAM_STORE_PREFIX = 'diagram-images-v1:';
export const DIAGRAM_STORE_KEY = (attemptId: string) => `${DIAGRAM_STORE_PREFIX}${attemptId}`;
// Chrome gives this profile a fixed local storage quota. Images stop being stored well before it is reached,
// so they can never crowd out attempts, jobs, or a recovered snapshot.
export const MAX_LOCAL_STORAGE_BYTES = 8 * 1024 * 1024;

// The artifact phase runs after the verdict is already recorded. This provider states nothing that means
// "rendering finished": its message box is in the document from the first paint whether or not the compiler
// said anything, and a chart already drawn does not rule out a second one or a warning arriving later. So
// readiness is never inferred from a container merely existing, nor from a short quiet gap. The phase observes
// for a fixed minimum after the result document has finished loading, every relevant change restarts the settle
// window, and the deadline bounds the whole phase. Rasterizing what was found has its own budget, and the
// background hold covers both so a conclusion reached late is still delivered.
export const ARTIFACT_MINIMUM_MS = 5_000;
export const ARTIFACT_SETTLE_MS = 2_000;
export const ARTIFACT_DEADLINE_MS = 15_000;
export const ARTIFACT_CAPTURE_BUDGET_MS = 10_000;
export const ARTIFACT_HOLD_MS = 30_000;

// What the artifact phase of one result concluded. A report always states one of these, so a diagram that never
// arrived is visible as such instead of reading as a result that had none.
export const ARTIFACT_STATE = {
  pending: 'pending', complete: 'complete', partial: 'partial', none: 'none',
  deadline: 'deadline', rejected: 'rejected',
} as const;
export type ArtifactState = (typeof ARTIFACT_STATE)[keyof typeof ARTIFACT_STATE];
// Why a diagram that was present was not stored. Each one is reported; none is ever silently dropped.
export const DIAGRAM_REJECTION = {
  oversize: 'oversize', unsupported: 'unsupported', renderFailed: 'render-failed',
  tainted: 'tainted', limit: 'limit', invalid: 'invalid', deadline: 'deadline',
} as const;
export type DiagramRejection = (typeof DIAGRAM_REJECTION)[keyof typeof DIAGRAM_REJECTION];

export const REPORT_PROVIDER_NAME = 'HDLBits';

export const REPORT_TEXT = {
  heading: 'Submission report',
  statusLabel: 'Provider status line',
  messagesLabel: 'Compiler and simulator messages',
  sourceLabel: 'Report source',
  sourceValue: 'Read from the observed result document of this submission',
  // Stated wherever a report is shown, so an absent diagnostics block is never read as a clean result.
  noMessages: 'No compiler or simulator messages were stated by this result.',
  partialMessages: 'Some blocks on this result used a structure this extension does not read. Only recognised messages are stored.',
  trimmedMessages: 'This result stated more messages than a report may hold. The last of them were dropped so the rest could be stored.',
  diagramsHeading: 'Timing diagrams',
  diagramsPending: 'The timing diagrams and messages for this result are still being observed.',
  diagramsNone: 'This result drew no timing diagram.',
  diagramsDeadline: 'A timing diagram did not finish rendering within the observation window, so it was not captured.',
  diagramsRejectedAll: 'A timing diagram was present but none of it could be stored safely.',
  diagramsLegacy: 'This attempt was captured before timing diagrams were stored, so none were captured.',
  diagramsPartial: (kept: number, rejected: number) =>
    `${kept} timing diagram${kept === 1 ? '' : 's'} stored; ${rejected} not stored.`,
  diagramsLocal: 'The captured images are held in this browser profile until the attempt is published or discarded.',
  diagramsUnavailable: 'The captured image is no longer held in this browser profile.',
  rejectionLabel: 'Not stored',
  rejectionReason: {
    oversize: 'A diagram exceeded the supported size.',
    unsupported: 'A diagram used an unsupported structure.',
    'render-failed': 'A diagram could not be converted to an image.',
    tainted: 'A diagram could not be read back from the drawing surface.',
    limit: 'More diagrams were present, or more image bytes, than are stored per attempt.',
    invalid: 'A diagram image failed its integrity check.',
    deadline: 'A diagram was still changing when the observation window ended.',
  } as const satisfies Record<DiagramRejection, string>,
  imageAlt: (index: number, problemId: string | null) => problemId === null
    ? `Timing diagram ${index} captured for this submission`
    : `Timing diagram ${index} captured for ${problemId}`,
  showLabel: (name: string) => `Show ${name}`,
  downloadLabel: (name: string) => `Download ${name}`,
  attributionLabel: 'Diagram source',
  attributionValue: `Rendered by ${REPORT_PROVIDER_NAME} from this submission`,
  attributionNotice: `${REPORT_PROVIDER_NAME} does not endorse this extension.`,
  problemLinkLabel: 'Problem page',
  importedNoDiagrams: 'Imported history is read from the statistics page, so it carries no messages and no diagrams.',
  invalid: 'The submission report is unsupported or malformed. It was not stored.',
  oversized: 'The submission report exceeds the supported size. It was not stored.',
  publishedLabel: 'Report',
  publishedValue: (hash: string) => `${REPORT_FILE} (SHA-256 ${hash})`,
  diagramPublishedValue: (name: string, width: number, height: number, hash: string) =>
    `${name} (${width}x${height}, SHA-256 ${hash})`,
} as const;
