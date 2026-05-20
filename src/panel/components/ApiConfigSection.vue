<script setup lang="ts">
import { useStorageRef } from '../composables/useStorageRef';
import {
  STORAGE_KEYS,
  API_HOST_DEFAULT,
  SEARCH_SITE_DEFAULT,
  SEARCH_SITE_URL,
  SEARCH_SITE_LABEL,
  AUTO_LOGIN_PAGE_DEFAULT,
  SEARCH_TRIGGER_MODE_DEFAULT,
  SEARCH_TRIGGER_MODE_LABEL,
  SEARCH_TRIGGER_MODE_DESC,
  SEARCH_TRIGGER_MODE_PRIORITY,
  ALLOWED_TIME_RANGES_DEFAULT,
  normalizeAllowedTimeRanges,
  type SearchTriggerMode,
  type SearchSite,
  type AllowedTimeRange,
} from '@shared/constants';
import { storage, onLocalStorageChange } from '@shared/storage';
import { getNextAllowedChangeSecondsForRanges, buildEffectiveRangesMin } from '@shared/time';
import { computed, onMounted, onUnmounted, reactive, ref, watch } from 'vue';

const apiHost = useStorageRef(STORAGE_KEYS.apiHost, API_HOST_DEFAULT);
const searchSite = useStorageRef<SearchSite>(STORAGE_KEYS.searchSite, SEARCH_SITE_DEFAULT);
const autoLoginPage = useStorageRef(STORAGE_KEYS.autoLoginPage, AUTO_LOGIN_PAGE_DEFAULT);

// 搜索站点切换时同步更新 searchSiteBase（供 background 使用）
const searchSiteBase = useStorageRef(STORAGE_KEYS.searchSiteBase, SEARCH_SITE_URL[SEARCH_SITE_DEFAULT]);
watch(searchSite, (v) => {
  searchSiteBase.value = SEARCH_SITE_URL[v] || SEARCH_SITE_URL[SEARCH_SITE_DEFAULT];
});
const SITES: SearchSite[] = ['cn', 'intl'];

// 搜索触发方式
const searchTriggerMode = useStorageRef<SearchTriggerMode>(
  STORAGE_KEYS.searchTriggerMode,
  SEARCH_TRIGGER_MODE_DEFAULT,
);
const MODES = SEARCH_TRIGGER_MODE_PRIORITY;

// 搜索间隔 & 发布时间筛选（手动顺序搜索 / 自动任务共用）
const orderedDelayMinSec = useStorageRef<number>(STORAGE_KEYS.orderedExecuteDelayMinSec, 120);
const orderedDelayMaxSec = useStorageRef<number>(STORAGE_KEYS.orderedExecuteDelayMaxSec, 130);
const publishTimeFilter = useStorageRef<string>(STORAGE_KEYS.publishTimeFilter, '半年内');

// ---------- 可执行时间范围（多段） ----------
// 这里**不复用 useStorageRef**：useStorageRef 的 load() 是 onMounted 异步发起的，
// 在 load 完成前对 ref 的写入会被 `if (!loaded) return` 吞掉，紧接着 load 完成会把
// ref 整体覆盖回 storage 旧值。具体表现是：用户点"添加时间段"按钮的第一下，
// UI 会闪一下出现新行又立刻消失。
//
// 自己用 reactive + ready 标记 + onChanged 回响去重，能彻底避免这个 race，
// 同时配合 v-model 让 time picker 不会被引用替换冲掉。
interface AllowedRangesState {
  list: AllowedTimeRange[];
  ready: boolean;
}
const rangesState = reactive<AllowedRangesState>({
  list: ALLOWED_TIME_RANGES_DEFAULT.map((r) => ({ ...r })),
  ready: false,
});

const ser = (v: unknown): string => {
  try { return JSON.stringify(v); } catch { return String(v); }
};
// 自己最近一次写出的序列化值；onChanged 收到与此相同的回响时直接忽略，避免回灌。
let lastWrittenSer = ser(rangesState.list);
let unsubRanges: (() => void) | null = null;

