// background entry：注册侧边栏行为、生命周期事件、消息分发
import { STORAGE_KEYS, MSG, API_HOST_DEFAULT, ALARM_NAMES } from '@shared/constants';
import { storage } from '@shared/storage';
import { handleCallbackFetch } from './callback';
import {
  autoTaskState,
  startAutoTaskLoop,
  abortAutoTask,
  runSearchTriggerWithFallback,
  getSearchTriggerMode,
} from './auto-task';
import {
  runNavigateThenAutoLogin,
  doAutoLoginOnTab,
  autoLoginState,
  abortAutoLogin,
} from './auto-login';
import { pushLog, setStatus, executeInPageMain, waitForTabComplete, getLogHistory } from './utils';
import { checkPageHasLoginDialog, checkXhsLoginUiPresent } from './injected';
import { handleStatsOp } from './statsBroker';
import { initNodeIdentityInBackground } from '@shared/nodeIdentity';
import type { AccountItem } from '@/types/xhs';

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

// 允许 content script（ISOLATED world）访问 chrome.storage.session
chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS' }).catch(() => {});

// 节点身份 / 环境信息（100 节点集中管控 · 第一类指标）：
// 保证 nodeId / firstSeenAt 存在，并把浏览器启动时间（onStartup / onInstalled）落盘。
// 必须放在顶层 SW 代码里：MV3 service worker 可能在长等待间被回收，重启时上面 listener 也要重新注册。
initNodeIdentityInBackground();

// ---------- 全局错误捕获 ----------
// MV3 service worker 是 Module Worker：未捕获的 Promise 拒绝 / 同步异常如果不监听，
// 仅在 chrome://extensions 的「检查 Service Worker」里看到。这里把它们也送进 ring buffer 日志，
// 面板能直接看到，避免"自动任务无声断流"类型的问题。
function summarizeError(err: unknown, fallback = 'unknown error'): string {
  if (!err) return fallback;
  if (err instanceof Error) {
    const stack = err.stack || '';
    const top = stack.split('\n').slice(0, 4).join(' / ');
    return `${err.message}${top ? `  | ${top}` : ''}`.slice(0, 400);
  }
  try {
    return String(err).slice(0, 400);
  } catch {
    return fallback;
  }
}
// 这些是 chrome 内部的「预期的非错」rejection（消息没接收方 / SW 上下文失效 / tab 已关闭），
// 不应该污染用户可见的日志面板。命中即仅 console.debug，不进 ringbuffer。
function isBenignChromeIpcError(reason: unknown): boolean {
  const msg = (() => {
    if (!reason) return '';
    if (reason instanceof Error) return reason.message || '';
    try { return String(reason); } catch { return ''; }
  })();
  if (!msg) return false;
  return (
    msg.indexOf('Could not establish connection') !== -1 ||
    msg.indexOf('Receiving end does not exist') !== -1 ||
    msg.indexOf('message channel is closed') !== -1 ||
    msg.indexOf('Extension context invalidated') !== -1 ||
    msg.indexOf('No tab with id') !== -1
  );
}
try {
  self.addEventListener('error', (ev: ErrorEvent) => {
    pushLog(`[未捕获错误] ${summarizeError(ev.error || ev.message)}`).catch(() => {});
  });
  self.addEventListener('unhandledrejection', (ev: PromiseRejectionEvent) => {
    if (isBenignChromeIpcError(ev.reason)) {
      try { console.debug('[bg] benign chrome IPC rejection ignored:', ev.reason); } catch {}
      return;
    }
    pushLog(`[未捕获 Promise] ${summarizeError(ev.reason)}`).catch(() => {});
  });
} catch {}

// service worker 启动时清理脏的 running 标志，避免按钮卡在「取消自动登录」
storage.setOne(STORAGE_KEYS.autoLoginRunning, false).catch(() => {});
autoLoginState.running = false;
autoLoginState.abort = false;

// ---------- 软禁用（pluginPaused）----------
// 内存缓存 + storage 变化监听，避免每次消息都异步读取
let pluginPaused = false;
storage.get([STORAGE_KEYS.pluginPaused]).then((o) => {
  pluginPaused = !!o[STORAGE_KEYS.pluginPaused];
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  const ch = changes[STORAGE_KEYS.pluginPaused];
  if (ch) pluginPaused = !!ch.newValue;
});

