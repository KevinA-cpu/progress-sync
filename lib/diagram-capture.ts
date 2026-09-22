import {
  ARTIFACT_CAPTURE_BUDGET_MS, DIAGRAM_MEDIA_TYPE, DIAGRAM_NAME, DIAGRAM_REJECTION, MAX_DIAGRAM_BYTES,
  MAX_DIAGRAM_CANDIDATES, MAX_DIAGRAM_ELEMENTS, MAX_DIAGRAM_HEIGHT, MAX_DIAGRAM_PIXELS,
  MAX_DIAGRAM_SOURCE_BYTES, MAX_DIAGRAM_TOTAL_BYTES, MAX_DIAGRAM_WIDTH, MAX_DIAGRAMS, MAX_REPORT_MESSAGE,
  MAX_REPORT_MESSAGES, REPORT_SEVERITY, RESULT_SELECTOR, type DiagramRejection,
} from './constants/report';
import { decodeBase64, encodeBase64, hashBytes, readPng } from './diagram';
import { sanitizeReportText, type Diagram, type ReportMessage } from './report';

const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';
const XLINK_NAMESPACE = 'http://www.w3.org/1999/xlink';
const SVG_MEDIA_TYPE = 'image/svg+xml';
const IMAGE_LOAD_TIMEOUT_MS = 3_000;

