<script setup lang="ts">
import { computed, ref, onMounted, onBeforeUnmount, nextTick } from 'vue';
import { useActiveTabUrl } from './composables/useActiveTabUrl';
import { useStorageRef } from './composables/useStorageRef';
import {
  STORAGE_KEYS,
  MSG,
  SEARCH_TRIGGER_MODE_DEFAULT,
  SEARCH_TRIGGER_MODE_LABEL,
  SEARCH_TRIGGER_MODE_DESC,
  ALLOWED_TIME_RANGES_DEFAULT,
  normalizeAllowedTimeRanges,
  type SearchTriggerMode,
  type AllowedTimeRange,
} from '@shared/constants';
import { storage } from '@shared/storage';
import { getNextAllowedChangeSecondsForRanges } from '@shared/time';
import ApiConfigSection from './components/ApiConfigSection.vue';
import AccountSection from './components/AccountSection.vue';
import AccountActions from './components/AccountActions.vue';
import KeywordSection from './components/KeywordSection.vue';
import ManualExecuteSection from './components/ManualExecuteSection.vue';
import AutoTaskSection from './components/AutoTaskSection.vue';
import ExecutionLogSection from './components/ExecutionLogSection.vue';
import NoteTable from './components/NoteTable.vue';
import CreatorTable from './components/CreatorTable.vue';
import CollapsibleStep from './components/CollapsibleStep.vue';
import ImportExportDialog from './components/ImportExportDialog.vue';
import NodeIdentitySection from './components/NodeIdentitySection.vue';
import { accountStore } from './services/accountStore';
import { keywordStore } from './services/keywordStore';
import type { AccountCollectStats } from '@/types/xhs';
import {
  readCachedOutboundIp,
  type OutboundIpInfo,
} from '@shared/nodeIdentity';
import {
  manualOrderedRunning,
  manualOrderedCancelRequested,
} from './state/manualExecuteState';

const { url } = useActiveTabUrl();

const version = computed(() => {
  try {
    return chrome.runtime.getManifest().version;
  } catch {
    return '';
  }
});

const pageType = computed<'search' | 'profile' | 'other'>(() => {
  const u = url.value || '';
  if (u.indexOf('search_result') !== -1) return 'search';
  if (u.indexOf('user/profile') !== -1) return 'profile';
  return 'other';
});

const pageHint = computed(() => {
  if (pageType.value === 'search') return '当前：搜索页 — 显示笔记表格';
  if (pageType.value === 'profile') return '当前：达人主页 — 显示达人列表';
  return '当前：其他页面 — 显示全部';
});

const showSearch = computed(() => pageType.value === 'search' || pageType.value === 'other');
const showCreator = computed(() => pageType.value === 'profile' || pageType.value === 'other');

// ---------- 各阶段状态派生 ----------
const apiHost = useStorageRef<string>(STORAGE_KEYS.apiHost, '');
// 顶栏的「今日采集」仅做只读展示；写入走 background statsBroker。
const accountStats = useStorageRef<AccountCollectStats>(STORAGE_KEYS.accountCollectStats, {}, {
  writeOnSet: false,
});
const xhsLoggedIn = useStorageRef<boolean>(STORAGE_KEYS.xhsLoggedIn, false);
const autoLoginRunning = useStorageRef<boolean>(STORAGE_KEYS.autoLoginRunning, false);
const pluginPaused = useStorageRef<boolean>(STORAGE_KEYS.pluginPaused, false);
const accountList = accountStore.list;
const selectedIdx = accountStore.selectedIdx;
const keywords = keywordStore.list;
const publishTimeFilter = useStorageRef<string>(STORAGE_KEYS.publishTimeFilter, '半年内');
const orderedDelayMinSec = useStorageRef<number>(STORAGE_KEYS.orderedExecuteDelayMinSec, 5);
const orderedDelayMaxSec = useStorageRef<number>(STORAGE_KEYS.orderedExecuteDelayMaxSec, 5);
const taskRunning = useStorageRef<boolean>(STORAGE_KEYS.autoTaskRunning, false);
const taskStatus = useStorageRef<string>(STORAGE_KEYS.autoTaskStatus, '');
const countdownRemainSec = useStorageRef<number>(STORAGE_KEYS.countdownRemainSec, 0);
const autoTaskSessionStartAt = useStorageRef<number>(STORAGE_KEYS.autoTaskSessionStartAt, 0);
const allowedTimeRanges = useStorageRef<AllowedTimeRange[]>(
  STORAGE_KEYS.allowedTimeRanges,
  ALLOWED_TIME_RANGES_DEFAULT,
  { transform: (raw) => {
    const arr = normalizeAllowedTimeRanges(raw);
    return arr.length > 0 ? arr : ALLOWED_TIME_RANGES_DEFAULT.map((r) => ({ ...r }));
  } },
);
const callbackDailyStats = useStorageRef<Record<string, { ok: number; fail: number }>>(
  STORAGE_KEYS.callbackDailyStats,
  {},
);
const apiLastProbe = useStorageRef<{ ok: boolean; at: number; error?: string } | null>(
  STORAGE_KEYS.apiLastProbe,
  null,
  { area: 'session' },
);

