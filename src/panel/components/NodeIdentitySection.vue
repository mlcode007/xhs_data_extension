<script setup lang="ts">
// 节点身份 / 环境信息（100 节点集中管控 · 第一类指标）
// 复用独立采集脚本 src/shared/nodeIdentity.ts，本组件只负责展示 + 触发刷新。
import { computed, onMounted, onBeforeUnmount, ref } from 'vue';
import {
  collectDeviceInfo,
  collectLanInterfaces,
  collectLanIpsFromWebRtc,
  collectManifestInfo,
  collectUaInfo,
  ensureFirstSeenAt,
  ensureNodeId,
  getManualLanIpV4,
  getNodeAlias,
  getNodeHostname,
  getOutboundIp,
  getStartupAt,
  isValidIpv4,
  readCachedOutboundIp,
  setManualLanIpV4,
  setNodeAlias,
  setNodeHostname,
  OUTBOUND_IP_CACHE_TTL_MS,
  type DeviceInfo,
  type IpScope,
  type LanInterface,
  type LanInterfacesResult,
  type ManifestInfo,
  type OutboundIpInfo,
  type UserAgentInfo,
} from '@shared/nodeIdentity';

// ---------- 反应式快照 ----------
const nodeId = ref<string>('');
const aliasInput = ref<string>('');
const aliasSaved = ref<string>('');
const firstSeenAt = ref<number>(0);
const startupAt = ref<number>(0);
const manifestInfo = ref<ManifestInfo | null>(null);
const uaInfo = ref<UserAgentInfo | null>(null);
const deviceInfo = ref<DeviceInfo | null>(null);
const outboundIp = ref<OutboundIpInfo | null>(null);
const ipLoading = ref<boolean>(false);
const showRawUa = ref<boolean>(false);

// 主机名 / 物理位置（用户手填，群控里的「物理定位」字段）
const hostnameInput = ref<string>('');
const hostnameSaved = ref<string>('');

// 内网 IPv4：用户手填的权威值；WebRTC 自动探测仅作建议（autoLanIps）
const manualLanIpInput = ref<string>('');
const manualLanIpSaved = ref<string>('');
const autoLanIps = ref<string[]>([]);
const lanProbeBlockedByMdns = ref<boolean>(false);
const lanProbeLoading = ref<boolean>(false);
const lanProbeRan = ref<boolean>(false);

// ChromeOS 专属：chrome.system.network 返回的网卡列表（桌面 Chrome 永远 supported=false）
const lanInterfacesResult = ref<LanInterfacesResult>({ supported: false, list: [] });
const lanLoading = ref<boolean>(false);
const showAllLan = ref<boolean>(false);

// 每秒 tick 让「已运行时长」「N 分钟前」动态刷新；卸载时清理
const nowTick = ref<number>(Date.now());
let tickTimer: ReturnType<typeof setInterval> | null = null;

// ---------- 加载 ----------
onMounted(async () => {
  manifestInfo.value = collectManifestInfo();
  deviceInfo.value = collectDeviceInfo();
  // UA-CH 高熵 / IP 缓存 / 网卡 / 手填字段并发拉取
  const [id, alias, hostname, manualLan, firstSeen, startup, ua, ipCached, lans] = await Promise.all([
    ensureNodeId(),
    getNodeAlias(),
    getNodeHostname(),
    getManualLanIpV4(),
    ensureFirstSeenAt(),
    getStartupAt(),
    collectUaInfo(),
    readCachedOutboundIp(),
    collectLanInterfaces(),
  ]);
  nodeId.value = id;
  aliasInput.value = alias;
  aliasSaved.value = alias;
  hostnameInput.value = hostname;
  hostnameSaved.value = hostname;
  manualLanIpInput.value = manualLan;
  manualLanIpSaved.value = manualLan;
  firstSeenAt.value = firstSeen;
  startupAt.value = startup;
  uaInfo.value = ua;
  outboundIp.value = ipCached;
  lanInterfacesResult.value = lans;
  tickTimer = setInterval(() => (nowTick.value = Date.now()), 1000);
  // 缓存不存在或已过期 → 后台静默拉一次
  if (!ipCached || Date.now() - (ipCached.at || 0) >= OUTBOUND_IP_CACHE_TTL_MS) {
    void refreshOutboundIp(false);
  }
  // 启动时自动跑一次 WebRTC 内网 IP 探测（约 1s）
  void probeLanIpsByWebRtc();
});