// Only the shapes a timing chart is drawn from survive. Anything that can load, script, or embed - image,
// foreignObject, script, style, a, filter - has no entry here and is dropped with the subtree it introduces.
const ALLOWED_ELEMENTS = new Set([
  'svg', 'g', 'defs', 'marker', 'symbol', 'clipPath', 'use', 'path', 'rect', 'line', 'polyline', 'polygon',
  'circle', 'ellipse', 'text', 'tspan',
]);
const ALLOWED_ATTRIBUTES = new Set([
  'id', 'href', 'd', 'x', 'y', 'x1', 'y1', 'x2', 'y2', 'cx', 'cy', 'r', 'rx', 'ry', 'dx', 'dy', 'width',
  'height', 'points', 'transform', 'viewBox', 'preserveAspectRatio', 'overflow', 'orient', 'refX', 'refY',
  'markerWidth', 'markerHeight', 'markerUnits', 'clipPathUnits', 'text-anchor', 'dominant-baseline',
  'alignment-baseline', 'font-family', 'font-size', 'font-weight', 'font-style', 'letter-spacing', 'fill',
  'fill-opacity', 'fill-rule', 'stroke', 'stroke-width', 'stroke-opacity', 'stroke-dasharray', 'stroke-linecap',
  'stroke-linejoin', 'stroke-miterlimit', 'opacity', 'display', 'visibility', 'shape-rendering',
  'vector-effect', 'marker-start', 'marker-mid', 'marker-end', 'clip-path', 'xml:space',
]);
// What the chart actually looks like on the page. A stylesheet rule beats a presentation attribute in the
// cascade, so the resolved value is the one that is copied and it replaces any attribute of the same name;
// copying the attribute instead would store an image that differs from the chart the learner saw. Each value is
// checked like any other attribute before it is used.
const PRESENTATION_STYLES = [
  'fill', 'fill-opacity', 'fill-rule', 'stroke', 'stroke-width', 'stroke-opacity', 'stroke-dasharray',
  'stroke-linecap', 'stroke-linejoin', 'stroke-miterlimit', 'font-family', 'font-size', 'font-weight',
  'font-style', 'letter-spacing', 'text-anchor', 'dominant-baseline', 'opacity', 'shape-rendering',
  'vector-effect', 'marker-start', 'marker-mid', 'marker-end', 'clip-path', 'display', 'visibility',
];
// Whether an element is drawn where it stands. Definitions are not, and the browser answers "not displayed"
// for them and for everything inside them, so their own display and visibility are left as the chart wrote
// them: copying that answer would erase markers and clipped shapes the chart does use.
const DEFINITION_ELEMENTS = new Set(['defs', 'marker', 'symbol', 'clipPath']);
const LAYOUT_STYLES = new Set(['display', 'visibility']);
// Elements that paint nothing. Dropping one loses no part of the picture; dropping anything else would, so the
// chart is refused instead of being stored as a copy that is missing something the learner could see.
const IGNORABLE_ELEMENTS = new Set(['title', 'desc', 'metadata']);
const SAFE_ID = /^[A-Za-z][\w.:-]{0,63}$/;
const LOCAL_REFERENCE = /^url\(['"]?#([A-Za-z][\w.:-]{0,63})['"]?\)$/;
const LOCAL_FRAGMENT = /^#([A-Za-z][\w.:-]{0,63})$/;
const MAX_VALUE_LENGTH = 1024;

export interface CapturedMessages {
  messages: ReportMessage[];
  partial: boolean;
}

function severityOf(container: Element, text: string): ReportMessage['severity'] {
  if (container.matches(RESULT_SELECTOR.severity.error) || /^\s*(error|fatal)\b/i.test(text)) {
    return REPORT_SEVERITY.error;
  }
  if (container.matches(RESULT_SELECTOR.severity.warning) || /^\s*warning\b/i.test(text)) {
    return REPORT_SEVERITY.warning;
  }
  return REPORT_SEVERITY.info;
}

// Reads the diagnostic containers this result states, one line per message. The explanatory prose beside them
// is lesson material and is removed before the text is read; nothing else on the page is touched.
export function collectMessages(root: Document): CapturedMessages {
  const containers = [...root.querySelectorAll(RESULT_SELECTOR.messages)]
    .filter(element => !element.parentElement?.closest(RESULT_SELECTOR.messages));
  const messages: ReportMessage[] = [];
  let partial = false;
  for (const container of containers) {
    const clone = container.cloneNode(true) as Element;
    for (const excluded of clone.querySelectorAll(RESULT_SELECTOR.excluded)) excluded.remove();
    for (const line of (clone.textContent ?? '').split('\n')) {
      const text = sanitizeReportText(line, MAX_REPORT_MESSAGE);
      if (text === null) continue;
      if (line.trim().length > MAX_REPORT_MESSAGE) partial = true;
      if (messages.length >= MAX_REPORT_MESSAGES) {
        partial = true;
        break;
      }
      messages.push({ severity: severityOf(container, text), text });
    }
  }
  // Blocks outside a recognised container are not read at all rather than guessed at, and that is stated.
  partial ||= [...root.querySelectorAll(RESULT_SELECTOR.unread)]
    .some(block => !block.closest(RESULT_SELECTOR.messages));
  return { messages, partial };
}

// Every chart the result drew, in document order, outermost only.
export function collectDiagrams(root: Document): SVGSVGElement[] {
  const containers = [...root.querySelectorAll(RESULT_SELECTOR.diagramContainer)];
  const scopes: (Document | Element)[] = containers.length > 0 ? containers : [root];
  const found: SVGSVGElement[] = [];
  for (const scope of scopes) {
    for (const svg of scope.querySelectorAll(RESULT_SELECTOR.diagram)) {
      if (svg instanceof SVGSVGElement && !svg.parentElement?.closest(RESULT_SELECTOR.diagram)
        && !found.includes(svg)) found.push(svg);
    }
  }
  return found;
}

function localIds(svg: SVGSVGElement): Set<string> {
  const ids = new Set<string>();
  for (const element of svg.querySelectorAll('[id]')) {
    if (ALLOWED_ELEMENTS.has(element.localName) && SAFE_ID.test(element.id)) ids.add(element.id);
  }
  return ids;
}

// No markup, no scheme, and no reference out of this chart. A reference is kept only when it names an element
// of the same chart that survived sanitization.
function acceptValue(name: string, value: string, ids: Set<string>): string | null {
  if (value.length === 0 || value.length > MAX_VALUE_LENGTH || /[<>\\]/.test(value)) return null;
  if (name === 'id') return SAFE_ID.test(value) ? value : null;
  if (name === 'href') {
    const id = LOCAL_FRAGMENT.exec(value)?.[1];
    return id !== undefined && ids.has(id) ? `#${id}` : null;
  }
  if (/url\(/i.test(value)) {
    const id = LOCAL_REFERENCE.exec(value)?.[1];
    return id !== undefined && ids.has(id) ? `url(#${id})` : null;
  }
  return /[A-Za-z][\w+.-]*:/.test(value) ? null : value;
}

// Builds a standalone copy of the chart from scratch. The copy is never inserted into a document, so nothing in
// it is ever resolved, fetched, or run while it is being built.
function sanitizeElement(
  source: Element, ids: Set<string>, budget: { count: number }, defined: boolean,
): Element | null {
  if (budget.count++ >= MAX_DIAGRAM_ELEMENTS) return null;
  const target = document.createElementNS(SVG_NAMESPACE, source.localName);
  for (const attribute of source.attributes) {
    const name = attribute.namespaceURI === XLINK_NAMESPACE ? attribute.localName : attribute.name;
    if (!ALLOWED_ATTRIBUTES.has(name) || target.hasAttribute(name)) continue;
    const value = acceptValue(name, attribute.value.trim(), ids);
    if (value !== null) target.setAttribute(name, value);
  }
  const inside = defined || DEFINITION_ELEMENTS.has(source.localName);
  const computed = window.getComputedStyle(source);
  for (const property of PRESENTATION_STYLES) {
    if (!ALLOWED_ATTRIBUTES.has(property)) continue;
    if (inside && LAYOUT_STYLES.has(property)) continue;
    const value = acceptValue(property, computed.getPropertyValue(property).trim(), ids);
    if (value !== null) target.setAttribute(property, value);
  }
  for (const child of source.childNodes) {
    if (child.nodeType === Node.TEXT_NODE) {
      target.appendChild(document.createTextNode(child.nodeValue ?? ''));
    } else if (child instanceof Element) {
      if (!ALLOWED_ELEMENTS.has(child.localName)) {
        // Something visible that this copy cannot reproduce. The chart is refused with a stated reason rather
        // than stored as an image that quietly leaves it out.
        if (IGNORABLE_ELEMENTS.has(child.localName)) continue;
        return null;
      }
      const copy = sanitizeElement(child, ids, budget, inside);
      if (copy === null) return null;
      target.appendChild(copy);
    }
  }
  return target;
}

export interface SanitizedDiagram {
  source: string;
  width: number;
  height: number;
}

export function sanitizeDiagram(svg: SVGSVGElement): SanitizedDiagram | null {
  const box = svg.getBoundingClientRect();
  const view = svg.viewBox.baseVal;
  const width = Math.ceil(box.width > 0 ? box.width : view.width);
  const height = Math.ceil(box.height > 0 ? box.height : view.height);
  if (width < 1 || height < 1 || width > MAX_DIAGRAM_WIDTH || height > MAX_DIAGRAM_HEIGHT
    || width * height > MAX_DIAGRAM_PIXELS) return null;
  const sanitized = sanitizeElement(svg, localIds(svg), { count: 0 }, false);
  if (sanitized === null) return null;
  sanitized.setAttribute('xmlns', SVG_NAMESPACE);
  sanitized.setAttribute('width', String(width));
  sanitized.setAttribute('height', String(height));
  if (view.width > 0 && view.height > 0) {
    sanitized.setAttribute('viewBox', `${view.x} ${view.y} ${view.width} ${view.height}`);
  }
  const source = new XMLSerializer().serializeToString(sanitized);
  if (new TextEncoder().encode(source).length > MAX_DIAGRAM_SOURCE_BYTES) return null;
  return { source, width, height };
}

function loadImage(source: string): Promise<HTMLImageElement | null> {
  return new Promise(resolve => {
    const image = new Image();
    const timer = setTimeout(() => { resolve(null); }, IMAGE_LOAD_TIMEOUT_MS);
    const settle = (value: HTMLImageElement | null) => {
      clearTimeout(timer);
      resolve(value);
    };
    image.onload = () => { settle(image); };
    image.onerror = () => { settle(null); };
    // A data URL renders in the image's own static mode: no script runs and no external resource is fetched.
    image.src = `data:${SVG_MEDIA_TYPE};base64,${encodeBase64(new TextEncoder().encode(source))}`;
  });
}

export interface RasterizedDiagram {
  data: string;
  byteLength: number;
  width: number;
  height: number;
  hash: string;
}

export async function rasterizeDiagram(diagram: SanitizedDiagram): Promise<RasterizedDiagram | DiagramRejection> {
  const image = await loadImage(diagram.source);
  if (!image) return DIAGRAM_REJECTION.renderFailed;
  const canvas = document.createElement('canvas');
  canvas.width = diagram.width;
  canvas.height = diagram.height;
  const context = canvas.getContext('2d');
  if (!context) return DIAGRAM_REJECTION.renderFailed;
  // The chart is drawn on the page's own background, so a transparent image is not mistaken for a blank one.
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, diagram.width, diagram.height);
  try {
    context.drawImage(image, 0, 0, diagram.width, diagram.height);
  } catch {
    return DIAGRAM_REJECTION.renderFailed;
  }
  let encoded: string;
  try {
    encoded = canvas.toDataURL(DIAGRAM_MEDIA_TYPE);
  } catch {
    return DIAGRAM_REJECTION.tainted;
  }
  const prefix = `data:${DIAGRAM_MEDIA_TYPE};base64,`;
  if (!encoded.startsWith(prefix)) return DIAGRAM_REJECTION.renderFailed;
  const data = encoded.slice(prefix.length);
  const bytes = decodeBase64(data);
  if (!bytes) return DIAGRAM_REJECTION.invalid;
  if (bytes.length > MAX_DIAGRAM_BYTES) return DIAGRAM_REJECTION.oversize;
  const header = readPng(bytes);
  if (!header || header.width !== diagram.width || header.height !== diagram.height) {
    return DIAGRAM_REJECTION.invalid;
  }
  return { data, byteLength: bytes.length, width: header.width, height: header.height, hash: await hashBytes(bytes) };
}

export interface DiagramCapture {
  diagrams: Diagram[];
  images: { name: string; data: string }[];
  rejected: DiagramRejection[];
}

// Captures the charts the result drew, in order, within the per-attempt count and byte budget. A chart that is
// refused is counted with its reason instead of being dropped. Refusals cost work too, so the number of charts
// inspected and the time spent rasterizing them are both bounded: anything left over is refused with the reason
// it was left over for, never silently ignored and never allowed to run the observation out.
export async function captureDiagrams(
  elements: SVGSVGElement[], deadline = Date.now() + ARTIFACT_CAPTURE_BUDGET_MS,
): Promise<DiagramCapture> {
  const diagrams: Diagram[] = [];
  const images: { name: string; data: string }[] = [];
  const rejected: DiagramRejection[] = [];
  const candidates = elements.slice(0, MAX_DIAGRAM_CANDIDATES);
  let total = 0;
  for (const [index, element] of candidates.entries()) {
    const remaining = candidates.length - index;
    if (diagrams.length >= MAX_DIAGRAMS) {
      for (let count = 0; count < remaining; count++) rejected.push(DIAGRAM_REJECTION.limit);
      break;
    }
    if (Date.now() >= deadline) {
      for (let count = 0; count < remaining; count++) rejected.push(DIAGRAM_REJECTION.deadline);
      break;
    }
    const sanitized = sanitizeDiagram(element);
    if (!sanitized) {
      rejected.push(DIAGRAM_REJECTION.unsupported);
      continue;
    }
    const raster = await rasterizeDiagram(sanitized);
    if (typeof raster === 'string') {
      rejected.push(raster);
      continue;
    }
    if (total + raster.byteLength > MAX_DIAGRAM_TOTAL_BYTES) {
      rejected.push(DIAGRAM_REJECTION.limit);
      continue;
    }
    total += raster.byteLength;
    const name = DIAGRAM_NAME(diagrams.length + 1);
    diagrams.push({
      name, mediaType: DIAGRAM_MEDIA_TYPE, width: raster.width, height: raster.height,
      byteLength: raster.byteLength, hash: raster.hash,
    });
    images.push({ name, data: raster.data });
  }
  // More charts than this result is inspected for at all. One refusal states that, rather than a count of
  // charts nothing ever looked at.
  if (elements.length > candidates.length) rejected.push(DIAGRAM_REJECTION.limit);
  return { diagrams, images, rejected };
}
