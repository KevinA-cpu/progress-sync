import {
  ARTIFACT_STATE, DIAGRAM_MEDIA_TYPE, DIAGRAM_NAME, DIAGRAM_NAME_PATTERN, DIAGRAM_REJECTION,
  MAX_DIAGRAM_BYTES, MAX_DIAGRAM_HEIGHT, MAX_DIAGRAM_PIXELS, MAX_DIAGRAM_REJECTIONS, MAX_DIAGRAM_TOTAL_BYTES,
  MAX_DIAGRAM_WIDTH, MAX_DIAGRAMS, MAX_REPORT_MESSAGE, MAX_REPORT_MESSAGES, MAX_REPORT_STATUS,
  REPORT_PROVIDER_NAME, REPORT_SEVERITY, REPORT_TEXT,
} from './constants/report';
import { HDL_PROBLEM_PREFIX } from './constants/progress';
import { z } from './schema';

// Anything that looks like a credential is replaced before the text is stored. Nothing on a result page should
// contain one, so a match means something unexpected was read rather than a message worth keeping verbatim.
const SECRET_SHAPE = /\b(gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{16,}|ey[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})/g;
const REDACTED = '[redacted]';

// Report text is inert data: it is read from textContent, never from markup, and is only ever written back into
// a text node. This bounds it and removes control characters; it is not HTML sanitization and no caller may
// treat the result as safe markup.
export function sanitizeReportText(value: string | null | undefined, limit: number): string | null {
  if (typeof value !== 'string') return null;
  const cleaned = value
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u2028\u2029]/g, ' ')
    .replace(SECRET_SHAPE, REDACTED)
    .replace(/[^\S\n]+$/gm, '')
    .trim();
  if (cleaned.length === 0) return null;
  return cleaned.slice(0, limit);
}

// Decoded length of base64 text, without decoding it.
function base64ByteLength(data: string): number {
  const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0;
  return Math.max(0, (data.length / 4) * 3 - padding);
}

export const reportHashSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const reportStatusSchema = z.string().min(1).max(MAX_REPORT_STATUS)
  .refine(text => sanitizeReportText(text, MAX_REPORT_STATUS) === text);
export const reportMessageSchema = z.strictObject({
  severity: z.enum(REPORT_SEVERITY),
  text: z.string().min(1).max(MAX_REPORT_MESSAGE)
    .refine(text => sanitizeReportText(text, MAX_REPORT_MESSAGE) === text),
});
export type ReportMessage = z.infer<typeof reportMessageSchema>;
// A stored diagram is described by what it is, not by where it came from: no page URL, no element markup, and
// no style reference survives rasterization.
export const diagramSchema = z.strictObject({
  name: z.string().regex(DIAGRAM_NAME_PATTERN),
  mediaType: z.literal(DIAGRAM_MEDIA_TYPE),
  width: z.int().min(1).max(MAX_DIAGRAM_WIDTH),
  height: z.int().min(1).max(MAX_DIAGRAM_HEIGHT),
  byteLength: z.int().min(1).max(MAX_DIAGRAM_BYTES),
  hash: reportHashSchema,
}).refine(diagram => diagram.width * diagram.height <= MAX_DIAGRAM_PIXELS);
export type Diagram = z.infer<typeof diagramSchema>;
// Image bytes travel and are held as base64 text, bounded by the same per-image byte limit.
export const diagramImageSchema = z.strictObject({
  name: z.string().regex(DIAGRAM_NAME_PATTERN),
  data: z.string().min(1).max(Math.ceil(MAX_DIAGRAM_BYTES / 3) * 4).regex(/^[A-Za-z0-9+/]+={0,2}$/),
});
// The same per-attempt byte budget the report states applies to the bytes themselves, wherever they are held.
export const diagramImagesSchema = z.array(diagramImageSchema).max(MAX_DIAGRAMS)
  .refine(images => new Set(images.map(image => image.name)).size === images.length)
  .refine(images => images.reduce((total, image) => total + base64ByteLength(image.data), 0)
    <= MAX_DIAGRAM_TOTAL_BYTES);
export type DiagramImage = z.infer<typeof diagramImageSchema>;
// The problem page link is a fixed origin and path plus the problem name, so nothing read from a page or from a
// remote record can turn it into a request somewhere else.
export const problemUrlSchema = z.string().max(256)
  .refine(url => url.startsWith(HDL_PROBLEM_PREFIX)
    && /^[A-Za-z0-9][A-Za-z0-9_]{0,127}$/.test(url.slice(HDL_PROBLEM_PREFIX.length)));