onBeforeUnmount(() => {
  if (tickTimer) {
    clearInterval(tickTimer);
    tickTimer = null;
  }
});

// ---------- 别名 / 主机名 / 内网 IP 手填字段（失焦或回车时落盘） ----------
async function commitAlias() {
  const next = (aliasInput.value || '').trim();
  if (next === aliasSaved.value) return;
  await setNodeAlias(next);
  aliasSaved.value = next;
}

async function commitHostname() {
  const next = (hostnameInput.value || '').trim();
  if (next === hostnameSaved.value) return;
  await setNodeHostname(next);
  hostnameSaved.value = next;
}

async function commitManualLanIp() {
  const next = (manualLanIpInput.value || '').trim();
  if (next === manualLanIpSaved.value) return;
  await setManualLanIpV4(next);
  manualLanIpSaved.value = next;
}

/** 把 WebRTC 自动探测到的 IP 应用到手填输入框（仍需再 blur 才会落盘，避免误覆盖） */
function applyAutoLanIp(ip: string) {
  manualLanIpInput.value = ip;
  void commitManualLanIp();
}

// ---------- WebRTC 探内网 IP ----------
async function probeLanIpsByWebRtc() {
  if (lanProbeLoading.value) return;
  lanProbeLoading.value = true;
  try {
    const r = await collectLanIpsFromWebRtc(1500);
    autoLanIps.value = r.ipv4;
    lanProbeBlockedByMdns.value = r.blockedByMdns;
    // 自动 seed 规则：只看「内网 IP 输入框当前是否为空」。
    // - 输入框为空（首次启动 / 用户主动清空）+ 有推荐值 → 自动填入并落盘
    // - 输入框已有值（storage 旧值 / 用户手填）→ 永不覆盖
    // 注：探测是 async，期间用户可能正在手填，所以这里要再 trim 检查一次最新值。
    const rec = recommendedAutoLanIp.value;
    if (rec && !(manualLanIpInput.value || '').trim()) {
      manualLanIpInput.value = rec;
      await commitManualLanIp();
    }
  } finally {
    lanProbeLoading.value = false;
    lanProbeRan.value = true;
  }
}

// ---------- ChromeOS 网卡刷新 ----------
async function refreshLanInterfaces() {
  if (lanLoading.value) return;
  lanLoading.value = true;
  try {
    lanInterfacesResult.value = await collectLanInterfaces();
  } finally {
    lanLoading.value = false;
  }
}

// ---------- 出口 IP 刷新 ----------
async function refreshOutboundIp(force: boolean) {
  if (ipLoading.value) return;
  ipLoading.value = true;
  try {
    const r = await getOutboundIp({ force });
    outboundIp.value = r;
  } finally {
    ipLoading.value = false;
  }
}

// ---------- 复制 nodeId ----------
const copyState = ref<'idle' | 'ok' | 'err'>('idle');
let copyTimer: ReturnType<typeof setTimeout> | null = null;
async function copyNodeId() {
  try {
    await navigator.clipboard.writeText(nodeId.value);
    copyState.value = 'ok';
  } catch {
    copyState.value = 'err';
  }
  if (copyTimer) clearTimeout(copyTimer);
  copyTimer = setTimeout(() => (copyState.value = 'idle'), 1500);
}

// ---------- 派生展示字段 ----------

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function formatDateTime(ts: number): string {
  if (!ts) return '—';
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(
    d.getHours(),
  )}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

