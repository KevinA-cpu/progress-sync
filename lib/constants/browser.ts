export const APP_NAME = 'Progress Sync';
export const LOG_PREFIX = 'Progress Sync:';

export const STORAGE_ACCESS = { trustedContexts: 'TRUSTED_CONTEXTS' } as const;
export const STORAGE_AREA = { local: 'local', session: 'session' } as const;
export const DOCUMENT_LIFECYCLE = { active: 'active' } as const;
export const RESOURCE_TYPE = { mainFrame: 'main_frame', subFrame: 'sub_frame' } as const;
export const NAVIGATION_QUALIFIER = { forwardBack: 'forward_back' } as const;
export const TAB_STATUS = { loading: 'loading' } as const;
export const WEB_REQUEST_OPTION = { requestBody: 'requestBody' } as const;
export const HTTP_METHOD = { post: 'POST' } as const;
export const FETCH_POLICY = { credentials: 'omit', redirect: 'error', cache: 'no-store' } as const;

export const EXTENSION_PAGE = {
  options: '/options.html',
  connect: '/connect.html',
  destination: '/destination.html',
  githubAppConfig: '/github-app.json',
} as const;

export const EXTENSION_PERMISSION = {
  storage: 'storage',
  webRequest: 'webRequest',
  webNavigation: 'webNavigation',
  alarms: 'alarms',
} as const;

export const DOM_EVENT = { click: 'click', pageHide: 'pagehide', abort: 'abort' } as const;
export const UI_ROLE = { status: 'status', alert: 'alert' } as const;
export const SDK_HOOK = { request: 'request' } as const;
export const EXTENSION_DESCRIPTION = 'Record accepted HDLBits submissions and connect a GitHub session.';
export const EXTENSION_ACTION_TITLE = 'Open Progress Sync';
export const MINIMUM_CHROME_VERSION = '120';
export const CONTENT_SCRIPT_RUN_AT = 'document_idle';