// ---------- 登录态检测：以页面 DOM 是否存在「登录」按钮为准，cookie 仅作为无 tab 时的兜底 ----------
const LOGIN_DOMAINS = ['xiaohongshu.com', 'rednote.com'];
const LOGIN_TAB_URL_PATTERNS = [
  '*://*.xiaohongshu.com/*',
  '*://xiaohongshu.com/*',
  '*://*.rednote.com/*',
  '*://rednote.com/*',
];
const LOGIN_COOKIE_TRIGGER_NAMES = ['web_session', 'webBuild', 'sec_poison_id'];

// 主检测：通过 chrome.scripting 注入到已打开的 xhs/rednote 页面，
// 识别页面上是否存在登录入口（登录按钮 / 登录表单）
// - 看到登录入口 → 未登录（false）
// - 所有可判定页面都没看到 → 已登录（true）
// - 没有可用页面（或全部脚本注入失败） → 返回 null 表示「无法判定」，交给兜底
async function detectLoginViaDom(): Promise<boolean | null> {
  let tabs: chrome.tabs.Tab[] = [];
  try {
    tabs = await chrome.tabs.query({ url: LOGIN_TAB_URL_PATTERNS });
  } catch {
    return null;
  }
  const candidates = tabs.filter(
    (t) => t.id != null && t.status === 'complete' && !t.discarded,
  );
  if (candidates.length === 0) return null;
  let determined = false;
  for (const t of candidates) {
    const res = await executeInPageMain(t.id!, checkXhsLoginUiPresent, [], 2000);
    if (res === true) return false;
    if (res === false) determined = true;
  }
  return determined ? true : null;
}

// 兜底检测：只信任真正的会话 Cookie `web_session`
// （`webBuild` / `sec_poison_id` 在未登录时也可能下发，不可靠）
async function detectLoginViaCookie(): Promise<boolean> {
  for (const domain of LOGIN_DOMAINS) {
    const cookies = await new Promise<chrome.cookies.Cookie[]>((resolve) =>
      chrome.cookies.getAll({ domain, name: 'web_session' }, (c) => resolve(c || [])),
    );
    if (cookies.some((c) => c.value && c.value.length > 8)) return true;
  }
  return false;
}

let _syncTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleSyncLoginStatus(delay = 250): void {
  if (_syncTimer) clearTimeout(_syncTimer);
  _syncTimer = setTimeout(() => {
    _syncTimer = null;
    void syncLoginStatus();
  }, delay);
}

// 返回本次检测使用的方式，便于 UI 提示「已通过页面检测 / cookie 兜底」
async function syncLoginStatus(): Promise<{
  loggedIn: boolean;
  via: 'dom' | 'cookie';
}> {
  let loggedIn = false;
  let via: 'dom' | 'cookie' = 'cookie';
  try {
    const dom = await detectLoginViaDom();
    if (dom !== null) {
      loggedIn = dom;
      via = 'dom';
    } else {
      loggedIn = await detectLoginViaCookie();
      via = 'cookie';
    }
    const o = await storage.get([STORAGE_KEYS.xhsLoggedIn]);
    if (o[STORAGE_KEYS.xhsLoggedIn] !== loggedIn) {
      await storage.setOne(STORAGE_KEYS.xhsLoggedIn, loggedIn);
    }
  } catch {}
  return { loggedIn, via };
}

scheduleSyncLoginStatus(0);

chrome.cookies.onChanged.addListener((info) => {
  const d = info.cookie.domain || '';
  if (!/xiaohongshu\.com|rednote\.com/.test(d)) return;
  if (!LOGIN_COOKIE_TRIGGER_NAMES.includes(info.cookie.name)) return;
  scheduleSyncLoginStatus();
});

chrome.tabs.onUpdated.addListener((_tabId, info, tab) => {
  if (info.status !== 'complete') return;
  const url = tab?.url || '';
  if (!/xiaohongshu\.com|rednote\.com/.test(url)) return;
  scheduleSyncLoginStatus();
});

