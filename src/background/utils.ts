// background 通用工具：tab 等待、状态广播、storage 读写、cookie 清理

import {
  STORAGE_KEYS,
  MSG,
  normalizeAllowedTimeRanges,
  type AllowedTimeRange,
} from '@shared/constants';
import { storage, sessionStore } from '@shared/storage';
import { getTodayDateStr } from '@shared/time';
import {
  normalizeSearchSiteBaseUrl,
  normalizeAutoLoginPageUrl,
  buildSearchResultUrl,
} from '@shared/url';
import type { AccountItem, AccountCollectStats } from '@/types/xhs';

export function setStatus(text: string): Promise<void> {
  return storage.set({ [STORAGE_KEYS.autoTaskStatus]: text || '' });
}

/**
 * 自动任务日志 ring buffer。
 * - 存在 background 内存里，容量 LOG_BUFFER_MAX；
 * - pushLog 同时会广播 runtime 消息，panel 实时收到不会因 storage 覆盖而丢；
 * - panel 打开时通过 MSG.autoTaskLogHistoryRequest 主动拉一次历史填充。
 */
export interface AutoTaskLogEntry {
  time: number;
  text: string;
}
const LOG_BUFFER_MAX = 200;
const logRing: (AutoTaskLogEntry | null)[] = new Array(LOG_BUFFER_MAX).fill(null);
let logHead = 0;
let logCount = 0;

export function pushLog(text: string): Promise<void> {
  if (!text) return Promise.resolve();
  const entry: AutoTaskLogEntry = { time: Date.now(), text };
  logRing[logHead] = entry;
  logHead = (logHead + 1) % LOG_BUFFER_MAX;
  if (logCount < LOG_BUFFER_MAX) logCount++;
  // 广播（无接收方时 chrome 会报 "Receiving end does not exist"，按静默处理）
  try {
    chrome.runtime.sendMessage({ type: MSG.autoTaskLogEntry, entry }).catch(() => {});
  } catch {}
  // 兼容老行为：依然写入 storage，作为"最后一条"状态，避免影响现有监听方
  return sessionStore.set({
    [STORAGE_KEYS.autoTaskLogLine]: entry,
  });
}

/** 读取当前 ring buffer 的快照（最新在后） */
export function getLogHistory(): AutoTaskLogEntry[] {
  if (logCount === 0) return [];
  const start = logCount < LOG_BUFFER_MAX ? 0 : logHead;
  const result: AutoTaskLogEntry[] = [];
  for (let i = 0; i < logCount; i++) {
    result.push(logRing[(start + i) % LOG_BUFFER_MAX]!);
  }
  return result;
}

/**
 * 向页面浮层发倒计时消息。
 * 优先发到调用方指定的 `tabId`（如自动任务绑定的工作标签页），
 * 若未传则回退到当前激活标签页（兼容老行为）。
 */
export function sendCountdownToPage(
  show: boolean,
  text?: string,
  seconds?: number,
  tabId?: number,
): void {
  const send = (id: number) => {
    // chrome.tabs.sendMessage 在 MV3 下返回 Promise；目标 tab 没有 content script
    // (例如刚切到空白页 / 非 xhs 域 / 注入未完成) 时会 reject 出
    // "Could not establish connection. Receiving end does not exist."
    // 这是预期情况，静默忽略，避免污染未捕获 Promise 日志。
    try {
      const p = chrome.tabs.sendMessage(id, {
        type: MSG.dataCrawlerCountdown,
        show,
        text,
        seconds,
      });
      if (p && typeof (p as any).catch === 'function') {
        (p as Promise<unknown>).catch(() => {});
      }
    } catch {}
  };
  if (typeof tabId === 'number') {
    send(tabId);
  } else {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (!tabs[0] || !tabs[0].id) return;
      send(tabs[0].id);
    });
  }
  // hide 时必须广播所有小红书 Tab：否则会话可能早先绑定的 tabId 已不是前台，
  // 仅发往「当前激活页」将无法停掉 isolation 里的读秒定时器。
  if (!show) broadcastCountdownHide();
}

/** 向所有小红书标签页广播隐藏倒计时，确保不残留 */
function broadcastCountdownHide(): void {
  chrome.tabs.query(
    { url: ['*://*.xiaohongshu.com/*', '*://*.rednote.com/*'] },
    (tabs) => {
      for (const tab of tabs || []) {
        if (tab.id != null) {
          try {
            const p = chrome.tabs.sendMessage(tab.id, {
              type: MSG.dataCrawlerCountdown,
              show: false,
            });
            if (p && typeof (p as any).catch === 'function') {
              (p as Promise<unknown>).catch(() => {});
            }
          } catch {}
        }
      }
    },
  );
}

