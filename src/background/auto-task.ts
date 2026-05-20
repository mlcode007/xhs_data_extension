// 后台自动任务循环：拉关键词 → 跳搜索页 → 应用筛选 → 滚动加载第二页 → 等待 → 下一词
import {
  STORAGE_KEYS,
  KEYWORD_FETCH_PAGE_CHECK_ROUNDS,
  KEYWORD_FETCH_PAGE_CHECK_INTERVAL_MS,
  ALARM_NAMES,
  MSG,
  SEARCH_TRIGGER_MODE_DEFAULT,
  SEARCH_TRIGGER_MODE_LABEL,
  isSearchTriggerMode,
  type SearchTriggerMode,
} from '@shared/constants';
import { storage, sessionStore, onLocalStorageChange } from '@shared/storage';
import { fetchKeywordTask, getApiHost, isPlaceholderHost } from '@shared/api';
import { mergeKeywordTaskResultIntoStorage } from '@shared/pluginKeywordsMerge';
import { getTodayDateStr, isInAllowedTimeRanges } from '@shared/time';
import { getConfiguredExploreHomeUrl, isXhsLikeHost } from '@shared/url';
import { runStorageGC, maybeRunDailyBusinessPrune } from '@shared/storage-gc';
import { ensureAccountListHydrated } from '@shared/accountListFinalize';
import { handleStatsOp } from './statsBroker';
import {
  pushLog,
  setStatus,
  sendCountdownToPage,
  getActiveTab,
  waitForTabComplete,
  buildSearchResultUrlAsync,
  getRandomIntervalMs,
  isAccountExceededToday,
  areAllAccountsExceededToday,
  findNextAvailableAccount,
  getAccountTodayCollectCount,
  executeInPageMain,
  readAllowedTimeRanges,
  formatAllowedTimeRanges,
} from './utils';
import {
  isPublishTimeFilterVisible,
  clickPublishTimeFilterOpener,
  clickPublishTimeOption,
  scrollToLoadMore,
  pageShouldBlockKeywordFetch,
  checkXhsLoginUiPresent,
  searchByInputInPage,
  runHumanSearch,
} from './injected';
import { doAutoSwitchAccount, runNavigateThenAutoLogin, getLoginMode, doAutoSwitchAccountQr } from './auto-login';
import {
  getQrSessionStats,
  getQrLoginDefaultMax,
  getStoredCurrentSessionHash,
  isQrSessionExceededToday,
  qrSessionMax,
  qrSessionTodayCount,
} from '@shared/qrSession';
import type { AccountItem, AccountCollectStats, KeywordTaskInfo } from '@/types/xhs';

interface AutoTaskState {
  abort: boolean;
  running: boolean;
  sessionGen: number;
  countdownTimer: number | null;
  waitTimer: number | null;
  /**
   * 当前自动任务「绑定」的标签页 id。
   * 首次定位后粘住不换，避免用户在多窗口/多标签之间切换时，后续请求落到错误的标签页上。
   * 当绑定的标签页不可用（已关闭 / 跳到非 xhs 域）时会回退到查找任一 xhs 标签页。
   */
  workingTabId: number | null;
}

export const autoTaskState: AutoTaskState = {
  abort: false,
  running: false,
  sessionGen: 0,
  countdownTimer: null,
  waitTimer: null,
  workingTabId: null,
};

// 标签页被关闭时清理绑定，避免后续复用到已失效的 tabId
try {
  chrome.tabs.onRemoved.addListener((tabId) => {
    if (autoTaskState.workingTabId === tabId) {
      autoTaskState.workingTabId = null;
    }
  });
} catch {}

// ---------- allowedTimeRanges 变更的「主动唤醒」信号 ----------
// 用户在面板上加 / 删 / 编辑可执行时间段后，希望 background 几乎 0 延迟地感知。
// 实现：等待循环里 Promise.race([sleep, allowedRangesChangedPromise])；
// 这里在模块顶层注册一次 onChanged 监听 —— SW 重启会重新执行本模块、监听会被重新挂上，
// 不需要担心 SW 回收后失效。
let allowedRangesChangedResolver: (() => void) | null = null;
function nextAllowedRangesChangedPromise(): Promise<void> {
  return new Promise<void>((resolve) => {
    // 同一时刻只保留最新一个 resolver；上一个被覆盖也 OK，反正不会有人 await 它
    allowedRangesChangedResolver = resolve;
  });
}
try {
  onLocalStorageChange(STORAGE_KEYS.allowedTimeRanges, () => {
    const r = allowedRangesChangedResolver;
    allowedRangesChangedResolver = null;
    if (r) r();
  });
} catch {}

// ---------- 搜索触发：模式分发 + 首页响应等待 ----------
// 三种模式（直跳 / 拟人 / 速填）共享同一条数据下游链路（首屏清空 / pages 累积 / 回传 /
// 计数 / 已执行标记）。差异封装在 runSearchTrigger 内，对调度循环不可见。
//
// 信号轨道：content/main.ts 拦到 /search/notes 第一页且 body.keyword 匹配时，会通过
// isolate world 转发 MSG.searchFirstPageHit；下面的 Map 用 keyword 作为 key 唤醒
// awaitSearchFirstPage()。URL 模式额外保留 waitForTabComplete 作为「页面加载完」前置保证，
// 拟人 / 速填模式只能依赖这个信号（SPA 路由不会改变 tab.status）。

const pendingFirstPage = new Map<string, (ok: boolean) => void>();
/**
 * 「在 awaitSearchFirstPage 注册之前」就到达的 hit 缓冲（keyword → 到达时间戳）。
 * 解决 race：触发函数（runHumanSearch / searchByInputInPage / waitForTabComplete）
 * 返回时，xhs 的 /search/notes 响应可能已经穿过 main→isolate→background onMessage 链路；
 * 若此时 awaitSearchFirstPage 尚未把 resolver 写入 pendingFirstPage，hit 就被丢失，
 * 调用方会一直等到超时（人为造成 URL 兜底降级）。
 *
 * 策略：onMessage 命中时若无 resolver，把 keyword 落到 buffer；awaitSearchFirstPage
 * 注册前先消费 buffer 立刻返回。每次新关键词触发前 `runSearchTriggerWithFallback`
 * 会把 buffer 清空，避免跨关键词污染（同名关键词早返、上一词慢响应误命中等）。
 */
const recentFirstPageHits = new Set<string>();

try {
  chrome.runtime.onMessage.addListener((msg: any) => {
    if (msg?.type !== MSG.searchFirstPageHit) return;
    const kw = String(msg?.keyword || '').trim();
    if (!kw) return;
    const resolver = pendingFirstPage.get(kw);
    if (resolver) {
      pendingFirstPage.delete(kw);
      resolver(true);
    } else {
      if (recentFirstPageHits.size > 100) recentFirstPageHits.clear();
      recentFirstPageHits.add(kw);
    }
  });
} catch {}

