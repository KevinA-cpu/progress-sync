import {
  GRADING_URL, GRADING_VERDICT, HDL_SUCCESS_HEADING, PROGRESS_MESSAGE, PROGRESS_TEXT,
} from '../lib/constants/progress';
import { CONTENT_SCRIPT_RUN_AT } from '../lib/constants/browser';
import { browser } from 'wxt/browser';
import { defineContentScript } from 'wxt/utils/define-content-script';
import { progressReplySchema, type ResultObservation } from '../lib/progress';

export default defineContentScript({
  matches: [GRADING_URL],
  allFrames: true,
  runAt: CONTENT_SCRIPT_RUN_AT,
  main() {
    const headings = [...document.querySelectorAll('h2')].map(node => node.textContent?.trim());
    const problemId = headings[0]?.match(/^([a-z0-9][a-z0-9_]{0,127}) \u2014 Compile and simulate$/)?.[1] ?? null;
    const knownLayout = headings.length === 2 && problemId !== null
      && document.title === PROGRESS_TEXT.resultTitle(problemId);
    const observation: ResultObservation = {
      type: PROGRESS_MESSAGE.result,
      problemId,
      verdict: knownLayout && headings[1] === HDL_SUCCESS_HEADING ? GRADING_VERDICT.success
        : knownLayout && /^Status: (Incorrect|Compile Error|Simulation Error)$/.test(headings[1] ?? '')
          ? GRADING_VERDICT.failure : GRADING_VERDICT.unknown,
    };
    void browser.runtime.sendMessage(observation).then((reply: unknown) => {
      const parsed = progressReplySchema.safeParse(reply);
      if (!parsed.success || !parsed.data.ok) {
        console.warn(PROGRESS_TEXT.resultUnrecorded);
      }
    }, () => {
      console.error(PROGRESS_TEXT.resultUndelivered);
    });
  },
});
