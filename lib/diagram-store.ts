import { DIAGRAM_STORE_KEY, MAX_LOCAL_STORAGE_BYTES } from './constants/report';
import { browser } from 'wxt/browser';
import { diagramImagesSchema, type DiagramImage } from './report';

// Captured images are held under their own key per attempt, outside the attempt list: reading progress never
// parses image bytes, and discarding an attempt drops exactly its own images.
async function bytesInUse(): Promise<number | null> {
  try {
    return await browser.storage.local.getBytesInUse(null);
  } catch {
    return null;
  }
}

export async function saveDiagramImages(attemptId: string, images: DiagramImage[]): Promise<boolean> {
  if (images.length === 0) return true;
  const parsed = diagramImagesSchema.safeParse(images);
  if (!parsed.success) return false;
  const used = await bytesInUse();
  const size = images.reduce((total, image) => total + image.data.length + image.name.length, 0);
  if (used !== null && used + size > MAX_LOCAL_STORAGE_BYTES) return false;
  try {
    await browser.storage.local.set({ [DIAGRAM_STORE_KEY(attemptId)]: parsed.data });
  } catch {
    return false;
  }
  return true;
}

export async function readDiagramImages(attemptId: string): Promise<DiagramImage[] | null> {
  const key = DIAGRAM_STORE_KEY(attemptId);
  const stored: unknown = (await browser.storage.local.get(key))[key];
  if (stored === undefined) return null;
  const parsed = diagramImagesSchema.safeParse(stored);
  return parsed.success ? parsed.data : null;
}

export async function dropDiagramImages(attemptId: string): Promise<void> {
  await browser.storage.local.remove(DIAGRAM_STORE_KEY(attemptId));
}