/** 等待指定 keyword 的 /search/notes 首页响应；超时返回 false */
function awaitSearchFirstPage(keyword: string, timeoutMs: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const kw = String(keyword || '').trim();
    if (!kw) {
      resolve(false);
      return;
    }
    // 注册前先吃掉 buffer 里的早到 hit，避免触发-注册时序竞态
    if (recentFirstPageHits.delete(kw)) {
      resolve(true);
      return;
    }
    // 同一 keyword 若已有等待者（理论上不会发生），先把旧的当超时处理
    const prev = pendingFirstPage.get(kw);
    if (prev) {
      pendingFirstPage.delete(kw);
      try {
        prev(false);
      } catch {}
    }
    const timer = setTimeout(() => {
      if (pendingFirstPage.get(kw) === wrapped) pendingFirstPage.delete(kw);
      resolve(false);
    }, timeoutMs);
    const wrapped = (ok: boolean) => {
      clearTimeout(timer);
      resolve(ok);
    };
    pendingFirstPage.set(kw, wrapped);
  });
}

/** 读当前模式；不合法值兜底为默认（直跳） */
export async function getSearchTriggerMode(): Promise<SearchTriggerMode> {
  const v = await storage.getOne(STORAGE_KEYS.searchTriggerMode);
  return isSearchTriggerMode(v) ? v : SEARCH_TRIGGER_MODE_DEFAULT;
}

/**
 * SPA 模式（拟人 / 速填）需要当前 tab 已经在带搜索框的小红书页。
 * 若不在，自动跳到 explore 主页，等加载完再返回。
 */
function isAlreadyOnExploreHome(currentUrl: string, exploreHome: string): boolean {
  try {
    const cu = new URL(currentUrl);
    const tu = new URL(exploreHome);
    if (cu.origin !== tu.origin) return false;
    const p = (cu.pathname || '/').replace(/\/+$/, '') || '/';
    return p === '/explore' || p === '';
  } catch {
    return false;
  }
}

/** 进入工作时间等场景：把当前工作标签拉回配置站点的 explore 首页 */
async function navigateWorkingTabToConfiguredExploreHome(logPrefix: string): Promise<void> {
  try {
    const o = await storage.get([STORAGE_KEYS.searchSiteBase]);
    const exploreUrl = getConfiguredExploreHomeUrl(o[STORAGE_KEYS.searchSiteBase] as string | undefined);
    const tab = await resolveWorkingTab();
    if (!tab?.id) {
      await pushLog(`${logPrefix}：未找到小红书标签页，跳过首页跳转`);
      return;
    }
    const tabId = tab.id;
    const cur = tab.url || '';
    if (isAlreadyOnExploreHome(cur, exploreUrl)) {
      await pushLog(`${logPrefix}：已在配置站点首页，跳过跳转`);
      return;
    }
    await pushLog(`${logPrefix}：跳转配置站点首页 ${exploreUrl}`);
    await new Promise<void>((resolve, reject) => {
      chrome.tabs.update(tabId, { url: exploreUrl }, () => {
        if (chrome.runtime.lastError) reject(chrome.runtime.lastError);
        else resolve();
      });
    });
    await waitForTabComplete(tabId);
  } catch (e: any) {
    await pushLog(`${logPrefix}：跳转首页失败 ${e?.message || e}`);
  }
}

async function ensureOnSearchablePage(tabId: number): Promise<boolean> {
  try {
    const tab = await new Promise<chrome.tabs.Tab>((resolve, reject) => {
      chrome.tabs.get(tabId, (t) => {
        if (chrome.runtime.lastError || !t) reject(chrome.runtime.lastError);
        else resolve(t);
      });
    });
    const url = tab.url || '';
    if (/(?:xiaohongshu|rednote)\.com/i.test(url) && !/captcha|website-login/i.test(url)) {
      return true;
    }
  } catch {
    return false;
  }
  const o = await storage.get([STORAGE_KEYS.searchSiteBase]);
  const exploreUrl = getConfiguredExploreHomeUrl(o[STORAGE_KEYS.searchSiteBase] as string | undefined);
  await pushLog('当前页非小红书可搜索页，先跳转到 explore 主页…');
  try {
    await new Promise<void>((resolve, reject) => {
      chrome.tabs.update(tabId, { url: exploreUrl }, () => {
        if (chrome.runtime.lastError) reject(chrome.runtime.lastError);
        else resolve();
      });
    });
  } catch {
    return false;
  }
  await waitForTabComplete(tabId);
  return true;
}

// ---------- MV3 Service Worker 生命周期 & 恢复点 ----------
// 关键词间的等待可能 > 30s，SW 会被 Chrome 回收。
// 策略：进入长等待前把 {keywords, taskInfos, nextIndex, sessionGen} 写入
// STORAGE_KEYS.autoTaskResumeState，并 chrome.alarms 到期唤醒 SW；
// 唤醒后若检测到还在「运行中」且没有活的内存 loop，就从 nextIndex 继续执行。

interface AutoTaskResumeState {
  sessionGen: number;
  keywords: string[];
  taskInfos: KeywordTaskInfo[];
  nextIndex: number;
  savedAt: number;
}

async function saveResumeState(state: Omit<AutoTaskResumeState, 'savedAt'>): Promise<void> {
  await storage.setOne(STORAGE_KEYS.autoTaskResumeState, {
    ...state,
    savedAt: Date.now(),
  } as AutoTaskResumeState);
}

async function clearResumeState(): Promise<void> {
  await storage.remove(STORAGE_KEYS.autoTaskResumeState);
  try {
    await chrome.alarms.clear(ALARM_NAMES.autoTaskResume);
  } catch {}
}

async function loadResumeState(): Promise<AutoTaskResumeState | null> {
  const v = await storage.getOne<AutoTaskResumeState>(STORAGE_KEYS.autoTaskResumeState);
  if (!v || typeof v !== 'object') return null;
  if (!Array.isArray(v.keywords) || typeof v.nextIndex !== 'number') return null;
  return v;
}

/**
 * alarm 唤醒标记：
 *   - 由 onAlarm 在 SW 被冷启后置为 true；
 *   - 主循环每轮 iter 开头消费一次：发一个 ping 给工作 tab 检测 content script
 *     是否还能注入；ping 不通时跳 explore 首页强制把脚本注回，避免 alarm 重启
 *     后落到旧的、已与 SW 断开的页面上盲跑导致首词无回传。
 * 仅作为「软提示」：即便忘清也最多在下一 iter 多 ping 一次，不影响正确性。
 */
let alarmRevivePending = false;

async function pingWorkingTab(timeoutMs = 1500): Promise<boolean> {
  const tab = await resolveWorkingTab();
  if (!tab?.id) return false;
  return await new Promise<boolean>((resolve) => {
    let done = false;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      resolve(ok);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    try {
      chrome.tabs.sendMessage(tab.id!, { type: MSG.dataCrawlerPing }, (resp) => {
        clearTimeout(timer);
        const err = chrome.runtime.lastError;
        if (err || !resp) finish(false);
        else finish(!!resp.pong);
      });
    } catch {
      clearTimeout(timer);
      finish(false);
    }
  });
}

