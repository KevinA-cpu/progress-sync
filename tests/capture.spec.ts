import { expect, stopExtensionWorker, submittedBytes, submittedSource, successPage, test } from './fixtures';

test('a guest submission retains the accepted bytes separately from a GitHub backup', async ({
  problem, progress,
}) => {
  await problem.getByRole('textbox', { name: 'Solution' }).fill(submittedSource);
  await problem.getByRole('button', { name: 'Submit', exact: true }).click();

  await expect(progress.getByText('Accepted locally - not saved to GitHub', { exact: true }))
    .toBeVisible();
  await expect(progress.getByRole('heading', { name: 'hdlbits:step_one', exact: true }))
    .toBeVisible();
  await expect(progress.getByRole('textbox', { name: 'Submitted source' }))
    .toHaveValue(submittedBytes.replaceAll('\r\n', '\n'));
});

test('editing while grading cannot change the submitted source or its byte hash', async ({
  extensionContext, problem, progress,
}) => {
  const received = Promise.withResolvers<void>();
  const grading = Promise.withResolvers<void>();
  await extensionContext.route('**/runsim.php', async route => {
    received.resolve();
    await grading.promise;
    await route.fulfill({ contentType: 'text/html', body: successPage });
  });
  await problem.getByRole('textbox', { name: 'Solution' }).fill(submittedSource);
  await problem.getByRole('button', { name: 'Submit', exact: true }).click();
  await received.promise;
  await problem.getByRole('textbox', { name: 'Solution' }).fill('changed after submission');
  grading.resolve();

  await expect(progress.getByText('Accepted locally - not saved to GitHub', { exact: true }))
    .toBeVisible();
  await expect(progress.getByRole('textbox', { name: 'Submitted source' })).toHaveValue(submittedSource);
  await expect(progress.getByText(
    'e792e08eb073133e384987694229526ad3da6b1d3bcff73bada595e5f934dc0d', { exact: true },
  )).toBeVisible();
});

for (const scenario of [
  {
    name: 'a failed submission despite a historical solved badge',
    response: successPage.replace('Status: Success!', 'Status: Incorrect'),
    explanation: 'HDLBits did not accept this submission.',
  },
  {
    name: 'a result for a different problem',
    response: successPage.replaceAll('step_one', 'zero'),
    explanation: 'The result could not be tied to this submission.',
  },
  {
    name: 'an ambiguous result layout',
    response: successPage.replace('</body>', '<h2>Status: Incorrect</h2></body>'),
    explanation: 'The grading result is unsupported or ambiguous.',
  },
]) {
  test(`leaves ${scenario.name} unverified`, async ({ extensionContext, problem, progress }) => {
    await extensionContext.route('**/runsim.php', route =>
      route.fulfill({ contentType: 'text/html', body: scenario.response }));
    await problem.locator('#historical-status').evaluate(node => {
      node.textContent = 'Status: Success!';
    });
    await problem.getByRole('textbox', { name: 'Solution' }).fill(submittedSource);
    await problem.getByRole('button', { name: 'Submit', exact: true }).click();

    await expect(progress.getByText(scenario.explanation, { exact: false })).toBeVisible();
    await expect(progress.getByText('Accepted locally - not saved to GitHub', { exact: true }))
      .toHaveCount(0);
    await expect(progress.getByRole('textbox', { name: 'Submitted source' })).toHaveValue(submittedSource);
  });
}

test('accepted progress survives page reloads and service-worker recreation', async ({
  extensionContext, problem, progress,
}) => {
  await problem.getByRole('textbox', { name: 'Solution' }).fill(submittedSource);
  await problem.getByRole('button', { name: 'Submit', exact: true }).click();
  await expect(progress.getByText('Accepted locally - not saved to GitHub', { exact: true }))
    .toBeVisible();
  await problem.reload();
  await expect(problem.getByRole('textbox', { name: 'Solution' })).toHaveValue('');
  await progress.reload();
  await expect(progress.getByText('Accepted locally - not saved to GitHub', { exact: true }))
    .toBeVisible();

  await stopExtensionWorker(extensionContext, progress);
  await progress.reload();

  await expect(progress.getByText('Accepted locally - not saved to GitHub', { exact: true }))
    .toBeVisible();
  await expect(progress.getByRole('status')).toHaveText('1 captured attempt.');
  await expect(progress.getByRole('textbox', { name: 'Submitted source' })).toHaveValue(submittedSource);
});

