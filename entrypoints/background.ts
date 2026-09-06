import { browser } from 'wxt/browser';
import { defineBackground } from 'wxt/utils/define-background';
import { createCaptureService } from '../lib/capture-service';
import { GRADING_URL, type ProgressReply } from '../lib/progress';
import { authEnvelopeSchema, type AuthReply } from '../lib/github/schemas';
import { createGithubService } from '../lib/github/service';
import { createDestinationService } from '../lib/destination/service';
import { destinationEnvelopeSchema, type DestinationReply } from '../lib/destination/schemas';

export default defineBackground(() => {
  const capture = createCaptureService();
  const github = createGithubService();
  const destination = createDestinationService(github);
  const requests = { urls: [GRADING_URL], types: ['main_frame', 'sub_frame'] as const };
  const filter = { urls: requests.urls, types: [...requests.types] };
  browser.webRequest.onBeforeRequest.addListener(capture.request, filter, ['requestBody']);
  browser.webRequest.onCompleted.addListener(capture.completed, filter);
  browser.webRequest.onErrorOccurred.addListener(capture.interrupted, filter);
  browser.webRequest.onBeforeRedirect.addListener(capture.interrupted, filter);
  browser.webNavigation.onCommitted.addListener(capture.committed, {
    url: [{ hostEquals: 'hdlbits.01xz.net' }],
  });
  browser.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
    if (destinationEnvelopeSchema.safeParse(message).success) {
      void destination.message(message, sender).then(sendResponse, () => {
        console.error('Progress Sync: destination operation failed.');
        const reply: DestinationReply = { ok: false, error: 'network-error' };
        sendResponse(reply);
      });
      return true;
    }
    if (authEnvelopeSchema.safeParse(message).success) {
      void github.message(message, sender).then(sendResponse, () => {
        console.error('Progress Sync: GitHub connection request failed.');
        const response: AuthReply = { ok: false, error: 'interrupted' };
        sendResponse(response);
      });
      return true;
    }
    void capture.message(message, sender).then(sendResponse, (error: unknown) => {
      capture.reportFailure(error);
      const response: ProgressReply = {
        ok: false, error: error instanceof Error ? error.message : 'Progress recording failed.',
      };
      sendResponse(response);
    });
    return true;
  });
  browser.action.onClicked.addListener(() => {
    void browser.runtime.openOptionsPage().catch(capture.reportFailure);
  });
  browser.tabs.onRemoved.addListener(github.ownerClosed);
  browser.tabs.onUpdated.addListener((tabId, changes) => {
    if (changes.status === 'loading' || changes.discarded === true) github.ownerClosed(tabId);
  });
  browser.alarms.onAlarm.addListener(alarm => github.alarm(alarm.name));
});