async function handleAlarmRevived(): Promise<void> {
  const ok = await pingWorkingTab();
  if (ok) {
    await pushLog('alarm 唤醒：工作标签 content script 健康，继续');
    return;
  }
  await pushLog('alarm 唤醒：工作标签 ping 失败，跳转配置站点首页重注脚本');
  await navigateWorkingTabToConfiguredExploreHome('alarm 唤醒');
}

// Chrome 会在 alarm 到期时自动唤醒 SW（或保持活跃时直接触发）。
// 这里做惰性唤醒入口：只处理恢复 alarm，其他场景交给业务自身。
try {
  chrome.alarms.onAlarm.addListener(async (alarm) => {
    if (alarm.name !== ALARM_NAMES.autoTaskResume) return;
    // 已在运行中（内存 loop 活着），setTimeout 竞速会兜住，不重复触发
    if (autoTaskState.running) return;
    // 被软禁用时不要自动唤醒
    const paused = await storage.getOne(STORAGE_KEYS.pluginPaused);
    if (paused) return;
    // 被用户关闭了自动任务（autoTaskRunning=false），忽略
    const running = await storage.getOne(STORAGE_KEYS.autoTaskRunning);
    if (!running) return;
    // 标记本次启动是 alarm 唤醒，主循环 iter 起始处会做 ping + 必要时跳首页
    alarmRevivePending = true;
    const state = await loadResumeState();
    if (state) {
      // SW 重启后从恢复点继续（关键词中途）
      pushLog(
        `alarm 唤醒：从恢复点续跑，剩余 ${Math.max(0, state.keywords.length - state.nextIndex)} 个关键词`,
      ).catch(() => {});
      startAutoTaskLoop({ resumeFrom: state }).catch(() => {});
      return;
    }
    // 没有恢复点但 autoTaskRunning=true：通常是「非工作时间等待」期间 SW 被回收。
    // 直接重启主循环，进入后会再次走时间闸 / 拉词流程，不会重复跑已完成的关键词。
    pushLog('alarm 唤醒：未找到恢复点，重启主循环以继续时间闸/拉词流程').catch(() => {});
    startAutoTaskLoop().catch(() => {});
  });
} catch {}

/** 内部 countdown 包装：自动把 workingTabId 传给 sendCountdownToPage，避免发给错误窗口 */
function countdown(show: boolean, text?: string, seconds?: number): void {
  sendCountdownToPage(show, text, seconds, autoTaskState.workingTabId ?? undefined);
}

/** 解析「当前自动任务应当操作的标签页」，优先复用 workingTabId */
async function resolveWorkingTab(): Promise<chrome.tabs.Tab | null> {
  const prev = autoTaskState.workingTabId;
  if (prev != null) {
    const tab = await new Promise<chrome.tabs.Tab | null>((resolve) => {
      chrome.tabs.get(prev, (t) => {
        if (chrome.runtime.lastError || !t) resolve(null);
        else resolve(t);
      });
    });
    if (tab?.id != null) return tab;
    autoTaskState.workingTabId = null;
  }
  const active = await getActiveTab();
  if (active?.id != null) {
    autoTaskState.workingTabId = active.id;
    return active;
  }
  // 兜底：找任一 xhs/rednote 标签页
  const any = await new Promise<chrome.tabs.Tab | null>((resolve) => {
    chrome.tabs.query(
      { url: ['*://*.xiaohongshu.com/*', '*://*.rednote.com/*'] },
      (tabs) => resolve(tabs?.[0] || null),
    );
  });
  if (any?.id != null) autoTaskState.workingTabId = any.id;
  return any;
}