// 每秒 tick：用于「运行时长」+「下次工作时间倒计时」+ 其他时间敏感 UI 的动态刷新。
//
// 之前用过条件 tick（仅在任务运行 / out-of-window 时启动），存在两个边界 bug：
//   1) in-window → out-of-window 自然过渡时不会启动（watch 不感知时间流动）；
//   2) out-of-window → in-window 自然过渡时不会停止（同上）。
// 改成生命周期常驻 1s tick：每秒只更新一个 number ref，开销可忽略，逻辑简单。
const nowTick = ref(Date.now());
let tickTimer: ReturnType<typeof setInterval> | null = null;

onMounted(() => {
  accountStore.init();
  keywordStore.init();
  tickTimer = setInterval(() => (nowTick.value = Date.now()), 1000);
});
onBeforeUnmount(() => {
  if (tickTimer) {
    clearInterval(tickTimer);
    tickTimer = null;
  }
});

// 配置：apiHost 设置过即认为完成
const apiStatus = computed<'idle' | 'done'>(() =>
  apiHost.value && apiHost.value.trim() ? 'done' : 'idle',
);
const apiSummary = computed(() => {
  const v = (apiHost.value || '').trim();
  if (!v) return '未配置 API 地址';
  return v.length > 32 ? v.slice(0, 30) + '…' : v;
});

// 账号阶段
const selectedAcc = computed(() => accountList.value[selectedIdx.value]);
const accountStatus = computed<'idle' | 'doing' | 'done' | 'error' | 'warn'>(() => {
  if (autoLoginRunning.value) return 'doing';
  if (xhsLoggedIn.value) return 'done';
  // 账号列表为空时只是"未配置"，保持 idle；有账号却未登录 → 高亮提示
  if (accountList.value.length > 0) return 'warn';
  return 'idle';
});
const accountSummary = computed(() => {
  if (autoLoginRunning.value) return '正在自动登录…';
  if (xhsLoggedIn.value) {
    const phone = selectedAcc.value?.phone || '';
    return phone ? `已登录 · ${phone}` : '已登录';
  }
  if (!accountList.value.length) return '暂无账号';
  return `⚠ 未登录 · 共 ${accountList.value.length} 个账号`;
});

// 折叠态的快捷操作
const accountActions = computed(() => {
  if (xhsLoggedIn.value) {
    return [
      { label: '退出', onClick: triggerAutoLogout, variant: 'danger' as const },
    ];
  }
  if (autoLoginRunning.value) {
    return [{ label: '取消', onClick: cancelAutoLogin, variant: 'danger' as const }];
  }
  return [{ label: '自动登录', onClick: triggerAutoLogin, variant: 'primary' as const }];
});

async function triggerAutoLogin() {
  const acc = accountList.value[selectedIdx.value];
  if (!acc?.phone || !acc?.codeUrl) return;
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tabId = tabs[0]?.id;
  if (!tabId) return;
  try { chrome.runtime.sendMessage({ type: MSG.runNavigateThenAutoLogin, tabId }, () => { void chrome.runtime.lastError; }); } catch {}
}

function cancelAutoLogin() {
  storage.setOne(STORAGE_KEYS.autoLoginRunning, false).catch(() => {});
  try { chrome.runtime.sendMessage({ type: MSG.abortAutoLogin }, () => { void chrome.runtime.lastError; }); } catch {}
}