function formatDuration(ms: number): string {
  if (ms <= 0) return '0s';
  const sec = Math.floor(ms / 1000);
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (d > 0) return `${d}d ${pad2(h)}h ${pad2(m)}m`;
  if (h > 0) return `${h}h ${pad2(m)}m ${pad2(s)}s`;
  if (m > 0) return `${m}m ${pad2(s)}s`;
  return `${s}s`;
}

function formatRelative(ts: number): string {
  if (!ts) return '—';
  const diff = Math.max(0, nowTick.value - ts);
  const sec = Math.floor(diff / 1000);
  if (sec < 5) return '刚刚';
  if (sec < 60) return `${sec}s 前`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}min 前`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h ${min % 60}min 前`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h 前`;
}

const shortNodeId = computed(() => {
  const v = nodeId.value || '';
  return v ? `${v.slice(0, 8)}…${v.slice(-4)}` : '—';
});

const uptimeLabel = computed(() => {
  void nowTick.value;
  if (!startupAt.value) return '—';
  return formatDuration(Math.max(0, nowTick.value - startupAt.value));
});

const startupLabel = computed(() => formatDateTime(startupAt.value));
const firstSeenLabel = computed(() => formatDateTime(firstSeenAt.value));

// 浏览器内核 + 版本（基于 UA-CH brands）
const browserKernel = computed(() => {
  const ua = uaInfo.value;
  if (!ua) return '—';
  const list = ua.fullVersionList || ua.brands || [];
  if (!list.length) return ua.raw ? ua.raw.slice(0, 80) : '—';
  // 选「优先看得懂」的：Chrome / Edge / 等真实品牌，排除 'Not_A Brand' / '?' 类垃圾值
  const real = list.find((b) =>
    /chrome|edge|opera|brave|vivaldi|firefox|safari/i.test(b.brand),
  );
  const best = real || list[list.length - 1];
  return `${best.brand} ${best.version}`;
});

// 操作系统：UA-CH 的 platform + platformVersion，缺失时退到 navigatorPlatform
const osLabel = computed(() => {
  const ua = uaInfo.value;
  const platform = ua?.platform || deviceInfo.value?.navigatorPlatform || '';
  const ver = ua?.platformVersion || '';
  if (!platform) return '—';
  return ver ? `${platform} ${ver}` : platform;
});

const archLabel = computed(() => {
  const ua = uaInfo.value;
  if (!ua?.architecture) return '';
  return ua.bitness ? `${ua.architecture}/${ua.bitness}` : ua.architecture;
});

const screenLabel = computed(() => {
  const s = deviceInfo.value?.screen;
  if (!s) return '—';
  const dpr = Number(s.devicePixelRatio || 1);
  return `${s.width}×${s.height} @${dpr}x · ${s.colorDepth}bit`;
});

const timezoneLabel = computed(() => {
  const d = deviceInfo.value;
  if (!d?.timezone) return '—';
  const off = d.timezoneOffsetMin;
  const sign = off >= 0 ? '+' : '-';
  const abs = Math.abs(off);
  const hh = Math.floor(abs / 60);
  const mm = abs % 60;
  const offStr = `UTC${sign}${pad2(hh)}${mm ? `:${pad2(mm)}` : ''}`;
  return `${d.timezone} (${offStr})`;
});

const langLabel = computed(() => {
  const list = deviceInfo.value?.languages || [];
  if (!list.length) return '—';
  return list.slice(0, 3).join(', ') + (list.length > 3 ? ' …' : '');
});

const hardwareLabel = computed(() => {
  const d = deviceInfo.value;
  if (!d) return '—';
  const parts: string[] = [];
  if (d.hardwareConcurrency) parts.push(`${d.hardwareConcurrency} cores`);
  if (d.deviceMemoryGb) parts.push(`~${d.deviceMemoryGb}GB`);
  return parts.length ? parts.join(' · ') : '—';
});

const onlineLabel = computed(() => {
  const d = deviceInfo.value;
  if (!d) return '—';
  return d.online ? '在线' : '离线';
});

// 出口 IP 派生
const ipDisplay = computed(() => outboundIp.value?.ip || '—');
const ipLocation = computed(() => {
  const ip = outboundIp.value;
  if (!ip?.ok) return '';
  const parts = [ip.city, ip.region, ip.country].filter((x) => !!x);
  return parts.join(', ');
});
const ipOrg = computed(() => outboundIp.value?.org || '');
const ipUpdatedLabel = computed(() => {
  const ip = outboundIp.value;
  if (!ip) return '从未拉取';
  void nowTick.value;
  return formatRelative(ip.at);
});
const ipDotClass = computed(() => {
  const ip = outboundIp.value;
  if (ipLoading.value) return 'bg-blue-500 animate-pulse';
  if (!ip) return 'bg-slate-300';
  if (!ip.ok) return 'bg-red-500';
  return 'bg-green-500';
});
const ipErrLabel = computed(() => {
  const ip = outboundIp.value;
  if (!ip || ip.ok) return '';
  return ip.error || 'unknown error';
});

// ---------- 局域网网卡派生 ----------
const SCOPE_LABEL: Record<IpScope, string> = {
  private: '内网',
  public: '公网',
  'link-local': 'link-local',
  loopback: 'loopback',
};
const SCOPE_CLS: Record<IpScope, string> = {
  private: 'bg-green-50 border-green-200 text-green-700',
  public: 'bg-blue-50 border-blue-200 text-blue-700',
  'link-local': 'bg-slate-50 border-slate-200 text-slate-500',
  loopback: 'bg-slate-50 border-slate-200 text-slate-400',
};

/**
 * 折叠态默认展示「真正有用的」：
 * - 包含所有 v4 private（最常用）+ v4 public（直接面向公网的网卡）+ v6 private (ULA)
 * - 不包含 loopback、link-local（噪音）
 * 展开 showAllLan 后显示全集。
 */
const visibleLanInterfaces = computed<LanInterface[]>(() => {
  const list = lanInterfacesResult.value.list;
  if (showAllLan.value) return list;
  return list.filter((x) => x.scope === 'private' || x.scope === 'public');
});

// 折叠态默认隐藏的条目数（link-local / loopback），用于「显示全部」按钮的徽章
const hiddenLanCount = computed<number>(
  () => lanInterfacesResult.value.list.length - visibleLanInterfaces.value.length,
);

// ---------- 手填 IPv4 校验提示 ----------
const manualLanIpHint = computed<'empty' | 'ok' | 'invalid'>(() => {
  const v = (manualLanIpInput.value || '').trim();
  if (!v) return 'empty';
  return isValidIpv4(v) ? 'ok' : 'invalid';
});

// 自动探测的「主推 IP」：优先 192.168 → 10 → 172.16-31 → 其他
function rankIpv4(ip: string): number {
  if (ip.startsWith('192.168.')) return 0;
  if (ip.startsWith('10.')) return 1;
  if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(ip)) return 2;
  return 3;
}
const recommendedAutoLanIp = computed<string>(() => {
  if (!autoLanIps.value.length) return '';
  return autoLanIps.value.slice().sort((a, b) => rankIpv4(a) - rankIpv4(b))[0] || '';
});
</script>

<template>
  <section class="panel-card">
    <!-- 顶部：身份块 -->
    <div class="rounded border border-slate-200 bg-slate-50 px-2.5 py-2 mb-2.5">
      <div class="flex items-center justify-between gap-2 mb-1.5">
        <label class="text-[12px] font-semibold text-slate-600">节点 ID</label>
        <button
          type="button"
          class="text-[11px] px-1.5 py-0.5 rounded border border-slate-200 bg-white text-slate-500 hover:text-brand hover:border-brand transition-colors"
          :title="nodeId"
          @click="copyNodeId"
        >
          <template v-if="copyState === 'ok'">已复制</template>
          <template v-else-if="copyState === 'err'">复制失败</template>
          <template v-else>复制完整 ID</template>
        </button>
      </div>
      <div class="font-mono text-[12px] text-slate-700 truncate" :title="nodeId">
        {{ nodeId || '生成中…' }}
      </div>
      <div class="mt-0.5 text-[10.5px] text-slate-400 font-mono">
        简写：{{ shortNodeId }}
      </div>

      <div class="mt-2 flex items-center gap-2">
        <label class="text-[12px] text-slate-600 shrink-0 w-[3.5rem]">别名</label>
        <input
          v-model="aliasInput"
          type="text"
          maxlength="64"
          placeholder="业务标签，如：node-A03"
          class="input-base flex-1 py-1 px-2 text-[12px]"
          @blur="commitAlias"
          @keydown.enter.prevent="commitAlias"
        />
        <span
          v-if="aliasSaved && aliasInput.trim() === aliasSaved"
          class="text-[10.5px] text-green-600 shrink-0"
          title="已保存"
        >已保存</span>
      </div>

      <div class="mt-1.5 flex items-center gap-2">
        <label class="text-[12px] text-slate-600 shrink-0 w-[3.5rem]" title="便于人工到现场找到这台机器">主机名</label>
        <input
          v-model="hostnameInput"
          type="text"
          maxlength="128"
          placeholder="物理位置，如：上海办公室-3 层-13 工位"
          class="input-base flex-1 py-1 px-2 text-[12px]"
          @blur="commitHostname"
          @keydown.enter.prevent="commitHostname"
        />
        <span
          v-if="hostnameSaved && hostnameInput.trim() === hostnameSaved"
          class="text-[10.5px] text-green-600 shrink-0"
          title="已保存"
        >已保存</span>
      </div>
    </div>

    <!-- 扩展 + 启动时间块 -->
    <div class="grid grid-cols-2 gap-x-3 gap-y-1.5 text-[12px] mb-2.5">
      <div class="col-span-2 text-[11px] font-semibold text-slate-500 uppercase tracking-wide">
        扩展 / 启动
      </div>
      <div class="flex items-baseline gap-1.5 min-w-0">
        <span class="text-slate-400 shrink-0">扩展</span>
        <span class="font-mono text-slate-700 truncate" :title="manifestInfo?.name">
          {{ manifestInfo?.name || '—' }}
        </span>
        <span class="text-slate-500 shrink-0">v{{ manifestInfo?.version || '—' }}</span>
      </div>
      <div class="flex items-baseline gap-1.5 min-w-0">
        <span class="text-slate-400 shrink-0">已运行</span>
        <span class="font-mono text-slate-700 truncate" :title="startupLabel">
          {{ uptimeLabel }}
        </span>
      </div>
      <div class="flex items-baseline gap-1.5 min-w-0">
        <span class="text-slate-400 shrink-0">首次启动</span>
        <span class="font-mono text-slate-700 truncate" :title="firstSeenLabel">
          {{ firstSeenLabel }}
        </span>
      </div>
      <div class="flex items-baseline gap-1.5 min-w-0">
        <span class="text-slate-400 shrink-0">本次启动</span>
        <span class="font-mono text-slate-700 truncate" :title="startupLabel">
          {{ startupLabel }}
        </span>
      </div>
    </div>

    <!-- 浏览器 / OS -->
    <div class="grid grid-cols-2 gap-x-3 gap-y-1.5 text-[12px] mb-2.5">
      <div class="col-span-2 text-[11px] font-semibold text-slate-500 uppercase tracking-wide">
        浏览器 / 操作系统
      </div>
      <div class="flex items-baseline gap-1.5 min-w-0">
        <span class="text-slate-400 shrink-0">内核</span>
        <span class="font-mono text-slate-700 truncate" :title="browserKernel">
          {{ browserKernel }}
        </span>
      </div>
      <div class="flex items-baseline gap-1.5 min-w-0">
        <span class="text-slate-400 shrink-0">系统</span>
        <span class="font-mono text-slate-700 truncate" :title="osLabel">{{ osLabel }}</span>
      </div>
      <div class="flex items-baseline gap-1.5 min-w-0">
        <span class="text-slate-400 shrink-0">架构</span>
        <span class="font-mono text-slate-700 truncate">{{ archLabel || '—' }}</span>
      </div>
      <div class="flex items-baseline gap-1.5 min-w-0">
        <span class="text-slate-400 shrink-0">UA 源</span>
        <span class="font-mono text-slate-700 truncate">
          {{ uaInfo?.source === 'uach' ? 'UA Client Hints' : 'navigator.userAgent' }}
        </span>
      </div>

      <div class="col-span-2 mt-0.5">
        <button
          type="button"
          class="text-[11px] text-slate-400 hover:text-brand transition-colors"
          @click="showRawUa = !showRawUa"
        >
          {{ showRawUa ? '收起' : '展开' }} 原始 User-Agent ▾
        </button>
        <div
          v-if="showRawUa"
          class="mt-1 px-2 py-1.5 rounded border border-slate-200 bg-slate-50 text-[10.5px] text-slate-600 font-mono break-all"
        >
          {{ uaInfo?.raw || '—' }}
        </div>
      </div>
    </div>

    <!-- 设备 / 区域 -->
    <div class="grid grid-cols-2 gap-x-3 gap-y-1.5 text-[12px] mb-2.5">
      <div class="col-span-2 text-[11px] font-semibold text-slate-500 uppercase tracking-wide">
        设备 / 区域
      </div>
      <div class="flex items-baseline gap-1.5 min-w-0">
        <span class="text-slate-400 shrink-0">分辨率</span>
        <span class="font-mono text-slate-700 truncate" :title="screenLabel">{{ screenLabel }}</span>
      </div>
      <div class="flex items-baseline gap-1.5 min-w-0">
        <span class="text-slate-400 shrink-0">硬件</span>
        <span class="font-mono text-slate-700 truncate">{{ hardwareLabel }}</span>
      </div>
      <div class="flex items-baseline gap-1.5 min-w-0">
        <span class="text-slate-400 shrink-0">时区</span>
        <span class="font-mono text-slate-700 truncate" :title="timezoneLabel">{{ timezoneLabel }}</span>
      </div>
      <div class="flex items-baseline gap-1.5 min-w-0">
        <span class="text-slate-400 shrink-0">语言</span>
        <span class="font-mono text-slate-700 truncate" :title="langLabel">{{ langLabel }}</span>
      </div>
      <div class="flex items-baseline gap-1.5 min-w-0 col-span-2">
        <span class="text-slate-400 shrink-0">网络</span>
        <span
          class="inline-flex items-center gap-1 font-mono"
          :class="deviceInfo?.online ? 'text-green-700' : 'text-red-600'"
        >
          <span
            class="w-1.5 h-1.5 rounded-full"
            :class="deviceInfo?.online ? 'bg-green-500' : 'bg-red-500'"
          ></span>
          {{ onlineLabel }}
        </span>
      </div>
    </div>

    <!-- 内网网络 -->
    <div class="rounded border border-slate-200 bg-white px-2.5 py-2 mb-2">
      <div class="flex items-center justify-between gap-2 mb-1.5">
        <div class="flex items-center gap-1.5 text-[11px] font-semibold text-slate-500 uppercase tracking-wide">
          <span
            class="w-1.5 h-1.5 rounded-full"
            :class="manualLanIpHint === 'ok' ? 'bg-green-500'
              : autoLanIps.length ? 'bg-blue-500'
              : lanProbeBlockedByMdns ? 'bg-amber-500'
              : 'bg-slate-300'"
          ></span>
          内网网络（IPv4）
        </div>
        <button
          type="button"
          class="text-[11px] px-1.5 py-0.5 rounded border border-slate-200 bg-white text-slate-500 hover:text-brand hover:border-brand transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          :disabled="lanProbeLoading"
          title="重新通过 WebRTC ICE candidate 探测本机内网 IPv4（VPN 接 / 断时刷新一下）"
          @click="probeLanIpsByWebRtc"
        >
          {{ lanProbeLoading ? '探测中…' : '重新探测' }}
        </button>
      </div>

      <!-- 手填内网 IPv4：群控里的「权威定位 IP」-->
      <div class="flex items-center gap-2 mb-1.5">
        <label class="text-[12px] text-slate-600 shrink-0 w-[3.5rem]" title="群控用此 IP 定位这台机器；自动探测仅作建议">
          内网 IP
        </label>
        <input
          v-model="manualLanIpInput"
          type="text"
          maxlength="64"
          placeholder="如：192.168.1.23（手填以群控可靠定位）"
          class="input-base flex-1 py-1 px-2 text-[12px] font-mono"
          @blur="commitManualLanIp"
          @keydown.enter.prevent="commitManualLanIp"
        />
        <span
          v-if="manualLanIpHint === 'ok' && manualLanIpInput.trim() === manualLanIpSaved"
          class="text-[10.5px] text-green-600 shrink-0"
          title="格式合法 · 已保存"
        >已保存</span>
        <span
          v-else-if="manualLanIpHint === 'invalid'"
          class="text-[10.5px] text-amber-600 shrink-0"
          title="不是标准 IPv4 字面值，但仍会保存（你可能填了主机名 / CIDR）"
        >格式异常</span>
      </div>

      <!-- 自动检测结果 / 提示 -->
      <div class="grid grid-cols-[3.5rem_1fr] gap-x-2 gap-y-1 text-[11.5px] items-baseline">
        <span class="text-slate-400">自动</span>
        <template v-if="lanProbeLoading">
          <span class="text-slate-500">WebRTC 探测中…</span>
        </template>
        <template v-else-if="autoLanIps.length">
          <div class="flex flex-wrap items-center gap-1.5">
            <button
              v-for="ip in autoLanIps"
              :key="ip"
              type="button"
              class="font-mono px-1.5 py-[1px] rounded border text-[11px] leading-none transition-colors"
              :class="ip === recommendedAutoLanIp
                ? 'bg-green-50 border-green-200 text-green-700 hover:bg-green-100'
                : 'bg-slate-50 border-slate-200 text-slate-600 hover:bg-slate-100'"
              :title="ip === manualLanIpInput.trim() ? '已应用为权威值' : `点击应用为内网 IP（${ip}）`"
              @click="applyAutoLanIp(ip)"
            >{{ ip }}<span v-if="ip === recommendedAutoLanIp" class="ml-0.5">·荐</span></button>
            <span class="text-slate-400 text-[10.5px]">点击应用</span>
          </div>
        </template>
        <template v-else-if="lanProbeBlockedByMdns">
          <span class="text-amber-600">
            Chrome mDNS 混淆已拦截 .local，请手填上方「内网 IP」。
          </span>
        </template>
        <template v-else-if="lanProbeRan">
          <span class="text-slate-500">未探测到内网 IPv4（可能离线或仅 IPv6 内网），请手填。</span>
        </template>
        <template v-else>
          <span class="text-slate-400">尚未探测</span>
        </template>
      </div>

      <!-- ChromeOS 才会有的 chrome.system.network 网卡列表（桌面 Chrome 不显示） -->
      <template v-if="lanInterfacesResult.supported && lanInterfacesResult.list.length">
        <div class="mt-2 pt-2 border-t border-slate-100">
          <div class="flex items-center justify-between gap-2 mb-1">
            <div class="text-[10.5px] font-semibold text-slate-500 uppercase tracking-wide">
              ChromeOS 网卡列表
              ({{ visibleLanInterfaces.length }}<span v-if="hiddenLanCount > 0">/{{ lanInterfacesResult.list.length }}</span>)
            </div>
            <div class="flex items-center gap-1">
              <button
                v-if="hiddenLanCount > 0 || showAllLan"
                type="button"
                class="text-[10.5px] px-1.5 py-0.5 rounded border border-slate-200 text-slate-500 hover:text-brand hover:border-brand"
                @click="showAllLan = !showAllLan"
              >{{ showAllLan ? '只看内/公网' : `+${hiddenLanCount}` }}</button>
              <button
                type="button"
                class="text-[10.5px] px-1.5 py-0.5 rounded border border-slate-200 text-slate-500 hover:text-brand hover:border-brand disabled:opacity-50"
                :disabled="lanLoading"
                @click="refreshLanInterfaces"
              >{{ lanLoading ? '…' : '刷新' }}</button>
            </div>
          </div>
          <div class="flex flex-col gap-y-1">
            <div
              v-for="(it, i) in visibleLanInterfaces"
              :key="`${it.name}-${it.family}-${it.address}-${i}`"
              class="grid grid-cols-[minmax(3.5rem,auto)_1fr_auto] gap-x-2 items-baseline text-[12px]"
            >
              <span class="font-mono text-slate-500 truncate" :title="it.name">{{ it.name || '?' }}</span>
              <span class="font-mono text-slate-700 truncate" :title="`${it.address}/${it.prefixLength}`">
                {{ it.address }}<span class="text-slate-400">/{{ it.prefixLength }}</span>
              </span>
              <span
                class="text-[10.5px] px-1 py-[1px] rounded border leading-none shrink-0"
                :class="SCOPE_CLS[it.scope]"
                :title="`${it.family.toUpperCase()} · ${SCOPE_LABEL[it.scope]}`"
              >{{ it.family }} · {{ SCOPE_LABEL[it.scope] }}</span>
            </div>
          </div>
        </div>
      </template>
    </div>

    <!-- 出口网络 -->
    <div class="rounded border border-slate-200 bg-white px-2.5 py-2">
      <div class="flex items-center justify-between gap-2 mb-1.5">
        <div class="flex items-center gap-1.5 text-[11px] font-semibold text-slate-500 uppercase tracking-wide">
          <span class="w-1.5 h-1.5 rounded-full" :class="ipDotClass"></span>
          出口网络
        </div>
        <button
          type="button"
          class="text-[11px] px-1.5 py-0.5 rounded border border-slate-200 bg-white text-slate-500 hover:text-brand hover:border-brand transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          :disabled="ipLoading"
          :title="ipLoading ? '正在刷新…' : '通过 ipinfo.io 重新拉取出口 IP'"
          @click="refreshOutboundIp(true)"
        >
          {{ ipLoading ? '刷新中…' : '刷新' }}
        </button>
      </div>
      <div class="grid grid-cols-[5rem_1fr] gap-x-2 gap-y-1 text-[12px]">
        <span class="text-slate-400">IP</span>
        <span class="font-mono text-slate-700 truncate" :title="ipDisplay">{{ ipDisplay }}</span>

        <template v-if="ipLocation">
          <span class="text-slate-400">位置</span>
          <span class="font-mono text-slate-700 truncate" :title="ipLocation">{{ ipLocation }}</span>
        </template>

        <template v-if="ipOrg">
          <span class="text-slate-400">ISP</span>
          <span class="font-mono text-slate-700 truncate" :title="ipOrg">{{ ipOrg }}</span>
        </template>

        <span class="text-slate-400">更新</span>
        <span
          class="font-mono truncate"
          :class="outboundIp?.ok === false ? 'text-red-600' : 'text-slate-500'"
          :title="outboundIp ? `at ${formatDateTime(outboundIp.at)}` : ''"
        >
          {{ ipUpdatedLabel }}
          <span v-if="outboundIp && outboundIp.ok === false" class="ml-1 text-red-500/80">
            · {{ ipErrLabel }}
          </span>
        </span>
      </div>
    </div>
  </section>
</template>
