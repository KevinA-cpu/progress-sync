import { expect, type BrowserContext, type Page } from '@playwright/test';
import { githubFixture, openConnection } from './github-fixture';
import { destinationFixture } from './destination-fixture';
import { publicationFixture } from './publication-fixture';

export async function setup(context: BrowserContext, progress: Page) {
  const auth = await githubFixture(context);
  const target = await destinationFixture(context);
  const server = await publicationFixture(context, target);
  const connection = await openConnection(context, progress);
  await connection.getByRole('button', { name: 'Connect GitHub', exact: true }).click();
  await expect(connection.getByRole('status')).toHaveText('Connected as fixture-user');
  const [page] = await Promise.all([
    context.waitForEvent('page'),
    connection.getByRole('link', { name: 'Set up progress repository' }).click(),
  ]);
  await page.getByLabel('I understand this repository will be public').check();
  await page.getByRole('button', { name: 'Create public repository', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('Verified destination: fixture-user/progress-solutions @ learning');
  return { auth, target, server, connection, page };
}