export function getActiveTab(): Promise<chrome.tabs.Tab | null> {
  return new Promise((resolve) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => resolve(tabs[0] || null));
  });
}

export function waitForTabComplete(tabId: number, timeoutMs = 15000): Promise<void> {
  return new Promise((resolve) => {
    let resolved = false;
    const done = () => {
      if (resolved) return;
      resolved = true;
      chrome.tabs.onUpdated.removeListener(listener);
      clearTimeout(timer);
      resolve();
    };
    const listener = (id: number, info: chrome.tabs.TabChangeInfo) => {
      if (id === tabId && info.status === 'complete') done();
    };
    chrome.tabs.onUpdated.addListener(listener);
    const timer = setTimeout(done, timeoutMs);
  });
}

export async function buildSearchResultUrlAsync(keyword: string): Promise<string> {
  const o = await storage.get([STORAGE_KEYS.searchSiteBase]);
  const base = normalizeSearchSiteBaseUrl(o[STORAGE_KEYS.searchSiteBase]);
  return buildSearchResultUrl(base, keyword);
}

export async function getAutoLoginPageUrl(): Promise<string> {
  const o = await storage.get([STORAGE_KEYS.autoLoginPage]);
  return normalizeAutoLoginPageUrl(o[STORAGE_KEYS.autoLoginPage]);
}

/** 与侧栏「关键词」中「间隔（秒，随机）」一致，供自动任务在词与词之间等待 */
export async function getRandomIntervalMs(): Promise<number> {
  const o = await storage.get([
    STORAGE_KEYS.orderedExecuteDelayMinSec,
    STORAGE_KEYS.orderedExecuteDelayMaxSec,
  ]);
  let minS = 120;
  let maxS = 130;
  if (o[STORAGE_KEYS.orderedExecuteDelayMinSec] != null) {
    minS = Math.max(0, Math.floor(Number(o[STORAGE_KEYS.orderedExecuteDelayMinSec])) || 120);
  }
  if (o[STORAGE_KEYS.orderedExecuteDelayMaxSec] != null) {
    maxS = Math.max(0, Math.floor(Number(o[STORAGE_KEYS.orderedExecuteDelayMaxSec])) || 130);
  }
  if (minS > maxS) [minS, maxS] = [maxS, minS];
  const sec = minS + Math.floor(Math.random() * (maxS - minS + 1));
  return sec * 1000;
}

// ---------- 时间窗口判定 ----------
// 实现下沉到 @shared/time（panel UI 也要复用同一份）；这里仅 re-export 维持调用点不变。
export { isInAllowedTimeRange, isInAllowedTimeRanges } from '@shared/time';

/**
 * 从 storage 中读取当前生效的「可执行时间区间」列表。
 * - 新字段 allowedTimeRanges 存在（含空数组） → 直接采用；空数组表示「不限制」（与 UI 语义一致）
 * - 新字段完全不存在 → 回退到旧字段 allowedTimeStart/End 组成的单段（首次升级兼容）
 * - 旧字段也没有 → 默认 [{ start: '10:00', end: '21:00' }]（保持历史默认行为）
 *
 * 返回值仅用于判定，不写回 storage（迁移由 panel UI 完成）。
 */
export async function readAllowedTimeRanges(): Promise<AllowedTimeRange[]> {
  const o = await storage.get([
    STORAGE_KEYS.allowedTimeRanges,
    STORAGE_KEYS.allowedTimeStart,
    STORAGE_KEYS.allowedTimeEnd,
  ]);
  const newField = o[STORAGE_KEYS.allowedTimeRanges];
  if (Array.isArray(newField)) {
    // 关键：尊重用户「全部删除」=「不限制」的语义，空数组也直接返回，**不**回退到旧字段
    return normalizeAllowedTimeRanges(newField);
  }
  const legacyStart = o[STORAGE_KEYS.allowedTimeStart];
  const legacyEnd = o[STORAGE_KEYS.allowedTimeEnd];
  if (typeof legacyStart === 'string' || typeof legacyEnd === 'string') {
    return [{
      start: typeof legacyStart === 'string' ? legacyStart : '10:00',
      end: typeof legacyEnd === 'string' ? legacyEnd : '21:00',
    }];
  }
  return [{ start: '10:00', end: '21:00' }];
}