function clearScheduledTimers() {
  if (autoTaskState.countdownTimer) {
    clearInterval(autoTaskState.countdownTimer);
    autoTaskState.countdownTimer = null;
  }
  if (autoTaskState.waitTimer) {
    clearTimeout(autoTaskState.waitTimer);
    autoTaskState.waitTimer = null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * 带抖动的等待：在 [ms*(1-factor), ms*(1+factor)] 区间内随机。
 * 用于"操作步骤之间的短等待"，避免时序规律被识别为机器行为。
 * 长重试等待（15s/5s 等）不建议加抖动，保持可预测性更利于运维判断。
 */
function sleepJitter(ms: number, factor = 0.2): Promise<void> {
  const min = Math.max(0, ms * (1 - factor));
  const max = ms * (1 + factor);
  const t = Math.floor(min + Math.random() * (max - min));
  return sleep(t);
}

function resolveSearchKeyword(
  primary: any,
  taskInfos: KeywordTaskInfo[],
  index: number,
): string {
  let k: any = primary;
  if (k != null && typeof k === 'object' && !Array.isArray(k)) {
    k = k.Keywords ?? k.keyword ?? k.name;
  }
  if (k != null && String(k).trim() !== '') return String(k).trim();
  if (taskInfos?.length) {
    const info = taskInfos[index] != null ? taskInfos[index] : taskInfos[0];
    if (info && typeof info === 'object') {
      const k2 = info.Keywords ?? (info as any).keyword ?? (info as any).name;
      if (k2 != null && String(k2).trim() !== '') return String(k2).trim();
    }
  }
  return '';
}

async function applyPublishTimeFilter(tabId: number, optionText: string): Promise<void> {
  if (!optionText) return;
  const pollInterval = 500;
  const maxWait = 15000;
  const start = Date.now();
  while (Date.now() - start < maxWait) {
    const visible = await executeInPageMain(tabId, isPublishTimeFilterVisible, []);
    if (visible) {
      await executeInPageMain(tabId, clickPublishTimeFilterOpener, []);
      await sleepJitter(1200);
      await executeInPageMain(tabId, clickPublishTimeOption, [optionText]);
      return;
    }
    await sleep(pollInterval);
  }
}

async function scrollAndWaitForPage2(tabId: number): Promise<void> {
  if (autoTaskState.abort) return;
  await sleepJitter(2000);
  if (autoTaskState.abort) return;
  const res = await sessionStore.get([STORAGE_KEYS.searchNotesPages]);
  const pages = res[STORAGE_KEYS.searchNotesPages] || [];
  if (pages.length >= 2) {
    await pushLog(`第二页已自动加载（共${pages.length}页），跳过滚动`);
    return;
  }
  await pushLog('滚动加载第二页…');
  await setStatus('滚动加载第二页…');
  await executeInPageMain(tabId, scrollToLoadMore, []);
  await sleepJitter(2000);
  if (autoTaskState.abort) return;
  await executeInPageMain(tabId, scrollToLoadMore, []);
  await sleepJitter(3000);
  if (autoTaskState.abort) return;
  try {
    const after = await sessionStore.get([STORAGE_KEYS.searchNotesPages]);
    const len = (after[STORAGE_KEYS.searchNotesPages] || []).length;
    if (len < 2) await pushLog('[告警] 第二页未加载（仅 ' + len + ' 页）');
  } catch {}
}

/** 连续 N 轮页面校验，任一轮 block 立即返回；全通过返回 null */
async function runKeywordFetchPageChecks(
  tabId: number,
  isStale: () => boolean,
): Promise<{ block: boolean; reason?: string } | null | false> {
  let passed = 0;
  while (passed < KEYWORD_FETCH_PAGE_CHECK_ROUNDS) {
    if (isStale()) return false;
    const verdict = await executeInPageMain(tabId, pageShouldBlockKeywordFetch, []);
    if (isStale()) return false;
    if (verdict?.block) return verdict;
    passed++;
    await sleep(KEYWORD_FETCH_PAGE_CHECK_INTERVAL_MS);
  }
  return null;
}

async function checkAndSwitchIfNeeded(): Promise<boolean> {
  const mode = await getLoginMode();
  if (mode === 'qrcode') return checkAndSwitchIfNeededQr();
  return checkAndSwitchIfNeededSms();
}

async function checkAndSwitchIfNeededSms(): Promise<boolean> {
  while (true) {
    if (autoTaskState.abort) return false;
    const o = await storage.get([
      STORAGE_KEYS.accountList,
      STORAGE_KEYS.selectedAccountIndex,
      STORAGE_KEYS.accountCollectStats,
    ]);
    const accs: AccountItem[] = (o[STORAGE_KEYS.accountList] || []).map((it: any) => ({
      phone: (it.phone || '').trim(),
      codeUrl: (it.codeUrl || '').trim(),
      maxCollectCount: it.maxCollectCount != null ? parseInt(it.maxCollectCount, 10) : 200,
    }));
    const accIdx = parseInt(o[STORAGE_KEYS.selectedAccountIndex], 10) || 0;
    const stats: AccountCollectStats = o[STORAGE_KEYS.accountCollectStats] || {};

    if (!accs.length || !isAccountExceededToday(accs, stats, accIdx)) return true;

    const todayCount = getAccountTodayCollectCount(stats, accIdx);
    const max = accs[accIdx]?.maxCollectCount != null ? accs[accIdx].maxCollectCount : 200;
    await pushLog(`账号 ${accIdx + 1} 今日已采集 ${todayCount}/${max}，已达上限`);

    if (areAllAccountsExceededToday(accs, stats)) {
      const now = new Date();
      const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0);
      const minLeft = Math.ceil((+next - +now) / 60000);
      const wait = 15;
      const msg = `所有账号今日采集均已达上限，${wait}秒后重新检测（距明日重置约${minLeft}分钟）`;
      await setStatus(msg);
      await pushLog(msg);
      countdown(true, '等待重新检测', wait);
      await sleep(wait * 1000);
      continue;
    }

    const nextIdx = findNextAvailableAccount(accs, stats, accIdx);
    if (nextIdx < 0) {
      await sleep(15000);
      continue;
    }
    await pushLog(`准备切换到账号 ${nextIdx + 1}`);
    const tab = await resolveWorkingTab();
    if (!tab?.id) {
      await pushLog('无法获取标签页，无法切换账号');
      return false;
    }
    const success = await doAutoSwitchAccount(tab.id, nextIdx, accs);
    if (!success) {
      await pushLog('账号切换/登录失败，15秒后重试');
      await sleep(15000);
    }
  }
}

/**
 * QR 模式下的账号切换逻辑：
 *   - 当前 sessionHash 没超额 → 返回 true 继续
 *   - 超额 → 清 cookie + 重扫，重扫后如果仍超额（同一张卡 / 另一张也耗尽）最多 3 次
 *   - 3 次内都超额 → 等 15 秒后重试
 * 注意：重扫得到的新 sessionHash 若是新账号，会在 qr-login.ts 里自动 registerQrSession。
 */
const QR_SWITCH_MAX_ATTEMPTS = 3;

async function checkAndSwitchIfNeededQr(): Promise<boolean> {
  let switchAttempts = 0;
  while (true) {
    if (autoTaskState.abort) return false;

    const [sessions, defaultMax, hash] = await Promise.all([
      getQrSessionStats(),
      getQrLoginDefaultMax(),
      getStoredCurrentSessionHash(),
    ]);

    // 没有当前 sessionHash：可能还未首次扫码登录，由 autoLoginEnabled 分支负责触发扫码
    if (!hash) return true;

    if (!isQrSessionExceededToday(sessions, hash, defaultMax)) return true;

    const today = qrSessionTodayCount(sessions, hash);
    const max = qrSessionMax(sessions, hash, defaultMax);
    const shortHash = hash.slice(0, 8);
    await pushLog(`QR 账号 ${shortHash}… 今日已采集 ${today}/${max}，已达上限`);

    switchAttempts += 1;
    if (switchAttempts > QR_SWITCH_MAX_ATTEMPTS) {
      const wait = 15;
      const msg = `已连续 ${QR_SWITCH_MAX_ATTEMPTS} 次切换仍超额，${wait} 秒后重试`;
      await setStatus(msg);
      await pushLog(msg);
      countdown(true, '等待重新检测', wait);
      await sleep(wait * 1000);
      switchAttempts = 0;
      continue;
    }

    const tab = await resolveWorkingTab();
    if (!tab?.id) {
      await pushLog('无法获取标签页，无法切换账号');
      return false;
    }
    const success = await doAutoSwitchAccountQr(tab.id);
    if (!success) {
      await pushLog('QR 扫码登录失败，15 秒后重试');
      await sleep(15000);
    }
  }
}

async function preFlightKeywordFetch(): Promise<boolean> {
  const tab = await resolveWorkingTab();
  if (!tab?.id) return true;
  const tabUrl = tab.url || '';
  const session = autoTaskState.sessionGen;
  const stale = () => session !== autoTaskState.sessionGen || autoTaskState.abort;

  if (/^chrome-error:\/\//i.test(tabUrl)) {
    await setStatus('当前为浏览器网络错误页，暂不获取关键词任务');
    await pushLog('当前标签页为网络错误页（chrome-error），15 秒后重试');
    countdown(true, '等待网络', 15);
    await sleep(15000);
    return false;
  }
  if (/captcha|website-login/i.test(tabUrl)) {
    await setStatus('当前标签页为安全验证/验证码页（URL）');
    await pushLog('当前标签页 URL 含 captcha/website-login，15 秒后重试');
    countdown(true, '等待验证', 15);
    await sleep(15000);
    return false;
  }
  if (!isXhsLikeHost(tab.url)) return true;

  const verdict = await runKeywordFetchPageChecks(tab.id, stale);
  if (verdict === false) return false;
  if (!verdict || verdict.block === false || (verdict as any).block === undefined) return true;

  if (verdict.block) {
    if (verdict.reason === 'login') {
      const so = await storage.get([STORAGE_KEYS.autoTaskAutoLoginEnabled]);
      if (so[STORAGE_KEYS.autoTaskAutoLoginEnabled] !== true) {
        await setStatus('检测到未登录，未勾选「需要时自动登录」，请手动登录后重试');
        await pushLog('检测到未登录，未勾选「需要时自动登录」，15 秒后重试');
        countdown(true, '等待登录', 15);
        await sleep(15000);
        return false;
      }
      await setStatus('检测到未登录，正在自动登录…');
      await pushLog('检测到未登录，开始自动登录后再获取关键词任务…');
      const ok = await runNavigateThenAutoLogin(tab.id, session);
      if (!ok) {
        await pushLog('自动登录未完成，15 秒后重试');
        countdown(true, '等待登录', 15);
        await sleep(15000);
        return false;
      }
      await pushLog('自动登录成功，继续获取关键词任务');
      return true;
    }
    const reasonText =
      verdict.reason === 'unreachable'
        ? '检测到页面「无法访问此网站」'
        : verdict.reason === 'reload'
          ? '检测到页面含「重新加载」'
          : '当前为安全验证或验证码页';
    await setStatus(reasonText + '，暂不获取关键词任务');
    await pushLog(reasonText + '，15 秒后重试');
    countdown(true, verdict.reason === 'security_verify' ? '等待验证' : '等待网络', 15);
    await sleep(15000);
    return false;
  }
  return true;
}

/**
 * 启动前校验：接口根地址 + 登录态。
 * 不通过时会写入 status / log，并把 autoTaskRunning 置为 false。
 * 返回 true 表示可以继续，false 表示应当直接 return。
 */
async function performPreStartValidation(): Promise<boolean> {
  const host = await getApiHost();
  if (isPlaceholderHost(host)) {
    await setStatus('接口根地址未配置：请先在「接口配置」填入真实后端地址');
    await pushLog('自动任务未启动：接口根地址仍为示例占位（your-api.example）');
    await storage.set({
      [STORAGE_KEYS.autoTaskRunning]: false,
      [STORAGE_KEYS.autoTaskStatus]: '未启动（接口未配置）',
    });
    return false;
  }
  const gate = await storage.get([
    STORAGE_KEYS.xhsLoggedIn,
    STORAGE_KEYS.autoTaskAutoLoginEnabled,
  ]);
  let loggedIn = !!gate[STORAGE_KEYS.xhsLoggedIn];
  const autoLoginOn = !!gate[STORAGE_KEYS.autoTaskAutoLoginEnabled];
  // DOM 二次校验：xhsLoggedIn 来源于 cookie / 上一次 DOM 检测，可能是过期残留。
  // 如果当前有打开的小红书页面，就实时再判一次；只在「确定看到登录入口」时下调结论，
  // 避免误判（页面没渲染就维持旧值）。
  if (loggedIn) {
    try {
      const tabs = await chrome.tabs.query({
        url: ['https://www.xiaohongshu.com/*', 'https://www.rednote.com/*'],
      });
      const ready = tabs.find((t) => t.id != null && t.status === 'complete' && !t.discarded);
      if (ready?.id != null) {
        const present = await executeInPageMain(ready.id, checkXhsLoginUiPresent, [], 2000);
        if (present === true) {
          loggedIn = false;
          await storage.setOne(STORAGE_KEYS.xhsLoggedIn, false).catch(() => {});
          await pushLog('启动前 DOM 校验：检测到登录入口，判定为未登录');
        }
      }
    } catch {}
  }
  if (!loggedIn && !autoLoginOn) {
    await setStatus('未登录：请先登录，或在自动任务中勾选「需要时自动登录」');
    await pushLog('自动任务未启动：当前未登录');
    await storage.set({
      [STORAGE_KEYS.autoTaskRunning]: false,
      [STORAGE_KEYS.autoTaskStatus]: '未启动（需登录）',
    });
    return false;
  }
  return true;
}

/**
 * 拉取关键词任务并合并到侧栏列表。
 * - 成功：返回 { keywords, taskInfos }
 * - 失败：返回 'retry'（已打印错误日志并等待 15s，调用方应 `continue`）
 * - 空任务：返回 'retry'
 */
async function fetchKeywordsRound(): Promise<
  { keywords: string[]; taskInfos: KeywordTaskInfo[] } | 'retry'
> {
  await setStatus('正在获取任务…');
  await pushLog('正在获取任务…');
  countdown(true, '请求关键词…', 0);
  let result;
  try {
    result = await fetchKeywordTask();
  } catch (err: any) {
    let msg = err?.message || String(err);
    if (msg === 'Failed to fetch') msg = '网络请求失败（请检查接口地址与网络）';
    await sessionStore
      .setOne(STORAGE_KEYS.apiLastProbe, { ok: false, at: Date.now(), error: msg })
      .catch(() => {});
    const text = `获取任务失败: ${msg}，15 秒后重试`;
    await setStatus(text);
    await pushLog(text);
    countdown(true, '请求关键词', 15);
    await sleep(15000);
    return 'retry';
  }
  await sessionStore
    .setOne(STORAGE_KEYS.apiLastProbe, { ok: true, at: Date.now() })
    .catch(() => {});
  const { keywords, taskInfos } = result;
  if (!keywords.length) {
    await setStatus('暂无任务，15 秒后重试');
    await pushLog('暂无任务，15 秒后重试');
    countdown(true, '请求关键词', 15);
    await sleep(15000);
    return 'retry';
  }
  const mergeR = await mergeKeywordTaskResultIntoStorage(result);
  if (mergeR.added > 0) {
    await pushLog(
      `关键词已同步到侧栏列表：新增 ${mergeR.added} 个，跳过重复 ${mergeR.duplicated} 个（接口共 ${mergeR.total} 个）`,
    );
  } else {
    await pushLog(
      `关键词已与侧栏列表对齐：接口 ${mergeR.total} 个，无新增（重复 ${mergeR.duplicated} 个）`,
    );
  }
  return { keywords, taskInfos };
}

/**
 * 在给定 tab 上打开关键词搜索 URL。
 * 返回 'ok' | 'quota'（打开失败且已把当日统计打满） | 'aborted'
 */
async function openKeywordUrl(
  tabId: number,
  keyword: string,
): Promise<'ok' | 'quota'> {
  const url = await buildSearchResultUrlAsync(keyword);
  try {
    await new Promise<void>((resolve, reject) => {
      chrome.tabs.update(tabId, { url }, () => {
        if (chrome.runtime.lastError) reject(chrome.runtime.lastError);
        else resolve();
      });
    });
    return 'ok';
  } catch (e: any) {
    // 打开失败通常是 tab 被关掉 / 跳到了非允许域；按"已达今日上限"处理，结束本轮。
    // 经由 statsBroker 串行写入，与 +1 / reset 互斥，避免被并发覆盖回去。
    await handleStatsOp({ kind: 'sms', op: 'forceQuotaReached' }).catch(() => {});
    await pushLog(`打开搜索页失败：${e?.message || e}，已标记今日暂停采集`);
    return 'quota';
  }
}

/**
 * 「拟人」模式：注入鼠标轨迹 + 逐字键入；超时 30s。
 * 不会跳转 URL，要求当前 tab 已在带搜索框的小红书页（外层 ensureOnSearchablePage）。
 *
 * 注：runHumanSearch 返回 Promise<boolean>，chrome.scripting.executeScript 会 await 后
 * 把 resolved value 放到 result 里；TS 推断不出来这一层，需要 cast。
 */
async function openKeywordByHuman(tabId: number, keyword: string): Promise<'ok' | 'fail'> {
  const ok = (await executeInPageMain(tabId, runHumanSearch, [keyword], 30000)) as
    | boolean
    | undefined;
  return ok ? 'ok' : 'fail';
}

/** 「速填」模式：原生 setter + Enter；几十 ms 完成。 */
async function openKeywordByQuick(tabId: number, keyword: string): Promise<'ok' | 'fail'> {
  const ok = (await executeInPageMain(tabId, searchByInputInPage, [keyword], 8000)) as
    | boolean
    | undefined;
  return ok ? 'ok' : 'fail';
}

/**
 * 模式分发 + 失败回退。
 * 三种模式都会先把上一关键词的 pages 数据清掉，保证下游 isolate 拼装的 pages 干净。
 *
 * 回退策略（按 SEARCH_TRIGGER_MODE_PRIORITY）：
 *   - prefer = url   → ['url']                 // 直跳本身就是兜底
 *   - prefer = human → ['human', 'url']
 *   - prefer = quick → ['quick', 'url']
 *
 * 「成功」的判定：
 *   - URL 模式：chrome.tabs.update 成功 + waitForTabComplete + 等到首页响应（或超时也算 ok，
 *     因为 URL 模式下页面已经加载，下游 fetch 拦截还会兜住）
 *   - 拟人 / 速填：注入函数返回 true + 等到首页响应；任一不满足视为失败并降级
 */
export async function runSearchTriggerWithFallback(
  tabId: number,
  keyword: string,
  prefer: SearchTriggerMode,
  isAborted: () => boolean,
): Promise<'ok' | 'quota' | 'aborted'> {
  // 共享前置：清空上一关键词残留 pages（SPA 模式下 isolate.ts 顶部那段不会再触发）
  await sessionStore.remove([STORAGE_KEYS.searchNotesPages, STORAGE_KEYS.searchNotesResult]);
  // 同时清掉上一轮关键词遗留的 hit 缓存，避免跨关键词误命中
  recentFirstPageHits.clear();

  const order: SearchTriggerMode[] =
    prefer === 'url' ? ['url'] : prefer === 'human' ? ['human', 'url'] : ['quick', 'url'];

  for (let i = 0; i < order.length; i++) {
    if (isAborted()) return 'aborted';
    const mode = order[i];
    const label = SEARCH_TRIGGER_MODE_LABEL[mode];

    if (mode === 'url') {
      const r = await openKeywordUrl(tabId, keyword);
      if (r === 'quota') return 'quota';
      if (isAborted()) return 'aborted';
      // 等页面加载完成；URL 模式重要的前置保证（content script 重新装 hook）
      await waitForTabComplete(tabId);
      if (isAborted()) return 'aborted';
      // 再等首页信号（兜底超时 12s，超时也算 ok：URL 模式下 fetch 拦截一般已触发）
      const hit = await awaitSearchFirstPage(keyword, 12000);
      if (!hit) {
        await pushLog(`【${label}】未在 12s 内收到首页响应（页面可能已渲染但未触发 search/notes，继续）`);
      }
      return 'ok';
    }

    // SPA 模式：先确保页面可搜索
    const onPage = await ensureOnSearchablePage(tabId);
    if (!onPage) {
      await pushLog(`【${label}】无法定位到可搜索页，回退`);
      continue;
    }
    if (isAborted()) return 'aborted';
    const triggered =
      mode === 'human'
        ? await openKeywordByHuman(tabId, keyword)
        : await openKeywordByQuick(tabId, keyword);
    if (triggered !== 'ok') {
      await pushLog(`【${label}】触发失败（未找到搜索框或注入异常），回退`);
      continue;
    }
    if (isAborted()) return 'aborted';
    const timeoutMs = mode === 'human' ? 25000 : 12000;
    const hit = await awaitSearchFirstPage(keyword, timeoutMs);
    if (hit) return 'ok';
    await pushLog(`【${label}】触发后 ${Math.round(timeoutMs / 1000)}s 内未收到首页响应，回退`);
  }
  // 所有模式都失败 → 也返回 ok 让 loop 继续，避免一个关键词卡死整轮
  return 'ok';
}

/**
 * 词与词之间的随机等待；带页面倒计时浮层。
 * - stale() 返回 true 时立刻结束等待（抛弃当前会话）
 * - 设置 countdownTimer / waitTimer 到 autoTaskState 上，abort 时可清理
 * - 若等待时间较长（> LONG_WAIT_MS），同时会 chrome.alarms 作为唤醒兜底，
 *   这样即使 SW 被 Chrome 回收，到期也会重新启动恢复执行（见 onAlarm 监听）。
 */
const LONG_WAIT_MS = 25_000;

async function waitBetweenKeywords(
  stale: () => boolean,
  resumeCtx: { sessionGen: number; keywords: string[]; taskInfos: KeywordTaskInfo[]; nextIndex: number },
): Promise<void> {
  const ms = await getRandomIntervalMs();
  const sec = Math.ceil(ms / 1000);
  await setStatus(`等待下一词 · ${sec} 秒`);
  await pushLog(`等待下一词 · ${sec} 秒`);
  countdown(true, '请求关键词', sec);

  // 长等待：预先保存恢复点 + 设置 alarm，保证 SW 被回收时仍能唤醒
  const isLong = ms >= LONG_WAIT_MS;
  if (isLong) {
    await saveResumeState(resumeCtx);
    try {
      // delayInMinutes 最小 1 分钟（MV3 限制，实际 Chrome 对非 persistent SW 也可接受更短值，
      // 但为保证兼容，我们在 ms/60000 与 1 分钟间取最大值）
      await chrome.alarms.create(ALARM_NAMES.autoTaskResume, {
        delayInMinutes: Math.max(ms / 60_000, 1 / 60),
      });
    } catch {}
  }

  let remain = sec;
  // 初始写一次，供顶栏立刻显示
  storage.setOne(STORAGE_KEYS.countdownRemainSec, remain).catch(() => {});
  autoTaskState.countdownTimer = setInterval(() => {
    if (stale() || autoTaskState.abort) {
      if (autoTaskState.countdownTimer) clearInterval(autoTaskState.countdownTimer);
      autoTaskState.countdownTimer = null;
      storage.setOne(STORAGE_KEYS.countdownRemainSec, 0).catch(() => {});
      return;
    }
    remain--;
    if (remain <= 0) {
      if (autoTaskState.countdownTimer) clearInterval(autoTaskState.countdownTimer);
      autoTaskState.countdownTimer = null;
      storage.setOne(STORAGE_KEYS.countdownRemainSec, 0).catch(() => {});
      return;
    }
    setStatus(`等待下一词 · ${remain} 秒`);
    countdown(true, '请求关键词', remain);
    storage.setOne(STORAGE_KEYS.countdownRemainSec, remain).catch(() => {});
  }, 1000) as unknown as number;

  await new Promise<void>((resolve) => {
    autoTaskState.waitTimer = setTimeout(() => {
      autoTaskState.waitTimer = null;
      if (autoTaskState.countdownTimer) {
        clearInterval(autoTaskState.countdownTimer);
        autoTaskState.countdownTimer = null;
      }
      // 避免因 interval 与时钟未对齐而把 countdownRemainSec 留在非零
      storage.setOne(STORAGE_KEYS.countdownRemainSec, 0).catch(() => {});
      resolve();
    }, ms) as unknown as number;
  });

  if (isLong) {
    // setTimeout 走完说明 SW 一直在线，alarm 已不需要；清理掉避免后续误触
    await clearResumeState();
  }
}

/**
 * 启动自动任务主循环。
 *
 * @param opts.resumeFrom 若存在，则跳过首轮的关键词拉取，直接从保存点继续执行
 *                        （用于 SW 被回收后 alarm 唤醒的场景）
 */
export async function startAutoTaskLoop(opts?: {
  resumeFrom?: { keywords: string[]; taskInfos: KeywordTaskInfo[]; nextIndex: number };
}): Promise<void> {
  clearScheduledTimers();
  autoTaskState.sessionGen++;
  const session = autoTaskState.sessionGen;
  autoTaskState.running = true;
  autoTaskState.abort = false;

  if (!(await performPreStartValidation())) {
    autoTaskState.running = false;
    return;
  }

  await ensureAccountListHydrated().catch(() => {});

  // 清理过期的历史统计数据，避免 storage 无限膨胀。
  // accountCollectStats 走 broker 串行队列（与 +1 / reset 互斥），其余 key 直写即可。
  await Promise.all([
    runStorageGC().catch(() => {}),
    handleStatsOp({ kind: 'sms', op: 'pruneOldDays', keepDays: 7 }).catch(() => {}),
  ]);

  // 记录本次 session 起始时间；resume 场景不覆盖，维持原起始点以便"本次已运行"计时连续
  if (!opts?.resumeFrom) {
    await storage.setOne(STORAGE_KEYS.autoTaskSessionStartAt, Date.now()).catch(() => {});
  }

  const stale = () => session !== autoTaskState.sessionGen;
  const finishAll = async () => {
    autoTaskState.running = false;
    autoTaskState.countdownTimer = null;
    autoTaskState.waitTimer = null;
    await pushLog('已关闭');
    countdown(false);
    await storage.set({
      [STORAGE_KEYS.autoTaskRunning]: false,
      [STORAGE_KEYS.autoTaskStatus]: '已关闭',
      [STORAGE_KEYS.countdownRemainSec]: 0,
      [STORAGE_KEYS.autoTaskSessionStartAt]: 0,
    });
    await sessionStore.remove(STORAGE_KEYS.currentKeywordTask);
    await clearResumeState();
    autoTaskState.workingTabId = null;
  };

  // 首轮可能是 resume：跳过关键词拉取 / 账号检查 / preflight，直接进入关键词迭代。
  let resume = opts?.resumeFrom ?? null;
  if (resume) {
    await pushLog(`已从恢复点继续（剩余 ${Math.max(0, resume.keywords.length - resume.nextIndex)} 个关键词）`);
  }

  while (true) {
    if (stale()) return;
    if (autoTaskState.abort) {
      await finishAll();
      return;
    }

    const dayPruned = await maybeRunDailyBusinessPrune().catch(() => false);
    if (dayPruned) {
      await pushLog(
        '新日历日：已清理临时采集数据（session）、已执行关键词列表与关键词任务缓存，并作废跨日恢复点',
      ).catch(() => {});
    }

    // ---------- 可执行时间范围检查（含 resume / alarm 唤醒：首轮必须与常规循环一致）----------
    // 多段窗口：例如 [10:00-13:00, 14:00-21:00]。任一段命中即视为「在窗口内」；
    // 不在窗口内时，nextChangeMinutes 指向「下一个段的 start」。
    const timeRanges = await readAllowedTimeRanges();
    const rangesLabel = formatAllowedTimeRanges(timeRanges);
    const { inRange, nextChangeMinutes } = isInAllowedTimeRanges(timeRanges);
    if (!inRange) {
      const waitMin = Math.max(nextChangeMinutes, 1);
      const firstMsg = `当前不在可执行时间（${rangesLabel}），${waitMin}分钟后重新检测`;
      await setStatus(firstMsg);
      await pushLog(firstMsg);
      await storage.setOne(STORAGE_KEYS.countdownRemainSec, 0).catch(() => {});
      // 页内倒计时与 isolation 同源：必须用「小段」秒数（每段≤60）与本次 sleep(slice) 对齐，
      // 不可用「距下次开窗还有 N 秒」一整段传给页面，否则会与后台提前检测到进窗脱节。
      // 侧栏 countdownRemainSec 仍只用于关键词间隔，此处不写 storage。
      const deadline = Date.now() + waitMin * 60 * 1000;
      // MV3 SW 在长等待中会被 Chrome 回收：必须用 alarm 在 deadline 前唤醒，
      // 否则在 0 点等空闲时段 SW 一旦消失，整个非工作时间等待会无声断流。
      // 注意：alarm 周期必须封顶到 1 分钟，否则像 17:15-17:15 这种短窗口 + 漫长 waitMin（如 1005min）
      // 会让 SW 被回收后死等到第二天才唤醒，期间用户改 ranges 完全没人理。
      // 注：clearResumeState / waitBetweenKeywords / runDailyBusinessDataPrune 都会
      // 通过同名 alarm 进行覆盖或清理，所以这里只需 create 一次即可。
      const alarmDelayMin = Math.max(Math.min(waitMin, 1), 1 / 60);
      try {
        await chrome.alarms.create(ALARM_NAMES.autoTaskResume, {
          delayInMinutes: alarmDelayMin,
        });
      } catch {}
      // 上次写入的 status 文案 / ranges 序列化，用来跳过"没变化"的写入，减少 storage 噪声
      let lastWaitMsg = firstMsg;
      let lastRangesLabel = rangesLabel;
      while (Date.now() < deadline) {
        if (stale() || autoTaskState.abort) break;
        // 用户可能在等待期间编辑了区间配置，每次都重读最新值，避免按"过期 snapshot"等待
        const againRanges = await readAllowedTimeRanges();
        const again = isInAllowedTimeRanges(againRanges);
        if (again.inRange) break;
        // 每次重检都刷新 status：让用户能在面板看到 "剩余 X 分钟" 实时减少，
        // 同时如果用户改了 ranges 文案，也能立即在状态条体现。
        const remainMin = Math.max(1, again.nextChangeMinutes);
        const curLabel = formatAllowedTimeRanges(againRanges);
        const curMsg = `当前不在可执行时间（${curLabel}），${remainMin}分钟后重新检测`;
        if (curMsg !== lastWaitMsg) {
          await setStatus(curMsg).catch(() => {});
          if (curLabel !== lastRangesLabel) {
            // ranges 文案真的变了才写日志，避免每 5s 刷一条
            await pushLog(`配置已更新：${curMsg}`).catch(() => {});
          }
          lastWaitMsg = curMsg;
          lastRangesLabel = curLabel;
        }
        // 15s 一片：SW 活着时每 15s 主动重检一次；SW 被回收时靠 alarm 唤醒。
        // 同时 race 上 allowedTimeRanges 的变化信号 —— 用户改配置后几乎 0 延迟感知，
        // 因此 15s 仅作为「兜底节流频率」，不会拖慢配置变化的响应时间。
        const slice = Math.min(15_000, Math.max(0, deadline - Date.now()));
        if (slice <= 0) break;
        const sliceSec = Math.max(1, Math.ceil(slice / 1000));
        countdown(true, '等待可执行时间 · 读秒检测', sliceSec);
        await Promise.race([sleep(slice), nextAllowedRangesChangedPromise()]);
      }
      countdown(false);
      await storage.setOne(STORAGE_KEYS.countdownRemainSec, 0).catch(() => {});
      // 等待已被打断（abort / 进窗 / SW 重启续跑），统一把这个 alarm 清掉，
      // 避免无意义触发；后续 waitBetweenKeywords 会再按需创建新的同名 alarm。
      try {
        await chrome.alarms.clear(ALARM_NAMES.autoTaskResume);
      } catch {}
      if (autoTaskState.abort) {
        await finishAll();
        return;
      }
      // 刚进可执行窗口：把工作标签拉回配置站点（国内/国际）explore，再进入本轮任务
      if (!stale() && isInAllowedTimeRanges(await readAllowedTimeRanges()).inRange) {
        // 已经主动跳了首页，等价于完成了 alarm 唤醒所需的"重注脚本"动作，
        // 防止下面 iter 起始再 ping 一次又跳一次。
        alarmRevivePending = false;
        await navigateWorkingTabToConfiguredExploreHome('已进入工作时间');
      }
      continue;
    }

    // 在工作时间内、刚被 alarm 唤醒：ping 一下工作标签确认 content script 还在；
    // 失败就跳首页强制重注。比无脑跳首页省一次网络加载，比直接盲跑可靠。
    if (alarmRevivePending) {
      alarmRevivePending = false;
      await handleAlarmRevived();
      if (autoTaskState.abort) {
        await finishAll();
        return;
      }
    }

    let keywords: string[];
    let taskInfos: KeywordTaskInfo[];
    let startIndex = 0;
    if (resume) {
      keywords = resume.keywords;
      taskInfos = resume.taskInfos;
      startIndex = Math.max(0, Math.min(resume.nextIndex, keywords.length));
      resume = null; // 仅首轮走 resume 分支
    } else {
      const ok = await checkAndSwitchIfNeeded();
      if (!ok || autoTaskState.abort || stale()) {
        if (!stale()) await finishAll();
        return;
      }

      await sessionStore.remove([STORAGE_KEYS.searchNotesPages, STORAGE_KEYS.searchNotesResult]);
      const proceed = await preFlightKeywordFetch();
      if (stale()) return;
      if (!proceed) continue;
      if (autoTaskState.abort) {
        await finishAll();
        return;
      }

      const round = await fetchKeywordsRound();
      if (stale()) return;
      if (autoTaskState.abort) {
        await finishAll();
        return;
      }
      if (round === 'retry') continue;
      keywords = round.keywords;
      taskInfos = round.taskInfos;
    }

    const tab = await resolveWorkingTab();
    if (!tab?.id) {
      await setStatus('无法获取当前标签页');
      await pushLog('无法获取当前标签页');
      countdown(true, '请求关键词', 5);
      await sleep(5000);
      continue;
    }

    const total = keywords.length;
    for (let index = startIndex; index < total; index++) {
      if (stale()) return;
      if (autoTaskState.abort) {
        await finishAll();
        return;
      }
      // 每个关键词执行前检查是否仍在可执行时间范围，避免跨天时内层循环无感继续
      {
        const ranges = await readAllowedTimeRanges();
        const { inRange } = isInAllowedTimeRanges(ranges);
        if (!inRange) {
          await pushLog(
            `当前不在可执行时间（${formatAllowedTimeRanges(ranges)}），暂停本轮，等待下次时间窗口`,
          );
          countdown(false);
          await storage.setOne(STORAGE_KEYS.countdownRemainSec, 0).catch(() => {});
          break;
        }
      }
      const keyword = resolveSearchKeyword(keywords[index], taskInfos, index);
      if (!keyword) {
        await pushLog(`第 ${index + 1} 个关键词无效，跳过`);
        continue;
      }
      // 已执行（回传成功过）的关键词直接跳过，避免重复采集
      try {
        const ek = await storage.get([STORAGE_KEYS.orderedSearchExecutedKeywords]);
        const executedArr: string[] = Array.isArray(ek[STORAGE_KEYS.orderedSearchExecutedKeywords])
          ? ek[STORAGE_KEYS.orderedSearchExecutedKeywords]
          : [];
        if (executedArr.includes(keyword)) {
          await pushLog(`关键词「${keyword}」已执行过，跳过`);
          continue;
        }
      } catch {}
      // 在每个关键词开始时重读 mode：允许用户在运行中切换，下一关键词生效。
      const mode = await getSearchTriggerMode();
      const modeLabel = SEARCH_TRIGGER_MODE_LABEL[mode];
      const statusPrefix = `[${modeLabel}] 执行中 ${index + 1}/${total}：${keyword}`;
      await setStatus(statusPrefix);
      await pushLog(statusPrefix);
      countdown(true, `执行中 ${index + 1}/${total}`, 0);

      const kwInfo = taskInfos[index] || taskInfos[0] || ({ Keywords: keyword } as KeywordTaskInfo);
      await sessionStore.setOne(STORAGE_KEYS.currentKeywordTask, kwInfo);

      const openRes = await runSearchTriggerWithFallback(
        tab.id!,
        keyword,
        mode,
        () => stale() || autoTaskState.abort,
      );
      if (openRes === 'quota') break;
      if (openRes === 'aborted') {
        if (autoTaskState.abort) {
          await finishAll();
          return;
        }
        return;
      }
      if (stale()) return;
      if (autoTaskState.abort) {
        await finishAll();
        return;
      }
      await sleepJitter(2000);
      if (stale()) return;

      const o = await storage.get([STORAGE_KEYS.publishTimeFilter]);
      const filterVal = (o[STORAGE_KEYS.publishTimeFilter] || '').trim();
      if (filterVal) {
        await setStatus(`${statusPrefix} · 应用筛选「${filterVal}」`);
        await applyPublishTimeFilter(tab.id!, filterVal);
      }
      await scrollAndWaitForPage2(tab.id!);

      await waitBetweenKeywords(stale, {
        sessionGen: session,
        keywords,
        taskInfos,
        nextIndex: index + 1,
      });
    }
  }
}

export function abortAutoTask() {
  autoTaskState.abort = true;
  clearScheduledTimers();
  autoTaskState.sessionGen++;
  countdown(false);
  autoTaskState.workingTabId = null;
  storage.set({
    [STORAGE_KEYS.autoTaskRunning]: false,
    [STORAGE_KEYS.autoTaskStatus]: '已关闭',
    [STORAGE_KEYS.countdownRemainSec]: 0,
    [STORAGE_KEYS.autoTaskSessionStartAt]: 0,
  });
  // 立刻清理恢复点与 alarm，避免 SW 被回收后又被 alarm 唤醒
  clearResumeState().catch(() => {});
}