onMounted(async () => {
  try {
    const o = await storage.get([
      STORAGE_KEYS.allowedTimeRanges,
      STORAGE_KEYS.allowedTimeStart,
      STORAGE_KEYS.allowedTimeEnd,
    ]);
    const raw = o[STORAGE_KEYS.allowedTimeRanges];
    if (Array.isArray(raw)) {
      // 已有新字段：尊重存储里的值（允许空数组 = 不限制）
      rangesState.list = normalizeAllowedTimeRanges(raw);
    } else {
      // 新字段不存在：尝试从旧字段迁移
      const legacyStart = o[STORAGE_KEYS.allowedTimeStart];
      const legacyEnd = o[STORAGE_KEYS.allowedTimeEnd];
      const hasLegacy = typeof legacyStart === 'string' || typeof legacyEnd === 'string';
      const migrated: AllowedTimeRange[] = hasLegacy
        ? [{
            start: typeof legacyStart === 'string' ? legacyStart : '10:00',
            end: typeof legacyEnd === 'string' ? legacyEnd : '21:00',
          }]
        : ALLOWED_TIME_RANGES_DEFAULT.map((r) => ({ ...r }));
      rangesState.list = migrated;
      // 立刻把"迁移结果 / 默认值"落盘，方便后续 background 直接读到新字段
      lastWrittenSer = ser(migrated);
      try { await storage.set({ [STORAGE_KEYS.allowedTimeRanges]: migrated }); } catch {}
    }
    lastWrittenSer = ser(rangesState.list);
  } finally {
    rangesState.ready = true;
  }

  // 监听外部变更（如导入配置、其他面板写入）—— 自己写出去的回响通过 lastWrittenSer 去重
  unsubRanges = onLocalStorageChange(STORAGE_KEYS.allowedTimeRanges, (change) => {
    if (!rangesState.ready) return;
    const v = normalizeAllowedTimeRanges(change.newValue);
    const s = ser(v);
    if (s === lastWrittenSer) return;
    lastWrittenSer = s;
    rangesState.list = v;
  });
});

onUnmounted(() => {
  if (unsubRanges) {
    unsubRanges();
    unsubRanges = null;
  }
});

// 任意 list / list[i].start / list[i].end 变化都同步写回 storage（含 v-model 编辑）
watch(
  () => rangesState.list,
  (v) => {
    if (!rangesState.ready) return;
    const s = ser(v);
    if (s === lastWrittenSer) return;
    lastWrittenSer = s;
    storage.set({ [STORAGE_KEYS.allowedTimeRanges]: v.slice() }).catch(() => {});
  },
  { deep: true },
);

function addTimeRange() {
  if (!rangesState.ready) return;
  rangesState.list.push({ start: '', end: '' });
}

function removeTimeRange(idx: number) {
  if (!rangesState.ready) return;
  if (idx < 0 || idx >= rangesState.list.length) return;
  rangesState.list.splice(idx, 1);
}

// ---------- 快捷预设 ----------
// 常用模板，一键替换整个 list；watch 会自动落盘。
// "采 Xh / 歇 Yh" 类预设由 buildAlternatingRanges 程序化生成，不写死。

interface TimeRangePreset {
  id: string;
  label: string;
  desc: string;
  ranges: AllowedTimeRange[];
}

function formatMinAsHmm(m: number): string {
  const h = Math.floor(m / 60) % 24;
  const min = m % 60;
  return `${pad2(h)}:${pad2(min)}`;
}

/**
 * 从 startMin 起，按「采 workMin 分 / 歇 restMin 分」交替排到 endMin。
 * 每段单独不跨午夜，保证 HTML time picker 能正常显示 + background 判定一致。
 */
function buildAlternatingRanges(
  workMin: number,
  restMin: number,
  startMin = 0,
  endMin = 24 * 60,
): AllowedTimeRange[] {
  const out: AllowedTimeRange[] = [];
  let t = startMin;
  while (t < endMin) {
    const e = Math.min(endMin, t + workMin);
    if (e <= t) break;
    out.push({ start: formatMinAsHmm(t), end: formatMinAsHmm(e) });
    t = e + restMin;
  }
  return out;
}

