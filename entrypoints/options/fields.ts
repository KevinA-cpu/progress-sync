import { DOM_EVENT } from '../../lib/constants/browser';
import { ARTIFACT_STATE, DIAGRAM_MEDIA_TYPE, REPORT_TEXT } from '../../lib/constants/report';
import type { CapturedReport, Diagram, DiagramImage } from '../../lib/report';

// Either a captured report or the record published with an attempt: the parts shown here are the same.
type RenderableReport = Pick<CapturedReport, 'status' | 'messages' | 'coverage'>
  & Partial<Pick<CapturedReport, 'diagrams' | 'attribution'>>;
export interface ReportView {
  problemId?: string | null;
  // Bytes already held in this profile, if any, and a way to ask for published ones that are not.
  images?: DiagramImage[] | null;
  request?: (diagram: Diagram) => Promise<DiagramImage>;
}

export function renderMetadata(values: Record<string, string>): HTMLDListElement {
  const metadata = document.createElement('dl');
  for (const [label, value] of Object.entries(values)) {
    const term = document.createElement('dt');
    const description = document.createElement('dd');
    term.textContent = label;
    description.textContent = value;
    metadata.append(term, description);
  }
  return metadata;
}

// A captured image is rendered from its own bytes as a data URL: nothing is fetched, no page markup is reused,
// and the same bytes back the download link.
function renderImage(image: DiagramImage, diagram: Diagram, index: number, problemId: string | null): HTMLElement {
  const source = `data:${DIAGRAM_MEDIA_TYPE};base64,${image.data}`;
  const figure = document.createElement('figure');
  const picture = document.createElement('img');
  picture.src = source;
  picture.width = diagram.width;
  picture.height = diagram.height;
  picture.alt = REPORT_TEXT.imageAlt(index, problemId);
  const caption = document.createElement('figcaption');
  caption.textContent = REPORT_TEXT.diagramPublishedValue(
    diagram.name, diagram.width, diagram.height, diagram.hash,
  );
  const download = document.createElement('a');
  download.href = source;
  download.download = diagram.name;
  download.textContent = REPORT_TEXT.downloadLabel(diagram.name);
  figure.append(picture, caption, download);
  return figure;
}

