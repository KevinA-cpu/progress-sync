import { expect, submittedBytes, submittedSource, test } from './fixtures';
import { CLIENT_ID, credentialSummary } from './github-fixture';
import { setup } from './publication-setup';
import type { Browser } from 'wxt/browser';

declare const chrome: typeof Browser;

test.use({ githubClientId: CLIENT_ID });

const retryName = 'Check GitHub and retry delivery';
const initialHead = 'a'.repeat(40);
const concurrentPath = 'concurrent.txt';
const concurrentContent = 'Another writer during rebase.\n';
const noCredentials = {
  accessInSession: false, refreshInSession: false, deviceInSession: false, leakedOutsideSession: false,
};

// Access can be lost exactly while a competing reference update forces conflict recovery.
for (const loss of ['authorization', 'contents permission'] as const) {
  test(`lost ${loss} during conflict rebasing retains the original job until access is repaired`, async ({
    extensionContext, progress, problem,
  }) => {
    const { server, target, auth, connection, page } = await setup(extensionContext, progress);
    const onboarding = { creations: target.creations, initializations: target.initializations };
    let advanced = '';
    server.onRefUpdate = () => {
      server.onRefUpdate = null;
      advanced = server.commitFiles({ [concurrentPath]: concurrentContent }, 'Unrelated concurrent update');
      if (loss === 'authorization') auth.identityStatus = 401;
      else target.contentsWrite = false;
    };

    await problem.getByRole('textbox', { name: 'Solution' }).fill(submittedSource);
    await problem.getByRole('button', { name: 'Submit', exact: true }).click();
    if (loss === 'authorization') {
      await expect(connection.getByRole('status')).toHaveText('GitHub authorization was rejected. Connect again.');
    }
    await expect(progress.getByText('Publication outcome is uncertain.', { exact: false })).toBeVisible();
    await expect(progress.getByRole('button', { name: retryName })).toBeDisabled();

    const failed = await progress.evaluate(() => chrome.runtime.sendMessage({ type: 'delivery:list' }));
    const original = failed.jobs[0];
    expect(failed.jobs).toHaveLength(1);
    expect(original).toMatchObject({
      state: 'uncertain', receipt: null,
      snapshot: { source: submittedBytes, problemId: 'step_one' },
      target: {
        userId: 42, owner: 'fixture-user', name: 'progress-solutions', branch: 'learning',
        appId: 99, installationId: 77, repositoryId: 101,
      },
    });
    expect(original.candidate).toMatchObject({ baseCommitSha: initialHead });
    expect(failed.selection).toBeNull();
    await expect(progress.getByRole('link', { name: /^Commit / })).toHaveCount(0);
    await expect(progress.getByRole('textbox', { name: 'Submitted source (read-only)' })).toHaveValue(submittedSource);
    await expect(progress.getByText('Original GitHub account: fixture-user (ID 42)', { exact: true })).toBeVisible();

    // The rejected reference update is the last write; the failed re-verification adds none.
    expect(server.writes.map(write => write.method)).toEqual(['POST', 'POST', 'PATCH']);
    expect(server.updates).toBe(0);
    expect(server.refCompletions).toBe(0);
    expect(server.head).toBe(advanced);
    expect(server.files.get(concurrentPath)).toBe(concurrentContent);
    expect([...server.files.keys()].filter(path => path.startsWith('progress/'))).toEqual([]);

    if (loss === 'authorization') {
      expect(await credentialSummary(progress)).toEqual(noCredentials);
    } else {
      expect((await credentialSummary(progress)).accessInSession).toBe(true);
      await expect(connection.getByRole('status')).toHaveText('Connected as fixture-user');
    }

    // A retry aimed at the original binding cannot proceed while access is lost.
    const writes = server.writes.length;
    const stale = await progress.evaluate(input => chrome.runtime.sendMessage(input), {
      type: 'delivery:retry', jobId: original.id,
      expectedConnectionId: original.target.connectionId, expectedSelectionId: original.target.operationId,
    });
    expect(stale.selection).toBeNull();
    expect(stale.jobs[0]).toMatchObject({
      id: original.id, receipt: null, snapshot: original.snapshot,
      target: original.target, candidate: original.candidate,
    });
    expect(server.writes).toHaveLength(writes);
    expect(server.updates).toBe(0);
    expect(server.head).toBe(advanced);

    if (loss === 'authorization') {
      auth.identityStatus = 200;
      await connection.getByRole('button', { name: 'Connect GitHub', exact: true }).click();
      await expect(connection.getByRole('status')).toHaveText('Connected as fixture-user');
      await expect(progress.getByRole('button', { name: retryName })).toBeDisabled();
    } else {
      target.contentsWrite = true;
      await expect(progress.getByRole('button', { name: retryName })).toBeDisabled();
    }
    await page.getByRole('button', { name: 'Refresh installations', exact: true }).click();
    await page.getByRole('button', { name: 'Verify pending or saved repository' }).click();
    await expect(page.getByRole('status')).toHaveText('Verified destination: fixture-user/progress-solutions @ learning');
    await expect(progress.getByRole('button', { name: retryName })).toBeEnabled();
    expect(server.writes).toHaveLength(writes);

    const rebased = server.writes.length;
    await progress.getByRole('button', { name: retryName }).click();
    await expect(progress.getByRole('region', { name: 'Captured attempts' }).getByText('Saved to GitHub', { exact: true }))
      .toBeVisible();

    const saved = await progress.evaluate(() => chrome.runtime.sendMessage({ type: 'delivery:list' }));
    expect(saved.jobs).toHaveLength(1);
    expect(saved.jobs[0]).toMatchObject({
      id: original.id, state: 'saved', snapshot: original.snapshot, target: original.target,
    });
    expect(saved.jobs[0].candidate).toMatchObject({ baseCommitSha: advanced });
    expect(saved.jobs[0].receipt.commitSha).toBe(server.head);
    expect(saved.selection.operationId).toBe(original.target.operationId);
    if (loss === 'authorization') {
      expect(saved.selection.connectionId).not.toBe(original.target.connectionId);
    }
    await expect(progress.getByRole('link', { name: `Commit ${server.head}`, exact: true })).toBeVisible();

    // Exactly one visible publication, reapplied on top of the competing change.
    expect(server.writes.slice(rebased).map(write => write.method)).toEqual(['POST', 'POST', 'PATCH']);
    expect(server.updates).toBe(1);
    expect(server.refCompletions).toBe(1);
    expect(server.files.get(concurrentPath)).toBe(concurrentContent);
    expect(server.files.get('README.md')).toBe('Keep this learner file.\n');
    expect([...server.files.keys()].filter(path => path.startsWith('progress/')).sort()).toEqual([
      `progress/hdlbits/step_one/${original.id}/acceptance.json`,
      `progress/hdlbits/step_one/${original.id}/solution.v`,
    ]);
    expect(server.files.get(`progress/hdlbits/step_one/${original.id}/solution.v`)).toBe(submittedBytes);
    expect(server.requestsValid).toBe(true);
    expect(target.requestsValid).toBe(true);
    // Repairing access and verifying again must not re-onboard the destination.
    expect({ creations: target.creations, initializations: target.initializations }).toEqual(onboarding);
  });
}
