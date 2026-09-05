import { browser } from 'wxt/browser';
import { defineContentScript } from 'wxt/utils/define-content-script';
import { isObject, type ResultObservation } from '../lib/progress';

export default defineContentScript({
  matches: ['https://hdlbits.01xz.net/runsim.php'],
  allFrames: true,
  runAt: 'document_idle',
  main() {
    const headings = [...document.querySelectorAll('h2')].map(node => node.textContent?.trim());
    const problemId = headings[0]?.match(/^([a-z0-9][a-z0-9_]{0,127}) \u2014 Compile and simulate$/)?.[1] ?? null;
    const knownLayout = headings.length === 2 && problemId !== null
      && document.title === `${problemId}: Simulation - HDLBits`;
    const observation: ResultObservation = {
      type: 'hdlbits:result',
      problemId,
      verdict: knownLayout && headings[1] === 'Status: Success!' ? 'success'
        : knownLayout && /^Status: (Incorrect|Compile Error|Simulation Error)$/.test(headings[1] ?? '')
          ? 'failure' : 'unknown',
    };
    void browser.runtime.sendMessage(observation).then((reply: unknown) => {
      if (!isObject(reply) || reply.ok !== true) {
        console.warn('Progress Sync: this result was not recorded as an accepted attempt.');
      }
    }, () => {
      console.error('Progress Sync: result observation could not be delivered.');
    });
  },
});