function renderDiagrams(report: RenderableReport, view: ReportView): HTMLElement[] {
  const diagrams = report.diagrams ?? [];
  const nodes: HTMLElement[] = [];
  const heading = document.createElement('h4');
  heading.textContent = REPORT_TEXT.diagramsHeading;
  nodes.push(heading);
  const state = document.createElement('p');
  const rejected = report.coverage.rejected ?? [];
  switch (report.coverage.artifacts) {
    case undefined:
      state.textContent = REPORT_TEXT.diagramsLegacy;
      break;
    case ARTIFACT_STATE.pending:
      state.textContent = REPORT_TEXT.diagramsPending;
      break;
    case ARTIFACT_STATE.none:
      state.textContent = REPORT_TEXT.diagramsNone;
      break;
    case ARTIFACT_STATE.deadline:
      state.textContent = REPORT_TEXT.diagramsDeadline;
      break;
    case ARTIFACT_STATE.rejected:
      state.textContent = REPORT_TEXT.diagramsRejectedAll;
      break;
    case ARTIFACT_STATE.partial:
    case ARTIFACT_STATE.complete:
      state.textContent = REPORT_TEXT.diagramsPartial(diagrams.length, rejected.length);
      break;
  }
  nodes.push(state);
  // Every diagram that was present but not stored is named with its reason; none is dropped silently.
  if (rejected.length > 0) {
    const reasons = document.createElement('ul');
    for (const reason of rejected) {
      const item = document.createElement('li');
      item.className = 'unverified';
      item.textContent = `${REPORT_TEXT.rejectionLabel}: ${REPORT_TEXT.rejectionReason[reason]}`;
      reasons.append(item);
    }
    nodes.push(reasons);
  }
  const problemId = view.problemId ?? null;
  if (diagrams.length > 0 && view.images && view.images.length > 0) {
    const local = document.createElement('p');
    local.textContent = REPORT_TEXT.diagramsLocal;
    nodes.push(local);
  }
  diagrams.forEach((diagram, index) => {
    const held = view.images?.find(image => image.name === diagram.name);
    if (held) {
      nodes.push(renderImage(held, diagram, index + 1, problemId));
      return;
    }
    const placeholder = document.createElement('figure');
    const caption = document.createElement('figcaption');
    caption.textContent = REPORT_TEXT.diagramPublishedValue(
      diagram.name, diagram.width, diagram.height, diagram.hash,
    );
    placeholder.append(caption);
    const request = view.request;
    if (!request) {
      const missing = document.createElement('p');
      missing.textContent = REPORT_TEXT.diagramsUnavailable;
      placeholder.append(missing);
    } else {
      const load = document.createElement('button');
      load.type = 'button';
      load.textContent = REPORT_TEXT.showLabel(diagram.name);
      const outcome = document.createElement('p');
      load.addEventListener(DOM_EVENT.click, async () => {
        load.disabled = true;
        try {
          const image = await request(diagram);
          placeholder.replaceWith(renderImage(image, diagram, index + 1, problemId));
        } catch (error) {
          outcome.className = 'unverified';
          outcome.textContent = error instanceof Error ? error.message : REPORT_TEXT.diagramsUnavailable;
          load.disabled = false;
        }
      });
      placeholder.append(load, outcome);
    }
    nodes.push(placeholder);
  });
  // Attribution is shown wherever a diagram is, whether or not its bytes are on hand here.
  if (report.attribution) {
    const attribution = renderMetadata({
      [REPORT_TEXT.attributionLabel]: REPORT_TEXT.attributionValue,
    });
    const notice = document.createElement('p');
    notice.textContent = report.attribution.notice;
    const link = document.createElement('a');
    link.href = report.attribution.problemUrl;
    link.textContent = `${REPORT_TEXT.problemLinkLabel}: ${report.attribution.problemUrl}`;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    nodes.push(attribution, link, notice);
  }
  return nodes;
}

// Report text is written as text content only: no markup is parsed and no URL from a page is followed. What
// the capture actually covered, including diagrams it could not store, is stated on every report.
export function renderReport(report: RenderableReport, view: ReportView = {}): HTMLElement {
  const section = document.createElement('section');
  const heading = document.createElement('h3');
  heading.textContent = REPORT_TEXT.heading;
  section.append(heading, renderMetadata({
    [REPORT_TEXT.statusLabel]: report.status,
    [REPORT_TEXT.sourceLabel]: REPORT_TEXT.sourceValue,
  }));
  if (report.messages.length === 0) {
    const none = document.createElement('p');
    none.textContent = REPORT_TEXT.noMessages;
    section.append(none);
  } else {
    const label = document.createElement('p');
    label.textContent = REPORT_TEXT.messagesLabel;
    const list = document.createElement('ul');
    for (const message of report.messages) {
      const item = document.createElement('li');
      item.className = message.severity;
      item.textContent = message.text;
      list.append(item);
    }
    section.append(label, list);
  }
  if (report.coverage.partialMessages) {
    const partial = document.createElement('p');
    partial.className = 'unverified';
    partial.textContent = REPORT_TEXT.partialMessages;
    section.append(partial);
  }
  if (report.coverage.trimmedMessages) {
    const trimmed = document.createElement('p');
    trimmed.className = 'unverified';
    trimmed.textContent = REPORT_TEXT.trimmedMessages;
    section.append(trimmed);
  }
  section.append(...renderDiagrams(report, view));
  return section;
}

export function renderSource(labelText: string, text: string): HTMLLabelElement {
  const label = document.createElement('label');
  label.textContent = labelText;
  const source = document.createElement('textarea');
  source.readOnly = true;
  source.value = text;
  source.rows = Math.min(18, Math.max(4, text.split('\n').length));
  label.append(source);
  return label;
}