export const reportAttributionSchema = z.strictObject({
  provider: z.literal(REPORT_PROVIDER_NAME),
  problemUrl: problemUrlSchema,
  notice: z.literal(REPORT_TEXT.attributionNotice),
});
// coverage states what this provider's result actually exposed and what the artifact phase concluded, so a
// report is never read as a complete diagnostic record it cannot be.
export const reportCoverageSchema = z.strictObject({
  statusLine: z.literal(true),
  diagnosticMessages: z.boolean(),
  partialMessages: z.boolean().optional(),
  // Set when the report did not fit its byte limit and the last stated messages were dropped to make it fit,
  // so a shortened list is never read as everything the result said.
  trimmedMessages: z.boolean().optional(),
  timingDiagram: z.boolean(),
  artifacts: z.enum(ARTIFACT_STATE).optional(),
  rejected: z.array(z.enum(DIAGRAM_REJECTION)).max(MAX_DIAGRAM_REJECTIONS).optional(),
});
export const reportFieldsSchema = z.strictObject({
  schemaVersion: z.literal(1),
  status: reportStatusSchema,
  messages: z.array(reportMessageSchema).max(MAX_REPORT_MESSAGES),
  // Absent on reports captured before diagrams were stored, which stay readable unchanged.
  diagrams: z.array(diagramSchema).max(MAX_DIAGRAMS).optional(),
  attribution: reportAttributionSchema.optional(),
  coverage: reportCoverageSchema,
});
type ReportFields = z.infer<typeof reportFieldsSchema>;

// Every claim a report makes about itself has to follow from its own contents. Two identical charts are an
// ordinary thing for a result to draw, so images are told apart by their own names and never by their bytes.
export function consistent(report: ReportFields): boolean {
  const diagrams = report.diagrams ?? [];
  const rejected = report.coverage.rejected ?? [];
  if (report.coverage.diagnosticMessages !== (report.messages.length > 0)) return false;
  if (report.coverage.timingDiagram !== (diagrams.length > 0)) return false;
  if ((report.attribution !== undefined) !== (diagrams.length > 0)) return false;
  if (diagrams.some((diagram, index) => diagram.name !== DIAGRAM_NAME(index + 1))) return false;
  if (diagrams.reduce((total, diagram) => total + diagram.byteLength, 0) > MAX_DIAGRAM_TOTAL_BYTES) return false;
  switch (report.coverage.artifacts) {
    case undefined: return diagrams.length === 0 && rejected.length === 0;
    case ARTIFACT_STATE.pending:
    case ARTIFACT_STATE.none: return diagrams.length === 0 && rejected.length === 0;
    case ARTIFACT_STATE.complete: return diagrams.length > 0 && rejected.length === 0;
    case ARTIFACT_STATE.partial: return diagrams.length > 0 && rejected.length > 0;
    case ARTIFACT_STATE.rejected: return diagrams.length === 0 && rejected.length > 0;
    case ARTIFACT_STATE.deadline: return diagrams.length === 0;
  }
}

export const capturedReportSchema = reportFieldsSchema.refine(consistent);
export type CapturedReport = z.infer<typeof capturedReportSchema>;
// A report that still states pending has not finished its artifact phase and is never published.
export const finalizedReportSchema = capturedReportSchema
  .refine(report => report.coverage.artifacts !== ARTIFACT_STATE.pending);

export function isPendingReport(report: CapturedReport | undefined): boolean {
  return report?.coverage.artifacts === ARTIFACT_STATE.pending;
}

// The one attribution link a problem may carry, built from the validated problem id alone. Nothing read from a
// page or from a remote record can turn it into a link to a different problem or to somewhere else.
export function attributionUrl(problemId: string): string | null {
  if (!/^[a-z0-9][a-z0-9_]{0,127}$/.test(problemId)) return null;
  return `${HDL_PROBLEM_PREFIX}${problemId.charAt(0).toUpperCase()}${problemId.slice(1)}`;
}

// A report has to describe the attempt it is stored with: its attribution names that problem's page and no
// other. Applied wherever a report is accepted - at capture, before publication, and on recovery - so a
// rewritten record cannot pass a pinned hash while pointing somewhere else.
export function describesProblem(report: Pick<ReportFields, 'attribution' | 'diagrams'>, problemId: string): boolean {
  if (report.attribution === undefined) return (report.diagrams ?? []).length === 0;
  const link = attributionUrl(problemId);
  return link !== null && report.attribution.problemUrl === link;
}