test('a learner can correct a failed submission without reloading the problem', async ({
  extensionContext, problem, progress,
}) => {
  let submissions = 0;
  await extensionContext.route('**/runsim.php', route => route.fulfill({
    contentType: 'text/html',
    body: submissions++ === 0 ? successPage.replace('Status: Success!', 'Status: Incorrect') : successPage,
  }));
  await problem.getByRole('textbox', { name: 'Solution' })
    .fill(submittedSource.replace("1'b1", "1'b0"));
  await problem.getByRole('button', { name: 'Submit', exact: true }).click();
  await expect(progress.getByText('HDLBits did not accept this submission.', { exact: false }))
    .toBeVisible();
  await problem.getByRole('textbox', { name: 'Solution' }).fill(submittedSource);
  await problem.getByRole('button', { name: 'Submit', exact: true }).click();

  await expect(progress.getByText('Accepted locally - not saved to GitHub', { exact: true }))
    .toBeVisible();
  await expect(progress.getByRole('status')).toHaveText('2 captured attempts.');
});

test('a timed-out attempt cannot become accepted when a late success arrives', async ({
  extensionContext, problem, progress,
}) => {
  const grading = Promise.withResolvers<void>();
  await extensionContext.route('**/runsim.php', async route => {
    await grading.promise;
    await route.fulfill({ contentType: 'text/html', body: successPage });
  });
  await problem.getByRole('textbox', { name: 'Solution' }).fill(submittedSource);
  await problem.getByRole('button', { name: 'Submit', exact: true }).click();
  await expect(progress.getByText('Waiting for the result - not saved to GitHub', { exact: true }))
    .toBeVisible();
  const worker = extensionContext.serviceWorkers()[0];
  if (!worker) throw new Error('Expected the extension worker to be running.');
  await worker.evaluate(now => { Date.now = () => now; }, Date.now() + 180_000);
  await progress.getByRole('button', { name: 'Refresh progress' }).click();
  await expect(progress.getByText('Result timed out.', { exact: false })).toBeVisible();
  grading.resolve();
  await expect(problem.frameLocator('#compile_iframe').getByRole('heading', {
    name: 'Status: Success!', exact: true,
  })).toBeVisible();
  await progress.getByRole('button', { name: 'Refresh progress' }).click();

  await expect(progress.getByText('Result timed out.', { exact: false })).toBeVisible();
  await expect(progress.getByText('Accepted locally - not saved to GitHub', { exact: true }))
    .toHaveCount(0);
});

test('an old success document and a page-forged observation cannot invent a submission', async ({
  problem, progress,
}) => {
  await problem.locator('#compile_iframe').evaluate((frame: HTMLIFrameElement) => {
    frame.src = '/runsim.php';
    window.postMessage({ type: 'hdlbits:result', problemId: 'step_one', verdict: 'success' }, '*');
  });
  await expect(problem.frameLocator('#compile_iframe').getByRole('heading', {
    name: 'Status: Success!', exact: true,
  })).toBeVisible();
  await progress.getByRole('button', { name: 'Refresh progress' }).click();

  await expect(progress.getByRole('status')).toContainText('No captured attempts yet.');
  await expect(progress.getByRole('textbox', { name: 'Submitted source' })).toHaveCount(0);
});

test('duplicate source fields remain unverified even if the result says success', async ({
  problem, progress,
}) => {
  await problem.getByRole('textbox', { name: 'Solution' }).fill(submittedSource);
  await problem.locator('#codeform').evaluate(form => {
    const duplicate = document.createElement('input');
    duplicate.name = 'vlgcode_box';
    duplicate.value = 'different source';
    form.append(duplicate);
  });
  await problem.getByRole('button', { name: 'Submit', exact: true }).click();
  await expect(progress.getByText('Unsupported submission.', { exact: false })).toBeVisible();
  await expect(problem.frameLocator('#compile_iframe').getByRole('heading', {
    name: 'Status: Success!', exact: true,
  })).toBeVisible();

  await expect(progress.getByText('Accepted locally - not saved to GitHub', { exact: true }))
    .toHaveCount(0);
});

