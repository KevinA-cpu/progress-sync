import { RESOURCE_TYPE, TAB_STATUS, WEB_REQUEST_OPTION } from '../lib/constants/browser';
import { DESTINATION_ISSUE, DESTINATION_MESSAGE, DESTINATION_MESSAGE_PREFIX, DESTINATION_TEXT } from '../lib/constants/destination';
import { AUTH_ISSUE, AUTH_MESSAGE_PREFIX, AUTH_TEXT } from '../lib/constants/github';
import { GRADING_URL, HDL_HOST, PROGRESS_TEXT } from '../lib/constants/progress';
import { browser } from 'wxt/browser';
import { defineBackground } from 'wxt/utils/define-background';
import { createCaptureService } from '../lib/capture-service';
import { type ProgressReply } from '../lib/progress';
import { type AuthReply } from '../lib/github/schemas';
import { createGithubService } from '../lib/github/service';
import { createDestinationService } from '../lib/destination/service';
import { type DestinationReply } from '../lib/destination/schemas';
import { createDeliveryService } from '../lib/delivery/service';
import { type DeliveryReply } from '../lib/delivery/schemas';
import { DELIVERY_MESSAGE_PREFIX, DELIVERY_TEXT } from '../lib/constants/delivery';
import { z } from '../lib/schema';
import { createRecoveryService } from '../lib/recovery/service';
import { type RecoveryReply } from '../lib/recovery/schemas';
import { RECOVERY_MESSAGE_PREFIX, RECOVERY_TEXT } from '../lib/constants/recovery';

const messageEnvelopeSchema = z.object({ type: z.string() });

export default defineBackground(() => {
  const github = createGithubService();
  const destination = createDestinationService(github);
  const delivery = createDeliveryService(github, destination, (id, persist) => capture.discardAccepted(id, persist));
  const recovery = createRecoveryService(github, destination);
  const capture = createCaptureService(delivery.accepted);
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
    const envelope = messageEnvelopeSchema.safeParse(message);
    const messageType = envelope.success ? envelope.data.type : null;
    const namespace = messageType?.slice(0, messageType.indexOf(':') + 1);
    switch (namespace) {
      case RECOVERY_MESSAGE_PREFIX:
        void recovery.message(message, sender).then(sendResponse, () => {
          console.warn(RECOVERY_TEXT.operationFailed);
          const reply: RecoveryReply = { ok: false, error: RECOVERY_TEXT.readFailed };
          sendResponse(reply);
        });
        return true;
      case DELIVERY_MESSAGE_PREFIX:
        void delivery.message(message, sender).then(sendResponse, () => {
          console.error(DELIVERY_TEXT.operationFailed);
          const reply: DeliveryReply = { ok: false, error: DELIVERY_TEXT.operationFailed };
          sendResponse(reply);
        });
        return true;
      case DESTINATION_MESSAGE_PREFIX:
        void destination.message(message, sender).then(reply => {
          sendResponse(reply);
          if (!reply.ok || !reply.view.verified) return;
          delivery.resume();
          if (messageType !== DESTINATION_MESSAGE.create) void recovery.selected();
        }, () => {
          console.error(DESTINATION_TEXT.operationFailed);
          const reply: DestinationReply = { ok: false, error: DESTINATION_ISSUE.networkError };
          sendResponse(reply);
        });
        return true;
      case AUTH_MESSAGE_PREFIX:
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
  browser.alarms.onAlarm.addListener(alarm => {
    github.alarm(alarm.name);
    delivery.alarm(alarm.name);
  });
  browser.runtime.onStartup.addListener(() => { delivery.resume(); });
  delivery.resume();
});
