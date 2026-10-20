import { join } from 'node:path';

// Checks must never overwrite another task's evidence in a developer's home.
export const usageArtifacts = name => join(process.env.IMPERFECT_TEST_ARTIFACTS || new URL('../../../../../.test-artifacts/', import.meta.url).pathname, name);

// Usage lives in the sidebar on a phone/focus layout, not its hidden dock.
export async function openUsage(page) {
  const dock = page.locator('.entry-usage');
  if (await dock.isVisible()) return dock.click();
  const summary = page.locator('.session-rail-usage');
  if (!await summary.isVisible()) await page.getByRole('button', { name: 'show the agents', exact: true }).click();
  return summary.click();
}