async function triggerAutoLogout() {
  const cookieDomains = [
    'xiaohongshu.com',
    '.xiaohongshu.com',
    'www.xiaohongshu.com',
    'rednote.com',
    '.rednote.com',
    'www.rednote.com',
  ];
  for (const domain of cookieDomains) {
    const cookies = await new Promise<chrome.cookies.Cookie[]>((resolve) =>
      chrome.cookies.getAll({ domain }, (c) => resolve(c || [])),
    );
    for (const c of cookies) {
      const protocol = c.secure ? 'https://' : 'http://';
      const url = protocol + c.domain.replace(/^\./, '') + c.path;
      await new Promise<void>((resolve) =>
        chrome.cookies.remove({ url, name: c.name }, () => resolve()),
      );
    }
  }
  const origins = [
    'https://xiaohongshu.com',
    'https://www.xiaohongshu.com',
    'https://edith.xiaohongshu.com',
    'https://rednote.com',
    'https://www.rednote.com',
    'https://webapi.rednote.com',
  ];
  try {
    await new Promise<void>((resolve) =>
      chrome.browsingData.remove(
        { origins },
        {
          cacheStorage: true,
          cookies: true,
          fileSystems: true,
          indexedDB: true,
          localStorage: true,
          serviceWorkers: true,
          cache: true,
        },
        () => resolve(),
      ),
    );
  } catch {}
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tab = tabs[0];
  if (tab?.id && tab.url && /(?:xiaohongshu|rednote)\.com/.test(tab.url)) {
    chrome.tabs.reload(tab.id);
  }
  try { chrome.runtime.sendMessage({ type: MSG.syncLoginStatus }, () => { void chrome.runtime.lastError; }); } catch {}
}

// 关键词阶段
const keywordStatus = computed<'idle' | 'done'>(() =>
  keywords.value.length > 0 ? 'done' : 'idle',
);
const keywordSummary = computed(() => {
  if (!keywords.value.length) return '未配置关键词';
  return `共 ${keywords.value.length} 个`;
});

const manualStepStatus = computed<'idle' | 'doing'>(() =>
  manualOrderedRunning.value ? 'doing' : 'idle',
);
const manualSummary = computed(() => {
  if (manualOrderedRunning.value) return '按顺序搜索中…';
  const f = publishTimeFilter.value || '不限';
  const a = orderedDelayMinSec.value;
  const b = orderedDelayMaxSec.value;
  return `间隔 ${a}～${b}s · 筛选 ${f}`;
});

// 任务阶段
const taskStepStatus = computed<'idle' | 'doing'>(() => (taskRunning.value ? 'doing' : 'idle'));
const taskSummary = computed(() => {
  if (taskRunning.value) return taskStatus.value || '执行中…';
  return '未在运行';
});

