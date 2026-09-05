import { defineConfig } from 'wxt';

export default defineConfig({
  imports: false,
  manifest: {
    name: 'Progress Sync',
    description: 'Keep a local record of exact accepted HDLBits submissions.',
    minimum_chrome_version: '120',
    permissions: ['storage', 'webRequest', 'webNavigation'],
    host_permissions: ['https://hdlbits.01xz.net/*'],
    action: { default_title: 'Open Progress Sync' },
  },
});