/** 把多段区间渲染成形如「10:00-13:00 / 14:00-21:00」的简短中文文案，用于日志 */
export function formatAllowedTimeRanges(ranges: ReadonlyArray<AllowedTimeRange>): string {
  if (!ranges || ranges.length === 0) return '不限制';
  return ranges.map((r) => `${r.start || ''}-${r.end || ''}`).join(' / ');
}

// ---------- 账号采集统计 ----------

export function getAccountTodayCollectCount(stats: AccountCollectStats, idx: number): number {
  const key = String(idx);
  const today = getTodayDateStr();
  if (!stats[key]) return 0;
  return stats[key][today] || 0;
}

export function isAccountExceededToday(
  accs: AccountItem[],
  stats: AccountCollectStats,
  idx: number,
): boolean {
  if (idx < 0 || idx >= accs.length) return true;
  const acc = accs[idx];
  const max = acc.maxCollectCount != null ? acc.maxCollectCount : 200;
  return getAccountTodayCollectCount(stats, idx) >= max;
}

export function areAllAccountsExceededToday(
  accs: AccountItem[],
  stats: AccountCollectStats,
): boolean {
  for (let i = 0; i < accs.length; i++) {
    if (!isAccountExceededToday(accs, stats, i)) return false;
  }
  return true;
}

export function findNextAvailableAccount(
  accs: AccountItem[],
  stats: AccountCollectStats,
  current: number,
): number {
  if (!accs.length) return -1;
  for (let i = 1; i <= accs.length; i++) {
    const next = (current + i) % accs.length;
    if (!isAccountExceededToday(accs, stats, next)) return next;
  }
  return -1;
}

export function clearXhsCookies(): Promise<number> {
  return new Promise((resolve) => {
    const domains = ['.xiaohongshu.com', 'www.xiaohongshu.com', '.rednote.com', 'www.rednote.com'];
    let total = 0;
    let pending = domains.length;
    domains.forEach((domain) => {
      chrome.cookies.getAll({ domain }, (cookies) => {
        if (!cookies?.length) {
          pending--;
          if (pending <= 0) resolve(total);
          return;
        }
        let dp = cookies.length;
        cookies.forEach((cookie) => {
          const protocol = cookie.secure ? 'https://' : 'http://';
          const removeUrl = protocol + cookie.domain.replace(/^\./, '') + cookie.path;
          chrome.cookies.remove({ url: removeUrl, name: cookie.name }, () => {
            total++;
            dp--;
            if (dp <= 0) {
              pending--;
              if (pending <= 0) resolve(total);
            }
          });
        });
      });
    });
  });
}

export function executeInPageMain<T extends (...args: any[]) => any>(
  tabId: number,
  func: T,
  args: Parameters<T> = [] as any,
  timeoutMs: number = 8000,
): Promise<ReturnType<T> | undefined> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v: ReturnType<T> | undefined) => {
      if (settled) return;
      settled = true;
      resolve(v);
    };
    // 兜底超时：避免页面跳转 / iframe 异常导致回调永不触发，整个自动登录卡死
    const timer = setTimeout(() => {
      console.warn('[executeInPageMain] timeout', { tabId, func: (func as any).name });
      done(undefined);
    }, timeoutMs);
    try {
      chrome.scripting.executeScript(
        {
          target: { tabId },
          world: 'MAIN',
          func: func as any,
          args: args as any,
        },
        (results) => {
          clearTimeout(timer);
          if (chrome.runtime.lastError) {
            console.warn('[executeInPageMain] lastError:', chrome.runtime.lastError.message);
            done(undefined);
            return;
          }
          done(results?.[0]?.result as ReturnType<T> | undefined);
        },
      );
    } catch (e) {
      clearTimeout(timer);
      console.warn('[executeInPageMain] throw:', e);
      done(undefined);
    }
  });
}

export function ensureContentScriptReady(tabId: number): Promise<void> {
  return new Promise((resolve) => {
    try {
      chrome.tabs.sendMessage(tabId, { type: MSG.dataCrawlerPing }, (response) => {
        if (chrome.runtime.lastError || !response?.pong) {
          pushLog('content script 未就绪，刷新页面…');
          chrome.tabs.reload(tabId, {}, () => {
            waitForTabComplete(tabId).then(() => setTimeout(resolve, 2000));
          });
        } else {
          resolve();
        }
      });
    } catch {
      chrome.tabs.reload(tabId, {}, () => {
        waitForTabComplete(tabId).then(() => setTimeout(resolve, 2000));
      });
    }
  });
}