chrome.tabs.onActivated.addListener(({ tabId }) => {
  chrome.tabs.get(tabId, (tab) => {
    if (chrome.runtime.lastError || !tab?.url) return;
    if (!/xiaohongshu\.com|rednote\.com/.test(tab.url)) return;
    scheduleSyncLoginStatus();
  });
});

chrome.tabs.onRemoved.addListener(() => {
  scheduleSyncLoginStatus(500);
});

function openSidePanelInLastFocusedWindow() {
  chrome.tabs.query({ active: true, lastFocusedWindow: true }, (tabs) => {
    const t = tabs?.[0];
    if (!t || t.windowId == null) return;
    chrome.sidePanel.open({ windowId: t.windowId }).catch(() => {});
  });
}

chrome.runtime.onInstalled.addListener(async (details) => {
  const o = await storage.get([STORAGE_KEYS.apiHost]);
  if (!o[STORAGE_KEYS.apiHost] || (o[STORAGE_KEYS.apiHost] || '').trim() === '') {
    await storage.setOne(STORAGE_KEYS.apiHost, API_HOST_DEFAULT);
  }
  if (details.reason === 'install') openSidePanelInLastFocusedWindow();
});

chrome.runtime.onStartup.addListener(async () => {
  openSidePanelInLastFocusedWindow();
  const o = await storage.get([
    STORAGE_KEYS.autoTaskRunInBackground,
    STORAGE_KEYS.pluginPaused,
    STORAGE_KEYS.autoTaskResumeState,
  ]);
  if (o[STORAGE_KEYS.pluginPaused]) {
    pluginPaused = true;
    return;
  }
  if (o[STORAGE_KEYS.autoTaskRunInBackground]) {
    autoTaskState.abort = false;
    await storage.setOne(STORAGE_KEYS.autoTaskRunning, true);
    // 若存在上次停机时的恢复点，优先从恢复点继续，避免重复跑已完成的关键词
    const resume = o[STORAGE_KEYS.autoTaskResumeState];
    if (resume && Array.isArray(resume.keywords) && typeof resume.nextIndex === 'number') {
      startAutoTaskLoop({ resumeFrom: resume });
    } else {
      startAutoTaskLoop();
    }
  }
});

// ---------- 消息分发 ----------
const ALLOW_WHEN_PAUSED = new Set<string>([
  MSG.stopAutoTask,
  MSG.abortAutoLogin,
  MSG.syncLoginStatus,
  MSG.setPluginPaused,
  // 暂停期间用户仍可能想点重置 / 清零，且 isolate 已有的 inflight +1 也要落账；
  // 让 stats 通道独立于「主动任务」开关，保持与旧版本「直写 storage」一致的行为。
  MSG.statsOp,
]);

