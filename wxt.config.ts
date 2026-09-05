import { defineConfig } from 'wxt';

export default defineConfig({
  imports: false,
  manifest: {
    name: 'Progress Sync',
    description: 'Record accepted HDLBits submissions and connect a GitHub session.',
    minimum_chrome_version: '120',
    permissions: ['storage', 'webRequest', 'webNavigation', 'alarms'],
    host_permissions: [
      'https://hdlbits.01xz.net/*', 'https://github.com/*', 'https://api.github.com/*',
    ],
    action: { default_title: 'Open Progress Sync' },
  },
});