test('overlapping simulations in different tabs keep their snapshots with out-of-order results', async ({
  extensionContext, problem, progress,
}) => {
  const firstRequest = Promise.withResolvers<void>();
  const firstResult = Promise.withResolvers<void>();
  let requests = 0;
  await extensionContext.route('**/runsim.php', async route => {
    if (requests++ === 0) {
      firstRequest.resolve();
      await firstResult.promise;
    }
    await route.fulfill({ contentType: 'text/html', body: successPage });
  });
  const secondProblem = await extensionContext.newPage();
  await secondProblem.goto('https://hdlbits.01xz.net/wiki/Step_one');
  await problem.getByRole('textbox', { name: 'Solution' }).fill(submittedSource);
  await problem.getByRole('button', { name: 'Submit', exact: true }).click();
  await firstRequest.promise;
  const secondSource = `// Second tab\n${submittedSource}`;
  await secondProblem.getByRole('textbox', { name: 'Solution' }).fill(secondSource);
  await secondProblem.getByRole('button', { name: 'Submit', exact: true }).click();
  await expect(progress.getByText('Accepted locally - not saved to GitHub', { exact: true })).toHaveCount(1);
  await expect(progress.getByText('Waiting for the result - not saved to GitHub', { exact: true })).toHaveCount(1);
  await problem.getByRole('textbox', { name: 'Solution' }).fill('edited first tab');
  firstResult.resolve();
  for (const page of [problem, secondProblem]) {
    await expect(page.frameLocator('#compile_iframe').getByRole('heading', {
      name: 'Status: Success!', exact: true,
    })).toBeVisible();
  }
  await progress.getByRole('button', { name: 'Refresh progress' }).click();

  await expect(progress.getByRole('status')).toHaveText('2 captured attempts.');
  await expect(progress.getByText('Accepted locally - not saved to GitHub', { exact: true }))
    .toHaveCount(2);
  await expect(progress.getByRole('textbox', { name: 'Submitted source' }).nth(0)).toHaveValue(secondSource);
  await expect(progress.getByRole('textbox', { name: 'Submitted source' }).nth(1)).toHaveValue(submittedSource);
});

test('worker recreation does not clear an interrupted problem document safety gate', async ({
  extensionContext, problem, progress,
}) => {
  const grading = Promise.withResolvers<void>();
  let requests = 0;
  await extensionContext.route('**/runsim.php', async route => {
    if (requests++ === 0) await grading.promise;
    await route.fulfill({ contentType: 'text/html', body: successPage });
  });
  await problem.getByRole('textbox', { name: 'Solution' }).fill(submittedSource);
  await problem.getByRole('button', { name: 'Submit', exact: true }).click();
  await expect(progress.getByText('Waiting for the result - not saved to GitHub', { exact: true }))
    .toBeVisible();
  await stopExtensionWorker(extensionContext, progress);
  await progress.reload();
  await expect(progress.getByText('Observation was interrupted.', { exact: false })).toBeVisible();
  grading.resolve();
  await expect(problem.frameLocator('#compile_iframe').getByRole('heading', {
    name: 'Status: Success!', exact: true,
  })).toBeVisible();
  await problem.getByRole('button', { name: 'Submit', exact: true }).click();

  await expect(progress.getByText('This page has an ambiguous observation.', { exact: false }))
    .toBeVisible();
  await expect(progress.getByText('Accepted locally - not saved to GitHub', { exact: true }))
    .toHaveCount(0);
});

test('an untracked grading navigation overlapping a POST prevents acceptance', async ({
  extensionContext, problem, progress,
}) => {
  const oldRequest = Promise.withResolvers<void>();
  const oldResult = Promise.withResolvers<void>();
  await extensionContext.route('**/runsim.php', async route => {
    if (route.request().method() === 'GET') {
      oldRequest.resolve();
      await oldResult.promise;
    }
    await route.fulfill({ contentType: 'text/html', body: successPage });
  });
  await problem.locator('#compile_iframe').evaluate((frame: HTMLIFrameElement) => {
    frame.src = '/runsim.php';
  });
  await oldRequest.promise;
  await problem.getByRole('textbox', { name: 'Solution' }).fill(submittedSource);
  await problem.getByRole('button', { name: 'Submit', exact: true }).click();
  oldResult.resolve();

  await expect(progress.getByText('This page has an ambiguous observation.', { exact: false }))
    .toBeVisible();
  await expect(progress.getByText('Accepted locally - not saved to GitHub', { exact: true }))
    .toHaveCount(0);
});

test('a problem predating worker observation must be reloaded before capture', async ({
  extensionContext, problem, progress,
}) => {
  await stopExtensionWorker(extensionContext, progress);
  await progress.reload();
  await expect(progress.getByRole('status')).toContainText('No captured attempts yet.');
  await problem.getByRole('textbox', { name: 'Solution' }).fill(submittedSource);
  await problem.getByRole('button', { name: 'Submit', exact: true }).click();
  await expect(progress.getByText('The problem document predates this observer.', { exact: false }))
    .toBeVisible();
  await expect(progress.getByText('Accepted locally - not saved to GitHub', { exact: true }))
    .toHaveCount(0);
  await problem.reload();
  await problem.getByRole('textbox', { name: 'Solution' }).fill(submittedSource);
  await problem.getByRole('button', { name: 'Submit', exact: true }).click();

  await expect(progress.getByText('Accepted locally - not saved to GitHub', { exact: true }))
    .toBeVisible();
});