const TIME_RANGE_PRESETS: TimeRangePreset[] = [
  {
    id: 'all',
    label: '全天',
    desc: '清空所有时间段 = 24h 不限制',
    ranges: [],
  },
  {
    id: 'daytime',
    label: '白天 9-18',
    desc: '工作时段：09:00 - 18:00',
    ranges: [{ start: '09:00', end: '18:00' }],
  },
  {
    id: 'avoid-lunch',
    label: '避午休 10-21',
    desc: '上午 10:00-13:00 + 下午 14:00-21:00',
    ranges: [
      { start: '10:00', end: '13:00' },
      { start: '14:00', end: '21:00' },
    ],
  },
  {
    id: 'on1off1',
    label: '采1h 歇1h',
    desc: '00:00 起采 1 小时 / 歇 1 小时，共 12 段（反风控节奏）',
    ranges: buildAlternatingRanges(60, 60),
  },
  {
    id: 'on2off2',
    label: '采2h 歇2h',
    desc: '00:00 起采 2 小时 / 歇 2 小时，共 6 段（间隔更长）',
    ranges: buildAlternatingRanges(120, 120),
  },
  {
    id: 'on30off30',
    label: '采30m 歇30m',
    desc: '00:00 起采 30 分钟 / 歇 30 分钟，共 24 段（最密集）',
    ranges: buildAlternatingRanges(30, 30),
  },
  {
    id: 'night',
    label: '夜班 22-06',
    desc: '22:00 至次日 06:00（跨午夜单段）',
    ranges: [{ start: '22:00', end: '06:00' }],
  },
];

const presetSer = (rs: AllowedTimeRange[]): string => {
  // 标准化：剔除未填完整 + 排序，再序列化；避免「顺序不同 / 留了空段」时无法匹配
  const norm = rs
    .filter((r) => r.start && r.end)
    .slice()
    .sort((a, b) => (a.start === b.start ? a.end.localeCompare(b.end) : a.start.localeCompare(b.start)));
  try { return JSON.stringify(norm); } catch { return ''; }
};

/**
 * 当前 list 是否完全匹配某个预设；用于按钮高亮。
 * - 'all' 预设单独处理：valid 段为 0 都算匹配
 */
const activePresetId = computed<string | null>(() => {
  if (!rangesState.ready) return null;
  const valid = rangesState.list.filter((r) => r.start && r.end);
  if (valid.length === 0) return 'all';
  const cur = presetSer(rangesState.list);
  for (const p of TIME_RANGE_PRESETS) {
    if (p.id === 'all') continue;
    if (presetSer(p.ranges) === cur) return p.id;
  }
  return null;
});

function applyPreset(p: TimeRangePreset) {
  if (!rangesState.ready) return;
  // 整体替换；watch(rangesState.list) + lastWrittenSer 已经处理落盘 + 去回响
  rangesState.list = p.ranges.map((r) => ({ ...r }));
}

/**
 * 判定单段当前是否有效，用于在行末显示小提示：
 * - 任一端为空 → 'incomplete'：未填完整的段会被 isInAllowedTimeRanges 跳过
 * - 起止相同 → 'one-minute'：解释为"该分钟内可执行"（[HH:mm:00, HH:mm+1:00)），合法
 * - 否则 'ok'
 */
function getRangeRowHint(r: AllowedTimeRange): 'ok' | 'incomplete' | 'one-minute' {
  if (!r.start || !r.end) return 'incomplete';
  if (r.start === r.end) return 'one-minute';
  return 'ok';
}

// ---------- 实时状态指示（让用户肉眼确认配置生效） ----------
// 跟 background 用的是同一个 @shared/time 的多区间判定逻辑，因此面板上看到的状态
// 就是 background 此刻会做出的判定。
const nowTick = ref(Date.now());
let timeStatusTimer: ReturnType<typeof setInterval> | null = null;
onMounted(() => {
  timeStatusTimer = setInterval(() => (nowTick.value = Date.now()), 1000);
});
onUnmounted(() => {
  if (timeStatusTimer) {
    clearInterval(timeStatusTimer);
    timeStatusTimer = null;
  }
});

function pad2(n: number): string { return String(n).padStart(2, '0'); }
function formatNowHms(ms: number): string {
  const d = new Date(ms);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}