chrome.runtime.onMessage.addListener((msg: any, sender, sendResponse) => {
  // 「软禁用」总开关：可随时切换，停止 / 恢复均由此入口
  if (msg?.type === MSG.setPluginPaused) {
    const paused = !!msg.paused;
    pluginPaused = paused;
    storage.setOne(STORAGE_KEYS.pluginPaused, paused).catch(() => {});
    if (paused) {
      try {
        abortAutoTask();
      } catch {}
      try {
        abortAutoLogin();
      } catch {}
      autoLoginState.running = false;
      storage.setOne(STORAGE_KEYS.autoLoginRunning, false).catch(() => {});
      storage.setOne(STORAGE_KEYS.autoTaskRunning, false).catch(() => {});
      storage.setOne(STORAGE_KEYS.autoTaskStatus, '插件已暂停').catch(() => {});
      // 同时清理「恢复点」和对应 alarm，避免暂停期间 SW 被 alarm 唤醒后自动续跑
      storage.remove(STORAGE_KEYS.autoTaskResumeState).catch(() => {});
      chrome.alarms.clear(ALARM_NAMES.autoTaskResume).catch(() => {});
      pushLog('插件已暂停，所有自动动作停止');
    } else {
      pushLog('插件已恢复');
    }
    sendResponse({ ok: true, paused });
    return false;
  }

  if (pluginPaused && msg?.type && !ALLOW_WHEN_PAUSED.has(msg.type)) {
    // 暂停期间拒绝主动任务 / 回调上报 等；一律静默失败
    try {
      sendResponse({ ok: false, paused: true });
    } catch {}
    return false;
  }

  if (msg?.type === MSG.startAutoTask) {
    autoTaskState.abort = false;
    startAutoTaskLoop();
    sendResponse({ ok: true });
    return true;
  }
  if (msg?.type === MSG.stopAutoTask) {
    abortAutoTask();
    sendResponse({ ok: true });
    return false;
  }
  if (msg?.type === MSG.loginDialogDetected) {
    handleLoginDialogDetected(sender);
    return false;
  }
  if (msg?.type === MSG.runNavigateThenAutoLogin && msg.tabId != null) {
    autoLoginState.abort = false;
    autoLoginState.running = true;
    storage.setOne(STORAGE_KEYS.autoLoginRunning, true).catch(() => {});
    runNavigateThenAutoLogin(msg.tabId)
      .then((ok) => {
        autoLoginState.running = false;
        storage.setOne(STORAGE_KEYS.autoLoginRunning, false).catch(() => {});
        sendResponse({ ok: !!ok, aborted: autoLoginState.abort });
      })
      .catch(() => {
        autoLoginState.running = false;
        storage.setOne(STORAGE_KEYS.autoLoginRunning, false).catch(() => {});
        sendResponse({ ok: false, aborted: autoLoginState.abort });
      });
    return true;
  }
  if (msg?.type === MSG.syncLoginStatus) {
    syncLoginStatus()
      .then((r) => sendResponse({ ok: true, ...r }))
      .catch(() => sendResponse({ ok: false }));
    return true;
  }
  if (msg?.type === MSG.abortAutoLogin) {
    abortAutoLogin();
    autoLoginState.running = false;
    storage.setOne(STORAGE_KEYS.autoLoginRunning, false).catch(() => {});
    pushLog('已请求取消自动登录');
    sendResponse({ ok: true });
    return false;
  }
  if (msg?.type === MSG.autoTaskLogHistoryRequest) {
    // 同步返回 ring buffer 快照；panel 打开时用它填充历史
    try {
      sendResponse({ ok: true, entries: getLogHistory() });
    } catch {}
    return false;
  }
  // 手动顺序执行：复用自动任务的 mode 分发 + 失败回退；与 auto-task 共享 firstPage 信号轨道
  // 和 recentFirstPageHits buffer，所以两者**不应**同时运行（panel UI 已通过禁用按钮规避）。
  if (msg?.type === MSG.triggerKeywordSearch) {
    const tabId = Number(msg?.tabId);
    const keyword = String(msg?.keyword || '').trim();
    if (!Number.isFinite(tabId) || !keyword) {
      sendResponse({ ok: false, error: 'invalid_args' });
      return false;
    }
    (async () => {
      try {
        const mode = await getSearchTriggerMode();
        // 手动模式没有 abort 通道（panel 的 cancel 是「不再发下一个」，不打断当前这次）
        const r = await runSearchTriggerWithFallback(tabId, keyword, mode, () => false);
        sendResponse({ ok: r === 'ok', mode, status: r });
      } catch (e: any) {
        sendResponse({ ok: false, error: summarizeError(e) });
      }
    })();
    return true; // 异步 sendResponse
  }
  if (msg?.type === MSG.statsOp && msg?.payload) {
    handleStatsOp(msg.payload)
      .then((r) => {
        try {
          sendResponse(r);
        } catch {}
      })
      .catch((e) => {
        try {
          sendResponse({ ok: false, error: summarizeError(e) });
        } catch {}
      });
    return true; // 异步 sendResponse
  }
  return handleCallbackFetch(msg, sendResponse);
});

// ---------- 登录弹窗检测处理 ----------
// 注：这里不再维护独立的 `_autoLoginInProgress` 标记，
// 统一用 `autoLoginState.running` 作为「自动登录是否正在进行」的唯一真源，
// 避免两套状态不一致（如手动启动自动登录期间再次弹出登录框被重复触发）。

