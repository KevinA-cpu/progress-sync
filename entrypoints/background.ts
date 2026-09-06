import { RESOURCE_TYPE, TAB_STATUS, WEB_REQUEST_OPTION } from '../lib/constants/browser';
import { DESTINATION_ISSUE, DESTINATION_TEXT } from '../lib/constants/destination';
import { AUTH_ISSUE, AUTH_TEXT } from '../lib/constants/github';
import { GRADING_URL, HDL_HOST, PROGRESS_TEXT } from '../lib/constants/progress';
import { browser } from 'wxt/browser';
import { defineBackground } from 'wxt/utils/define-background';
import { createCaptureService } from '../lib/capture-service';
import { type ProgressReply } from '../lib/progress';
import { authEnvelopeSchema, type AuthReply } from '../lib/github/schemas';
import { createGithubService } from '../lib/github/service';
import { createDestinationService } from '../lib/destination/service';
import { destinationEnvelopeSchema, type DestinationReply } from '../lib/destination/schemas';

export default defineBackground(() => {
  const capture = createCaptureService();
  const github = createGithubService();
  const destination = createDestinationService(github);
  const requests = { urls: [GRADING_URL], types: [RESOURCE_TYPE.mainFrame, RESOURCE_TYPE.subFrame] as const };
  const filter = { urls: requests.urls, types: [...requests.types] };
  browser.webRequest.onBeforeRequest.addListener(capture.request, filter, [WEB_REQUEST_OPTION.requestBody]);
  browser.webRequest.onCompleted.addListener(capture.completed, filter);
  browser.webRequest.onErrorOccurred.addListener(capture.interrupted, filter);
  browser.webRequest.onBeforeRedirect.addListener(capture.interrupted, filter);
  browser.webNavigation.onCommitted.addListener(capture.committed, {
    url: [{ hostEquals: HDL_HOST }],
  });
  browser.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
    if (destinationEnvelopeSchema.safeParse(message).success) {
      void destination.message(message, sender).then(sendResponse, () => {
        console.error(DESTINATION_TEXT.operationFailed);
        const reply: DestinationReply = { ok: false, error: DESTINATION_ISSUE.networkError };
        sendResponse(reply);
      });
      return true;
    }
    if (authEnvelopeSchema.safeParse(message).success) {
      void github.message(message, sender).then(sendResponse, () => {
        console.error(AUTH_TEXT.requestFailed);
        const response: AuthReply = { ok: false, error: AUTH_ISSUE.interrupted };
        sendResponse(response);
      });
      return true;
    }
    void capture.message(message, sender).then(sendResponse, (error: unknown) => {
      capture.reportFailure(error);
      const response: ProgressReply = {
        ok: false, error: error instanceof Error ? error.message : PROGRESS_TEXT.recordingFailed,
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
    if (changes.status === TAB_STATUS.loading || changes.discarded === true) github.ownerClosed(tabId);
  });
  browser.alarms.onAlarm.addListener(alarm => github.alarm(alarm.name));
});