function formatHmsDuration(totalSec: number): string {
  if (totalSec <= 0) return '0s';
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h ${pad2(m)}m ${pad2(s)}s`;
  if (m > 0) return `${m}m ${pad2(s)}s`;
  return `${s}s`;
}

const timeRangeLiveStatus = computed(() => {
  void nowTick.value; // 触发依赖刷新
  if (!rangesState.ready) {
    return { kind: 'loading' as const };
  }
  const list = rangesState.list;
  // 合法段（start 和 end 都填了）
  const valid = list.filter((r) => r.start && r.end);
  if (list.length === 0 || valid.length === 0) {
    return { kind: 'unlimited' as const, nowLabel: formatNowHms(nowTick.value) };
  }
  const r = getNextAllowedChangeSecondsForRanges(valid);
  return {
    kind: r.inRange ? ('in' as const) : ('out' as const),
    nowLabel: formatNowHms(nowTick.value),
    untilLabel: formatHmsDuration(Math.max(0, r.nextChangeSeconds)),
  };
});

// 合并 / 去重叠后的「实际生效窗口」字符串列表（HH:mm 格式，跨午夜会拆成两段）。
// 用来让用户看清楚配置的多段经过并集运算后实际是什么，避免「我删了一段倒计时却没变」的困惑。
function formatMinAsHm(m: number): string {
  if (m >= 24 * 60) return '24:00';
  return `${pad2(Math.floor(m / 60))}:${pad2(m % 60)}`;
}
const effectiveRangesLabel = computed<string>(() => {
  if (!rangesState.ready) return '';
  const valid = rangesState.list.filter((r) => r.start && r.end);
  if (valid.length === 0) return '';
  const eff = buildEffectiveRangesMin(valid);
  if (eff.length === 0) return '';
  return eff.map(([s, e]) => `${formatMinAsHm(s)}-${formatMinAsHm(e)}`).join(' / ');
});
// 原始段（剔除未填完整的）数量；用于判断是否需要提示「实际窗口」（多于 1 段且发生了合并 / 包含才提示）
const rawValidCount = computed<number>(() => {
  if (!rangesState.ready) return 0;
  return rangesState.list.filter((r) => r.start && r.end).length;
});
const effectiveCount = computed<number>(() => {
  if (!rangesState.ready) return 0;
  const valid = rangesState.list.filter((r) => r.start && r.end);
  if (valid.length === 0) return 0;
  return buildEffectiveRangesMin(valid).length;
});
// 仅当「原始段经过合并后段数 / 边界变了」时才展示『实际窗口』提示，避免单段时啰嗦
const shouldShowEffective = computed<boolean>(() => {
  if (!rangesState.ready) return false;
  const valid = rangesState.list.filter((r) => r.start && r.end);
  if (valid.length <= 1) return false; // 单段无需提示
  // 多段：只要原始段拼起来的 raw label ≠ 合并后的 effective label，就提示
  const rawLabel = valid.map((r) => `${r.start}-${r.end}`).join(' / ');
  return rawLabel !== effectiveRangesLabel.value;
});
</script>

<template>
  <section class="panel-card">
    <label class="section-label">接口根地址</label>
    <input v-model.lazy="apiHost" class="input-base mb-2" placeholder="https://your-api.example/" />

    <label class="section-label">搜索页站点</label>
    <div class="inline-flex rounded border border-slate-200 overflow-hidden mb-1.5" role="radiogroup">
      <button
        v-for="s in SITES"
        :key="s"
        type="button"
        role="radio"
        :aria-checked="s === searchSite"
        class="px-3 py-1.5 text-[12px] border-r border-slate-200 last:border-r-0 transition-colors"
        :class="s === searchSite
          ? 'bg-brand text-white'
          : 'bg-white text-slate-600 hover:bg-slate-50'"
        @click="searchSite = s"
      >
        {{ SEARCH_SITE_LABEL[s] }}
      </button>
    </div>
    <p class="text-[11px] text-slate-400 mb-2 break-all">{{ SEARCH_SITE_URL[searchSite] }}</p>

    <label class="section-label">自动登录打开页（自动登录或弹窗触发时先跳转到此地址）</label>
    <input v-model.lazy="autoLoginPage" class="input-base mb-3" placeholder="https://www.rednote.com" />

    <label class="section-label">搜索触发方式（运行中切换次轮关键词生效）</label>
    <div class="inline-flex rounded border border-slate-200 overflow-hidden mb-1.5" role="radiogroup">
      <button
        v-for="m in MODES"
        :key="m"
        type="button"
        role="radio"
        :aria-checked="m === searchTriggerMode"
        class="px-3 py-1.5 text-[12px] border-r border-slate-200 last:border-r-0 transition-colors"
        :class="m === searchTriggerMode
          ? 'bg-brand text-white'
          : 'bg-white text-slate-600 hover:bg-slate-50'"
        :title="SEARCH_TRIGGER_MODE_DESC[m]"
        @click="searchTriggerMode = m"
      >
        {{ SEARCH_TRIGGER_MODE_LABEL[m] }}
      </button>
    </div>
    <p class="text-[11px] text-slate-400 mb-3">
      {{ SEARCH_TRIGGER_MODE_DESC[searchTriggerMode] }}
    </p>

    <label class="section-label">搜索间隔 & 发布时间筛选（手动与自动任务共用）</label>
    <div class="flex flex-wrap items-center gap-x-4 gap-y-2 mb-1">
      <div class="flex flex-nowrap items-center gap-x-2 text-[12px] text-slate-600">
        <span>间隔（秒，随机）</span>
        <div class="flex flex-nowrap items-center gap-x-1.5">
          <label class="inline-flex items-center gap-0.5">
            <span class="text-slate-500">最小</span>
            <input
              v-model.number="orderedDelayMinSec"
              type="number"
              min="0"
              step="1"
              class="input-base w-12 py-1 px-1 text-[12px] text-center"
            />
          </label>
          <span class="text-slate-400">～</span>
          <label class="inline-flex items-center gap-0.5">
            <span class="text-slate-500">最大</span>
            <input
              v-model.number="orderedDelayMaxSec"
              type="number"
              min="0"
              step="1"
              class="input-base w-12 py-1 px-1 text-[12px] text-center"
            />
          </label>
        </div>
      </div>

      <div class="flex flex-nowrap items-center gap-2 text-[12px] text-slate-600">
        <span class="shrink-0">发布时间筛选</span>
        <select
          v-model="publishTimeFilter"
          class="shrink-0 px-2 py-1 border border-slate-200 rounded text-[12px] max-w-[7rem]"
        >
          <option value="">不筛选</option>
          <option>一天内</option>
          <option>一周内</option>
          <option>半年内</option>
          <option>一年内</option>
        </select>
      </div>
    </div>

    <label class="section-label">可执行时间范围（可添加多段，并集生效）</label>

    <!-- 快捷预设：点一下整体替换时间段列表；激活的预设会高亮 -->
    <div class="flex flex-wrap items-center gap-1.5 mb-1.5">
      <span class="text-[11px] text-slate-400 shrink-0">快捷:</span>
      <button
        v-for="p in TIME_RANGE_PRESETS"
        :key="p.id"
        type="button"
        class="text-[11px] px-2 py-0.5 rounded border transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        :class="activePresetId === p.id
          ? 'bg-brand/10 border-brand text-brand'
          : 'bg-white border-slate-200 text-slate-600 hover:text-brand hover:border-brand hover:bg-brand/5'"
        :title="p.desc"
        :disabled="!rangesState.ready"
        @click="applyPreset(p)"
      >{{ p.label }}</button>
    </div>

    <div class="flex flex-col gap-y-1.5 mb-1">
      <div
        v-for="(range, idx) in rangesState.list"
        :key="idx"
        class="flex flex-nowrap items-center gap-x-2 text-[12px] text-slate-600"
      >
        <input
          v-model="range.start"
          type="time"
          class="input-base w-[5.5rem] py-1 px-1.5 text-[12px] text-center"
          :disabled="!rangesState.ready"
        />
        <span class="text-slate-400">～</span>
        <input
          v-model="range.end"
          type="time"
          class="input-base w-[5.5rem] py-1 px-1.5 text-[12px] text-center"
          :disabled="!rangesState.ready"
        />
        <button
          type="button"
          class="inline-flex items-center justify-center w-6 h-6 rounded border border-slate-200 text-slate-400 hover:text-red-500 hover:border-red-300 hover:bg-red-50 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          title="删除该时间段"
          :disabled="!rangesState.ready"
          @click="removeTimeRange(idx)"
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24"
            fill="none" stroke="currentColor" stroke-width="2"
            stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M5 12h14"/>
          </svg>
        </button>
        <!-- 该段有效性提示：未填完整会被忽略；起止相同 = 该分钟可执行 -->
        <template v-if="getRangeRowHint(range) === 'one-minute'">
          <span class="text-[11px] text-slate-500" title="起止相同：解释为该分钟内可执行 1 分钟，即 [HH:mm:00, HH:mm+1:00)">该分钟 1 分钟可执行</span>
        </template>
        <template v-else-if="getRangeRowHint(range) === 'incomplete'">
          <span class="text-[11px] text-slate-400" title="未填完整的段会被忽略">未填完整</span>
        </template>
        <span v-else-if="idx === 0" class="text-[11px] text-slate-400">留空 / 全部删除则不限制</span>
      </div>
      <div>
        <button
          type="button"
          class="inline-flex items-center gap-1 px-2 py-1 rounded border border-dashed border-slate-300 text-[12px] text-slate-500 hover:text-brand hover:border-brand hover:bg-brand/5 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          :disabled="!rangesState.ready"
          @click="addTimeRange"
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24"
            fill="none" stroke="currentColor" stroke-width="2"
            stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M12 5v14"/>
            <path d="M5 12h14"/>
          </svg>
          <span>添加时间段</span>
        </button>
        <span class="ml-2 text-[11px] text-slate-400">示例：上午 10:00-13:00 + 下午 14:00-21:00 避开午休</span>
      </div>

      <!-- 实时状态：跟 background 用的判定同源，配完后即可看到效果 -->
      <div class="mt-1 flex flex-col gap-y-1">
        <div
          class="inline-flex items-center gap-1.5 px-2 py-1 rounded text-[11px] leading-none border w-fit"
          :class="{
            'border-slate-200 bg-slate-50 text-slate-500': timeRangeLiveStatus.kind === 'loading' || timeRangeLiveStatus.kind === 'unlimited',
            'border-green-200 bg-green-50 text-green-700': timeRangeLiveStatus.kind === 'in',
            'border-amber-200 bg-amber-50 text-amber-700': timeRangeLiveStatus.kind === 'out',
          }"
        >
          <template v-if="timeRangeLiveStatus.kind === 'loading'">
            <span>读取配置中…</span>
          </template>
          <template v-else-if="timeRangeLiveStatus.kind === 'unlimited'">
            <span class="w-1.5 h-1.5 rounded-full bg-slate-400"></span>
            <span class="font-mono">{{ timeRangeLiveStatus.nowLabel }}</span>
            <span>· 当前不限制（全天可执行）</span>
          </template>
          <template v-else-if="timeRangeLiveStatus.kind === 'in'">
            <span class="w-1.5 h-1.5 rounded-full bg-green-500"></span>
            <span class="font-mono">{{ timeRangeLiveStatus.nowLabel }}</span>
            <span>· 在窗口内 · 距关窗</span>
            <span class="font-mono font-semibold">{{ timeRangeLiveStatus.untilLabel }}</span>
          </template>
          <template v-else>
            <span class="w-1.5 h-1.5 rounded-full bg-amber-500"></span>
            <span class="font-mono">{{ timeRangeLiveStatus.nowLabel }}</span>
            <span>· 不在窗口 · 距开窗</span>
            <span class="font-mono font-semibold">{{ timeRangeLiveStatus.untilLabel }}</span>
          </template>
        </div>

        <!-- 多段时如果发生了「合并 / 包含」，把"实际生效窗口"显式展示出来，
             避免"明明删了一段倒计时却没变"的困惑 -->
        <div
          v-if="shouldShowEffective"
          class="inline-flex items-center gap-1.5 px-2 py-1 rounded text-[11px] leading-none border border-blue-200 bg-blue-50 text-blue-700 w-fit"
          :title="`配置了 ${rawValidCount} 段，并集 / 合并后实际只剩 ${effectiveCount} 段`"
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24"
            fill="none" stroke="currentColor" stroke-width="2"
            stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <circle cx="12" cy="12" r="9"/>
            <path d="M12 8v4"/>
            <path d="M12 16h.01"/>
          </svg>
          <span>实际生效窗口：</span>
          <span class="font-mono font-semibold">{{ effectiveRangesLabel }}</span>
          <span class="text-blue-600/80">（{{ rawValidCount }} 段 → {{ effectiveCount }} 段，存在重叠 / 包含）</span>
        </div>
      </div>
    </div>
  </section>
</template>
