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
