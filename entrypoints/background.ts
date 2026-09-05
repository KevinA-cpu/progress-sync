import { browser } from 'wxt/browser';
import { defineBackground } from 'wxt/utils/define-background';
import { createCaptureService } from '../lib/capture-service';
import { GRADING_URL, type ProgressReply } from '../lib/progress';

export default defineBackground(() => {
  const capture = createCaptureService();
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
});
