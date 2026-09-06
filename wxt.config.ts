import {
  APP_NAME, EXTENSION_ACTION_TITLE, EXTENSION_DESCRIPTION, EXTENSION_PERMISSION,
  MINIMUM_CHROME_VERSION,
} from './lib/constants/browser';
import { GITHUB_API_HOST_MATCH, GITHUB_HOST_MATCH } from './lib/constants/github';
import { HDL_HOST_MATCH } from './lib/constants/progress';
import { defineConfig } from 'wxt';

export default defineConfig({
  imports: false,
  manifest: {
    name: APP_NAME,
    description: EXTENSION_DESCRIPTION,
    minimum_chrome_version: MINIMUM_CHROME_VERSION,
    permissions: [EXTENSION_PERMISSION.storage, EXTENSION_PERMISSION.webRequest, EXTENSION_PERMISSION.webNavigation, EXTENSION_PERMISSION.alarms],
    host_permissions: [
      HDL_HOST_MATCH, GITHUB_HOST_MATCH, GITHUB_API_HOST_MATCH,
    ],
    action: { default_title: EXTENSION_ACTION_TITLE },
  },
});
