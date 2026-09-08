import type { BrowserContext, Page } from '@playwright/test';

export async function trackContentScript(context: BrowserContext, page: Page) {
  const worker = context.serviceWorkers()[0];
  if (!worker) throw new Error('Missing extension worker.');
  const extensionId = new URL(worker.url()).hostname;
  const session = await context.newCDPSession(page);
  const contexts = new Set<number>();
  session.on('Runtime.executionContextCreated', ({ context }) => contexts.add(context.id));
  session.on('Runtime.executionContextDestroyed', ({ executionContextId }) => contexts.delete(executionContextId));
  session.on('Runtime.executionContextsCleared', () => contexts.clear());
  await session.send('Runtime.enable');
  return {
    async evaluate(expression: string): Promise<unknown> {
      let isolatedWorld: number | undefined;
      for (const contextId of contexts) {
        const result = await session.send('Runtime.evaluate', {
          contextId,
          expression: `globalThis.chrome?.runtime?.id === ${JSON.stringify(extensionId)}`,
          returnByValue: true,
        });
        if (result.result.value === true) {
          if (isolatedWorld !== undefined) throw new Error('More than one extension content-script context.');
          isolatedWorld = contextId;
        }
      }
      if (isolatedWorld === undefined) throw new Error('Did not find the actual extension content-script context.');
      const result = await session.send('Runtime.evaluate', {
        contextId: isolatedWorld, awaitPromise: true, returnByValue: true, expression,
      });
      if (result.exceptionDetails) throw new Error(`Content-script evaluation failed: ${result.exceptionDetails.text}`);
      return result.result.value;
    },
    close: () => session.detach(),
  };
}
