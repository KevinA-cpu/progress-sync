import type { BrowserContext, Page } from '@playwright/test';
import type { Browser } from 'wxt/browser';
import { z } from 'zod';
import { submittedSource } from './fixtures';

declare const chrome: typeof Browser;

export const retryName = 'Check GitHub and retry delivery';
export const queuedText = 'Queued for automatic delivery';
export const throttledText = 'GitHub asked this client to wait';
export const exhaustedText = 'Automatic delivery attempts are exhausted';
export const unscheduledText = 'no automatic wakeup could be registered';
export const schedulerFailureText = 'Automatic delivery could not be scheduled in this browser';

export const retrySchema = z.strictObject({
  attempts: z.int().nonnegative(), nextAttemptAt: z.iso.datetime().nullable(),
  failure: z.enum(['transient', 'rate-limited', 'unsupported-delay', 'authorization', 'permanent']),
  reservedAt: z.iso.datetime().nullish(),
});
export const jobSchema = z.object({
  id: z.uuid(), state: z.enum(['pending', 'publishing', 'reconciling', 'uncertain', 'blocked', 'saved']),
  detail: z.string().nullable(), retry: retrySchema.nullish(),
  receipt: z.object({ commitSha: z.string().regex(/^[0-9a-f]{40}$/) }).nullable(),
  snapshot: z.object({ id: z.uuid(), source: z.string() }),
  target: z.object({ connectionId: z.uuid(), operationId: z.uuid(), branch: z.string(), repositoryId: z.int() }),
});
export const replySchema = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true), jobs: z.array(jobSchema),
    selection: z.object({ connectionId: z.uuid(), operationId: z.uuid() }).nullable(),
    scheduling: z.object({ failedAt: z.iso.datetime(), detail: z.string() }).nullable(),
  }),
  z.object({ ok: z.literal(false), error: z.string() }),
]);
export type DeliveryJob = z.infer<typeof jobSchema>;

export async function deliveryView(page: Page) {
  const reply = replySchema.parse(await page.evaluate(() => chrome.runtime.sendMessage({ type: 'delivery:list' })));
  if (!reply.ok) throw new Error(reply.error);
  return reply;
}

export async function onlyJob(page: Page): Promise<DeliveryJob> {
  const reply = await deliveryView(page);
  const [job] = reply.jobs;
  if (!job || reply.jobs.length !== 1) throw new Error('Expected exactly one retained delivery job.');
  return job;
}

export async function storedJobs(page: Page) {
  const stored = await page.evaluate(() => chrome.storage.local.get('delivery-jobs-v1'));
  return z.array(jobSchema).parse(stored['delivery-jobs-v1'] ?? []);
}

export async function observeApi(context: BrowserContext) {
  const requests: Array<{ method: string; path: string }> = [];
  await context.route('https://api.github.com/**', async route => {
    requests.push({ method: route.request().method(), path: new URL(route.request().url()).pathname });
    await route.fallback();
  });
  return requests;
}

export async function submit(problem: Page, source = submittedSource): Promise<void> {
  await problem.getByRole('textbox', { name: 'Solution' }).fill(source);
  await problem.getByRole('button', { name: 'Submit', exact: true }).click();
}
