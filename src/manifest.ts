import { defineManifest } from '@crxjs/vite-plugin';
import pkg from '../package.json' with { type: 'json' };

export default defineManifest({
  manifest_version: 3,
  name: 'XhsDataCrawler',
  version: pkg.version,
  description: '小红书/红书 内容采集',
  permissions: ['sidePanel', 'tabs', 'storage', 'scripting', 'cookies', 'browsingData', 'alarms'],
  // 注：chrome.system.network.getNetworkInterfaces 是 ChromeOS 专属（Apps API），
  // 桌面 Chrome (Win/Mac/Linux) 拿不到。所以这里不再申请 system.network 权限，
  // 桌面侧改用 WebRTC ICE candidate 探内网 IP + 用户手填字段兜底。
  host_permissions: [
    'https://www.xiaohongshu.com/*',
    'https://www.rednote.com/*',
    'https://edith.xiaohongshu.com/*',
    'https://webapi.rednote.com/*',
    'https://*/*',
    'http://*/*',
  ],
  icons: {
    16: 'icons/icon-16.png',
    32: 'icons/icon-32.png',
    48: 'icons/icon-48.png',
    128: 'icons/icon-128.png',
  },
  action: {
    default_title: '打开侧边栏',
    default_icon: {
      16: 'icons/icon-16.png',
      32: 'icons/icon-32.png',
      48: 'icons/icon-48.png',
      128: 'icons/icon-128.png',
    },
  },
  side_panel: { default_path: 'src/panel/index.html' },
  background: { service_worker: 'src/background/index.ts', type: 'module' },
  content_scripts: [
    {
      matches: ['https://www.xiaohongshu.com/*', 'https://www.rednote.com/*'],
      js: ['src/content/main.ts'],
      run_at: 'document_start',
      world: 'MAIN',
      // 覆盖所有同源 iframe，防止站点在 iframe 里对比 "fetch toString" 绕过 patch
      all_frames: true,
    },
    {
      matches: ['https://www.xiaohongshu.com/*', 'https://www.rednote.com/*'],
      js: ['src/content/isolate.ts'],
      run_at: 'document_start',
    },
  ],
});