// ---------- E2 顶部汇总状态条 ----------
// 把"最常看的几个字段"压成一行，折叠所有卡片也能一眼看到。
function todayStr(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const summaryAccount = computed(() => {
  if (autoLoginRunning.value) return { label: '登录中', cls: 'text-amber-600' };
  if (xhsLoggedIn.value) {
    const phone = selectedAcc.value?.phone || '';
    return { label: phone ? `已登录 ${phone}` : '已登录', cls: 'text-green-700' };
  }
  return { label: '未登录', cls: 'text-red-600' };
});

const summaryTask = computed(() => {
  if (pluginPaused.value) return { label: '已暂停', cls: 'text-red-600' };
  if (taskRunning.value) return { label: taskStatus.value || '执行中', cls: 'text-blue-700' };
  if (manualOrderedRunning.value) return { label: '手动顺序中', cls: 'text-blue-700' };
  return { label: '空闲', cls: 'text-slate-500' };
});

const summaryToday = computed(() => {
  const idx = selectedIdx.value;
  const acc = accountList.value[idx];
  if (!acc) return null;
  const day = todayStr();
  const used = accountStats.value?.[String(idx)]?.[day] || 0;
  const max = acc.maxCollectCount != null ? acc.maxCollectCount : 200;
  const pct = max > 0 ? Math.min(100, Math.round((used / max) * 100)) : 0;
  return { used, max, pct };
});

// 下一词倒计时：只在 > 0 时显示；等任务结束会被清 0
const summaryCountdown = computed(() => {
  const s = Number(countdownRemainSec.value) || 0;
  if (s <= 0) return null;
  return { sec: s, label: `${s}s` };
});

// 今日回传统计：只在今天有数据时显示
const summaryCallback = computed(() => {
  const day = todayStr();
  const b = callbackDailyStats.value?.[day];
  if (!b || (!b.ok && !b.fail)) return null;
  return { ok: b.ok || 0, fail: b.fail || 0 };
});

// 搜索触发方式（直跳 / 拟人 / 速填）—— 状态条右侧徽章 + 点击展开 Section 0 配置
const searchTriggerMode = useStorageRef<SearchTriggerMode>(
  STORAGE_KEYS.searchTriggerMode,
  SEARCH_TRIGGER_MODE_DEFAULT,
);
const summaryMode = computed(() => {
  const m = searchTriggerMode.value;
  const label = SEARCH_TRIGGER_MODE_LABEL[m];
  const tip = SEARCH_TRIGGER_MODE_DESC[m];
  // 不同模式不同颜色：直跳=中性、拟人=琥珀(慢)、速填=蓝(中)
  const cls =
    m === 'human'
      ? 'text-amber-600'
      : m === 'quick'
        ? 'text-blue-700'
        : 'text-slate-700';
  return { label, tip, cls };
});

// 配置 Section 的 ref，供徽章点击时强制展开 + 滚动定位
const apiConfigStepRef = ref<{ expand: () => void } | null>(null);
function jumpToModeConfig() {
  const el = apiConfigStepRef.value;
  if (el?.expand) el.expand();
  nextTick(() => {
    try {
      const root = document.querySelector('section[data-step="0"]') as HTMLElement | null;
      if (root) root.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch {}
  });
}

// API 探针：默认灰（未知）；apiHost 为占位 → 红；近 10 分钟内有成功 → 绿；失败或超时未更新 → 红
const summaryApi = computed<{ cls: string; tip: string; label: string }>(() => {
  if (!apiHost.value || /your-api\.example/i.test(apiHost.value)) {
    return { cls: 'bg-red-500', tip: 'API 根地址未配置', label: '未配置' };
  }
  const p = apiLastProbe.value;
  if (!p) {
    return { cls: 'bg-slate-300', tip: 'API 尚未探测，启动任务或「从接口获取」后更新', label: '未探测' };
  }
  if (p.ok) return { cls: 'bg-green-500', tip: `API 连通 · ${new Date(p.at).toLocaleTimeString('zh-CN', { hour12: false })}`, label: '连通' };
  return {
    cls: 'bg-red-500',
    tip: `API 最近失败：${p.error || '未知'} · ${new Date(p.at).toLocaleTimeString('zh-CN', { hour12: false })}`,
    label: '失败',
  };
});

// 本次运行时长：自动任务基于 autoTaskSessionStartAt；手动顺序搜索暂不计时（时间短）
function formatDurationShort(ms: number): string {
  if (ms <= 0) return '';
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
  if (m > 0) return `${m}m ${String(sec).padStart(2, '0')}s`;
  return `${sec}s`;
}
const summaryUptime = computed(() => {
  if (!taskRunning.value) return null;
  const start = autoTaskSessionStartAt.value || 0;
  if (!start) return null;
  void nowTick.value;
  return formatDurationShort(Date.now() - start);
});

// 下次工作窗口倒计时：仅在「当前不在允许时间」时显示一个小卡片。
// 显示「距开工 hh:mm:ss」，与 background 主循环里的 alarm 唤醒互为冗余但更直观。
function formatHms(totalSec: number): string {
  if (totalSec <= 0) return '0:00:00';
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

const nextWorkCard = computed(() => {
  void nowTick.value;
  const ranges = allowedTimeRanges.value || [];
  const r = getNextAllowedChangeSecondsForRanges(ranges);
  if (r.inRange) return null;
  // 多段：把每段 start-end 拼成 "10:00-13:00 / 14:00-21:00" 形式展示
  const label = ranges
    .map((x) => `${x.start || ''}-${x.end || ''}`)
    .filter((x) => x !== '-')
    .join(' / ');
  return {
    rangesLabel: label,
    label: formatHms(Math.max(0, r.nextChangeSeconds)),
  };
});

// ---------- 节点身份摘要（折叠态显示用） ----------
// 真正的取数 / UI 在 NodeIdentitySection.vue 内；这里仅订阅几个关键字段，
// 折叠时也能一眼看到「别名 · IP · 已运行时长」。
const nodeAlias = useStorageRef<string>(STORAGE_KEYS.nodeAlias, '');
const nodeHostname = useStorageRef<string>(STORAGE_KEYS.nodeHostname, '');
const nodeLanIpV4 = useStorageRef<string>(STORAGE_KEYS.nodeLanIpV4, '');
const nodeStartupAt = useStorageRef<number>(STORAGE_KEYS.nodeStartupAt, 0);
const outboundIpCache = useStorageRef<OutboundIpInfo | null>(
  STORAGE_KEYS.outboundIpCache,
  null,
);
// nodeId 仅展示用，挂载时读一次即可，不需要长连订阅
const nodeIdShort = ref<string>('');
onMounted(async () => {
  try {
    const cached = await readCachedOutboundIp();
    if (cached) outboundIpCache.value = cached;
  } catch {}
  try {
    const o = await chrome.storage.local.get([STORAGE_KEYS.nodeId]);
    const v = o[STORAGE_KEYS.nodeId];
    if (typeof v === 'string' && v) {
      nodeIdShort.value = v.slice(0, 8);
    }
  } catch {}
});

const summaryNode = computed(() => {
  void nowTick.value;
  const parts: string[] = [];
  // 1. 业务标签优先：alias / hostname / nodeId 短码
  const alias = (nodeAlias.value || '').trim();
  const hostname = (nodeHostname.value || '').trim();
  if (alias) parts.push(alias);
  else if (hostname) parts.push(hostname);
  else if (nodeIdShort.value) parts.push(`#${nodeIdShort.value}`);
  // 2. 网络标识：内网 IP 优先（群控里更有定位价值），其次出口 IP
  const lan = (nodeLanIpV4.value || '').trim();
  if (lan) {
    parts.push(lan);
  } else {
    const out = outboundIpCache.value;
    if (out?.ok && out.ip) parts.push(out.ip);
  }
  // 3. 已运行时长
  if (nodeStartupAt.value > 0) {
    const ms = Math.max(0, Date.now() - nodeStartupAt.value);
    parts.push(formatDurationShort(ms));
  }
  return parts.length ? parts.join(' · ') : '未识别';
});

const nodeStepStatus = computed<'idle' | 'done' | 'warn'>(() => {
  // 节点身份完整度：
  // - 没 nodeId → idle
  // - 有 nodeId 但没 alias/hostname、也没 lanIp → warn（群控信息不齐）
  // - alias/hostname 任填其一 + lanIp 任填 → done
  if (!nodeIdShort.value) return 'idle';
  const hasLabel = !!(nodeAlias.value || '').trim() || !!(nodeHostname.value || '').trim();
  const hasLan = !!(nodeLanIpV4.value || '').trim();
  if (hasLabel && hasLan) return 'done';
  return 'warn';
});

// 轻量 toast
const toast = ref<{ msg: string; type: 'info' | 'error' } | null>(null);

// 导入导出弹窗
const showImportExportDialog = ref(false);
let toastTimer: ReturnType<typeof setTimeout> | null = null;
function showToast(msg: string, type: 'info' | 'error' = 'info', duration = 5000) {
  toast.value = { msg, type };
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (toast.value = null), duration);
}

// 是否有任何动作正在执行（用于控制全局「停止」按钮的可用状态）
const anyActionRunning = computed(
  () => autoLoginRunning.value || taskRunning.value || manualOrderedRunning.value,
);

// 暂停 / 恢复插件：点停止 → 先取消当前动作，再进入暂停态；点恢复 → 仅清暂停标志
function togglePause() {
  if (pluginPaused.value) {
    // 恢复：不自动重启任何任务，只清标志
    pluginPaused.value = false;
    try {
      chrome.runtime.sendMessage({ type: MSG.setPluginPaused, paused: false }, () => {
        void chrome.runtime.lastError;
      });
    } catch {}
    showToast('插件已恢复');
    return;
  }
  // 暂停：先中止前台三类动作，再通知 background 落盘
  if (manualOrderedRunning.value) manualOrderedCancelRequested.value = true;
  try {
    chrome.runtime.sendMessage({ type: MSG.setPluginPaused, paused: true }, () => {
      void chrome.runtime.lastError;
    });
  } catch {}
  // 前台立即写标志，UI 无需等 background 回包
  pluginPaused.value = true;
  showToast('插件已暂停，所有自动动作停止');
}

function reloadExtension() {
  showToast('扩展即将重载，请稍后手动刷新当前页面以使 content script 生效');
  setTimeout(() => {
    try {
      chrome.runtime.reload();
    } catch (e) {
      console.error('[reload] 失败', e);
      showToast('重载失败，请到 chrome://extensions 手动重载', 'error');
    }
  }, 1200);
}
</script>

<template>
  <main class="min-h-screen p-4 text-sm bg-slate-50">
    <header class="sticky top-0 z-40 -mx-4 -mt-4 mb-4 px-4 py-3 flex items-center justify-between border-b border-slate-200 bg-slate-50/95 backdrop-blur supports-[backdrop-filter]:bg-slate-50/80">
      <div class="flex items-center gap-2">
        <span class="w-2.5 h-2.5 rounded-full bg-brand"></span>
        <span class="text-[15px] font-semibold text-slate-700">XhsDataCrawler</span>
        <span
          v-if="version"
          class="text-[11px] text-slate-400 font-mono px-1.5 py-0.5 rounded bg-slate-100"
          :title="`当前扩展版本 v${version}`"
        >v{{ version }}</span>
      </div>
      <div class="flex items-center gap-1">
        <button
          type="button"
          class="p-1.5 rounded text-slate-400 hover:text-brand hover:bg-slate-100 transition-colors"
          title="导入/导出配置"
          @click="showImportExportDialog = true"
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24"
               fill="none" stroke="currentColor" stroke-width="2"
               stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="m21 16-4 4-4-4"/>
            <path d="M17 20V4"/>
            <path d="m3 8 4-4 4 4"/>
            <path d="M7 4v16"/>
          </svg>
        </button>
        <button
          type="button"
          class="p-1.5 rounded transition-colors"
          :class="pluginPaused
            ? 'text-green-600 hover:bg-green-50'
            : 'text-red-500 hover:bg-red-50'"
          :title="pluginPaused
            ? '恢复插件'
            : '停止所有动作'"
          @click="togglePause"
        >
          <svg
            v-if="!pluginPaused"
            xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24"
            fill="currentColor" stroke="currentColor" stroke-width="1"
            stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"
          >
            <rect x="6" y="6" width="12" height="12" rx="1.5" />
          </svg>
          <svg
            v-else
            xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24"
            fill="currentColor" stroke="none" aria-hidden="true"
          >
            <path d="M8 5v14l11-7z" />
          </svg>
        </button>
        <button
          type="button"
          class="p-1.5 rounded text-slate-400 hover:text-brand hover:bg-slate-100 transition-colors"
          title="重载扩展"
          @click="reloadExtension"
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24"
               fill="none" stroke="currentColor" stroke-width="2"
               stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M21 12a9 9 0 1 1-3-6.7"/>
            <path d="M21 4v5h-5"/>
          </svg>
        </button>
      </div>
    </header>

    <!-- E2 顶部汇总状态条：折叠态下也能一眼看到登录态 / 任务状态 / 倒计时 / 回传 / API / 今日 -->
    <div class="sticky top-[49px] z-30 -mx-4 px-4 pt-2 pb-3 bg-slate-50/95 backdrop-blur supports-[backdrop-filter]:bg-slate-50/80 border-b border-slate-200 mb-3 flex items-center gap-3 text-[12px]">
      <div class="flex items-center gap-2.5 w-full px-3 py-1.5 rounded-md border border-slate-200 bg-white overflow-hidden">
        <!-- 账号 -->
        <div class="flex items-center gap-1 min-w-0 shrink-[2]">
          <span class="text-slate-400">账号:</span>
          <span class="truncate font-medium" :class="summaryAccount.cls">{{ summaryAccount.label }}</span>
        </div>

        <div class="w-px h-3 bg-slate-200 shrink-0"></div>

        <!-- 任务 -->
        <div class="flex items-center gap-1 min-w-0 flex-1">
          <span class="text-slate-400 shrink-0">任务:</span>
          <span class="truncate" :class="summaryTask.cls" :title="summaryTask.label">{{ summaryTask.label }}</span>
        </div>

        <!-- 倒计时：仅当有等待时显示 -->
        <template v-if="summaryCountdown">
          <div class="w-px h-3 bg-slate-200 shrink-0"></div>
          <div class="flex items-center gap-1 shrink-0" title="下一关键词等待剩余时间">
            <svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24"
              fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
              class="text-amber-500" aria-hidden="true">
              <circle cx="12" cy="12" r="9"/>
              <path d="M12 7v5l3 2"/>
            </svg>
            <span class="font-mono text-amber-600">{{ summaryCountdown.label }}</span>
          </div>
        </template>

        <!-- 运行时长：仅任务运行时显示 -->
        <template v-if="summaryUptime">
          <div class="w-px h-3 bg-slate-200 shrink-0"></div>
          <div class="flex items-center gap-1 shrink-0" title="本次自动任务已运行时长">
            <span class="text-slate-400">运行:</span>
            <span class="font-mono text-slate-700">{{ summaryUptime }}</span>
          </div>
        </template>

        <!-- 今日回传：有数据才显示 -->
        <template v-if="summaryCallback">
          <div class="w-px h-3 bg-slate-200 shrink-0"></div>
          <div class="flex items-center gap-1 shrink-0" :title="`今日回传成功 ${summaryCallback.ok} · 失败 ${summaryCallback.fail}`">
            <span class="text-slate-400">回传:</span>
            <span class="font-mono text-green-700">{{ summaryCallback.ok }}<span class="text-[10px]">✓</span></span>
            <span v-if="summaryCallback.fail > 0" class="font-mono text-red-600">/{{ summaryCallback.fail }}<span class="text-[10px]">✗</span></span>
          </div>
        </template>

        <!-- API 连通性指示：一个圆点 + tooltip -->
        <div class="w-px h-3 bg-slate-200 shrink-0"></div>
        <div class="flex items-center gap-1 shrink-0" :title="summaryApi.tip">
          <span class="text-slate-400">API:</span>
          <span class="w-2 h-2 rounded-full" :class="summaryApi.cls"></span>
        </div>

        <!-- 搜索触发模式：直跳 / 拟人 / 速填；点击展开 Section 0 配置 -->
        <div class="w-px h-3 bg-slate-200 shrink-0"></div>
        <button
          type="button"
          class="flex items-center gap-1 shrink-0 rounded px-1.5 py-0.5 hover:bg-slate-100 transition-colors"
          :title="`搜索触发方式：${summaryMode.tip} · 点击修改`"
          @click="jumpToModeConfig"
        >
          <span class="text-slate-400">模式:</span>
          <span class="font-medium" :class="summaryMode.cls">{{ summaryMode.label }}</span>
        </button>

        <!-- 今日采集配额 -->
        <template v-if="summaryToday">
          <div class="w-px h-3 bg-slate-200 shrink-0"></div>
          <div class="flex items-center gap-1 shrink-0" :title="`今日采集 ${summaryToday.used}/${summaryToday.max}`">
            <span class="text-slate-400">今日:</span>
            <span class="font-mono" :class="summaryToday.pct >= 100 ? 'text-red-600' : summaryToday.pct >= 80 ? 'text-amber-600' : 'text-slate-700'">
              {{ summaryToday.used }}/{{ summaryToday.max }}
            </span>
          </div>
        </template>
      </div>
    </div>

    <!-- 下次工作时间倒计时小卡片：仅当前不在允许时间窗口时显示 -->
    <div
      v-if="nextWorkCard"
      class="flex items-center gap-2 mb-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-[12px] text-amber-800"
      :title="`允许执行时间窗口 ${nextWorkCard.rangesLabel}`"
    >
      <svg
        xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24"
        fill="none" stroke="currentColor" stroke-width="2"
        stroke-linecap="round" stroke-linejoin="round" class="shrink-0" aria-hidden="true"
      >
        <circle cx="12" cy="12" r="9"/>
        <path d="M12 7v5l3 2"/>
      </svg>
      <span class="shrink-0">当前不在工作时间</span>
      <span class="text-amber-600/80 shrink-0">·</span>
      <span class="shrink-0">距开工</span>
      <span class="font-mono font-semibold text-amber-900">{{ nextWorkCard.label }}</span>
      <span class="ml-auto text-amber-700/80 text-[11px] shrink-0 font-mono truncate max-w-[50%]">
        {{ nextWorkCard.rangesLabel }}
      </span>
    </div>

    <!-- 暂停态横幅：跨整个面板顶部，避免误触发新任务 -->
    <div
      v-if="pluginPaused"
      class="flex items-center gap-2 mb-3 rounded-md border border-red-300 bg-red-50 px-3 py-2 text-[13px] text-red-700"
      role="alert"
    >
      <svg
        xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24"
        fill="currentColor" stroke="none" class="shrink-0" aria-hidden="true"
      >
        <rect x="6" y="5" width="4" height="14" rx="1" />
        <rect x="14" y="5" width="4" height="14" rx="1" />
      </svg>
      <div class="flex-1 min-w-0">
        <div class="font-semibold">插件已暂停</div>
        <div class="text-[12px] text-red-700/80">
          所有自动登录 / 自动任务 / 按顺序搜索 / 数据回传均已停止。点右上角「恢复」解除。
        </div>
      </div>
      <button
        type="button"
        class="shrink-0 text-[12px] px-2 py-1 rounded border border-green-300 bg-white text-green-700 hover:bg-green-50"
        @click="togglePause"
      >立即恢复</button>
    </div>

    <Transition
      enter-active-class="transition duration-200 ease-out"
      enter-from-class="opacity-0 -translate-y-1"
      enter-to-class="opacity-100 translate-y-0"
      leave-active-class="transition duration-150 ease-in"
      leave-from-class="opacity-100 translate-y-0"
      leave-to-class="opacity-0 -translate-y-1"
    >
      <div
        v-if="toast"
        class="fixed top-3 left-1/2 -translate-x-1/2 z-50 max-w-[90%] px-3 py-2 rounded-md shadow-lg text-[12px] leading-snug border"
        :class="toast.type === 'error'
          ? 'bg-red-50 border-red-200 text-red-700'
          : 'bg-slate-900 border-slate-800 text-white'"
        role="status"
      >
        {{ toast.msg }}
      </div>
    </Transition>

    <CollapsibleStep
      step="·"
      title="节点环境"
      :status="nodeStepStatus"
      :summary="summaryNode"
    >
      <NodeIdentitySection />
    </CollapsibleStep>

    <CollapsibleStep
      ref="apiConfigStepRef"
      step="0"
      title="配置"
      :status="apiStatus"
      :summary="apiSummary"
      data-step="0"
    >
      <ApiConfigSection />
    </CollapsibleStep>

    <CollapsibleStep
      step="1"
      title="账号登录"
      :status="accountStatus"
      :summary="accountSummary"
      :actions="accountActions"
    >
      <AccountSection />
      <AccountActions />
    </CollapsibleStep>

    <CollapsibleStep
      step="2"
      title="关键词"
      :status="keywordStatus"
      :summary="keywordSummary"
    >
      <KeywordSection />
    </CollapsibleStep>

    <CollapsibleStep
      step="3"
      title="手动执行"
      :status="manualStepStatus"
      :summary="manualSummary"
    >
      <ManualExecuteSection />
    </CollapsibleStep>

    <CollapsibleStep
      step="4"
      title="自动任务"
      :status="taskStepStatus"
      :summary="taskSummary"
      disable-auto-collapse
    >
      <AutoTaskSection />
    </CollapsibleStep>

    <CollapsibleStep
      step="5"
      title="执行日志"
      status="idle"
      summary="手动与自动运行记录"
    >
      <ExecutionLogSection />
    </CollapsibleStep>

    <div class="text-[13px] text-slate-500 bg-blue-50 border-l-2 border-brand px-3 py-2 rounded mb-3">
      {{ pageHint }}
    </div>

    <CollapsibleStep
      step="6"
      title="结果数据"
      status="idle"
      :summary="`${pageType === 'search' ? '笔记' : pageType === 'profile' ? '达人' : '全部'}结果`"
      disable-auto-collapse
    >
      <template v-if="showSearch">
        <NoteTable />
      </template>
      <template v-if="showCreator">
        <CreatorTable />
      </template>
    </CollapsibleStep>

    <!-- 导入导出弹窗 -->
    <ImportExportDialog v-if="showImportExportDialog" @close="showImportExportDialog = false" />
  </main>
</template>