function setAutoLoginRunning(running: boolean): void {
  autoLoginState.running = running;
  storage.setOne(STORAGE_KEYS.autoLoginRunning, running).catch(() => {});
}

async function handleLoginDialogDetected(sender: chrome.runtime.MessageSender): Promise<void> {
  if (autoLoginState.running) return;
  const tabId = sender?.tab?.id;
  if (!tabId) return;

  const o = await storage.get([
    STORAGE_KEYS.accountList,
    STORAGE_KEYS.selectedAccountIndex,
    STORAGE_KEYS.autoLoginOnDialog,
    STORAGE_KEYS.autoTaskRunning,
    STORAGE_KEYS.autoTaskAutoLoginEnabled,
  ]);
  if (o[STORAGE_KEYS.autoLoginOnDialog] === false) return;
  const autoTaskActive = !!(o[STORAGE_KEYS.autoTaskRunning] || autoTaskState.running);
  if (autoTaskActive && o[STORAGE_KEYS.autoTaskAutoLoginEnabled] !== true) {
    await pushLog('检测到登录弹窗，未勾选「需要时自动登录」，不执行自动登录');
    return;
  }
  const accs: AccountItem[] = (o[STORAGE_KEYS.accountList] || []).map((it: any) => ({
    phone: (it.phone || '').trim(),
    codeUrl: (it.codeUrl || '').trim(),
    maxCollectCount: it.maxCollectCount != null ? parseInt(it.maxCollectCount, 10) : 200,
  }));
  const accIdx = parseInt(o[STORAGE_KEYS.selectedAccountIndex], 10) || 0;
  if (accIdx < 0 || accIdx >= accs.length) return;
  const acc = accs[accIdx];
  if (!acc.phone || !acc.codeUrl) {
    await pushLog(`检测到登录弹窗，但账号 ${accIdx + 1} 缺少手机号或接码链接`);
    return;
  }
  if (acc.maxCollectCount === 0) {
    await pushLog(`检测到登录弹窗，但账号 ${accIdx + 1} 采集上限为 0`);
    return;
  }

  setAutoLoginRunning(true);
  autoLoginState.abort = false;
  const taskWasRunning = autoTaskActive;
  await pushLog('检测到登录弹窗，刷新页面确认登录状态…');

  if (taskWasRunning) {
    autoTaskState.abort = true;
    if (autoTaskState.countdownTimer) clearInterval(autoTaskState.countdownTimer);
    if (autoTaskState.waitTimer) clearTimeout(autoTaskState.waitTimer);
    await storage.set({
      [STORAGE_KEYS.autoTaskRunning]: false,
      [STORAGE_KEYS.autoTaskStatus]: '检测到登录弹窗，暂停采集任务',
    });
  }

  await new Promise<void>((resolve) => chrome.tabs.reload(tabId, {}, () => resolve()));
  await waitForTabComplete(tabId);
  await new Promise((r) => setTimeout(r, 3000));

  const stillNeed = await executeInPageMain(tabId, checkPageHasLoginDialog, []);
  if (!stillNeed) {
    await pushLog('刷新后登录框消失，判断为已登录，无需重新登录');
    setAutoLoginRunning(false);
    if (taskWasRunning) {
      await pushLog('自动恢复采集任务');
      autoTaskState.abort = false;
      startAutoTaskLoop();
    }
    return;
  }

  await pushLog(`刷新后仍需登录，跳转到配置页并执行自动登录账号 ${accIdx + 1}`);
  const ok = await runNavigateThenAutoLogin(tabId).catch(() => false);
  setAutoLoginRunning(false);
  if (ok) {
    await pushLog('登录成功，自动启动采集任务');
    if (!autoTaskState.running) {
      autoTaskState.abort = false;
      startAutoTaskLoop();
    }
  } else if (taskWasRunning) {
    await pushLog('自动登录未完成，15秒后重试');
    setTimeout(() => {
      autoTaskState.abort = false;
      startAutoTaskLoop();
    }, 15000);
  }
}
// 兼容未使用导入（保留 doAutoLoginOnTab 公开 API）
void doAutoLoginOnTab;
