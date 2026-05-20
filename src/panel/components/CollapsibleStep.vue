<script setup lang="ts">
import { ref, computed, watch, onMounted } from 'vue';
import { storage } from '@shared/storage';

type StepStatus = 'idle' | 'doing' | 'done' | 'error' | 'warn';

interface QuickAction {
  label: string;
  onClick: () => void;
  variant?: 'default' | 'danger' | 'primary';
}

const props = withDefaults(
  defineProps<{
    step?: number | string;
    title: string;
    status?: StepStatus;
    /** 折叠态显示的一句话摘要 */
    summary?: string;
    /** 折叠态的快捷按钮（如「切换」「退出」） */
    actions?: QuickAction[];
    /** 首次进入（storage 中无记录）时是否默认展开。默认 false：全部折叠。 */
    defaultExpanded?: boolean;
    /** 关闭自动折叠：true 时永远不会因 status 变化而自动折叠 */
    disableAutoCollapse?: boolean;
  }>(),
  {
    status: 'idle',
    defaultExpanded: false,
    disableAutoCollapse: false,
    actions: () => [],
  },
);

// 展开状态持久化到 chrome.storage.local（panelStepExpanded）：
// - 首次打开（storage 中无记录）：按 props.defaultExpanded 决定，默认全部折叠
// - 之后每次打开都恢复上一次的展开/折叠状态
// - 用户点击 chevron / 显式调用 expand() / status 自动状态机切换都会写回 storage
//
// 多个 CollapsibleStep 同时挂载、可能并发写入；用模块级共享 map +
// 微节流（50ms 合并）写入，避免「读-改-写」竞态丢失其他面板的状态。
const STEP_STATE_KEY = 'panelStepExpanded';

const stepMap = new Map<string, boolean>();
let stepMapLoaded = false;
let stepMapLoadingPromise: Promise<void> | null = null;

async function ensureStepMapLoaded(): Promise<void> {
  if (stepMapLoaded) return;
  if (!stepMapLoadingPromise) {
    stepMapLoadingPromise = (async () => {
      const raw = (await storage.getOne<Record<string, boolean>>(STEP_STATE_KEY)) || {};
      for (const k in raw) stepMap.set(k, !!raw[k]);
      stepMapLoaded = true;
    })();
  }
  await stepMapLoadingPromise;
}

let persistTimer: ReturnType<typeof setTimeout> | null = null;
function schedulePersist(): void {
  if (persistTimer != null) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    const obj: Record<string, boolean> = {};
    stepMap.forEach((v, k) => (obj[k] = v));
    storage.setOne(STEP_STATE_KEY, obj).catch(() => {});
  }, 50);
}

const expanded = ref(initialExpanded());
// 是否已完成「读 storage → 决定初始展开态」的初始化。
// 在此之前任何来自 props.status 的自动展开/折叠规则都不允许触发，
// 否则可能在首次 storage 读完成前被异步加载的 status 变化错误展开。
const initialized = ref(false);
// 是否仍允许 watch(props.status) 自动调整展开态。
// 一旦：(a) storage 已有保存值，或 (b) 用户手动操作过 → 永久关闭，
// 后续不再被自动状态机覆盖。
const allowAutoStatusToggle = ref(true);
// 是否允许写回 storage。在 onMounted 读完 storage 之前不允许写入，
// 避免「初始默认值 false」被当作用户选择写回，把已保存的展开态抹掉。
const allowPersist = ref(false);

onMounted(async () => {
  await ensureStepMapLoaded();
  if (props.step != null) {
    const k = String(props.step);
    if (stepMap.has(k)) {
      expanded.value = !!stepMap.get(k);
      allowAutoStatusToggle.value = false;
    }
  }
  initialized.value = true;
  allowPersist.value = true;
});

watch(expanded, async (val) => {
  if (!allowPersist.value) return;
  if (props.step == null) return;
  await ensureStepMapLoaded();
  stepMap.set(String(props.step), val);
  schedulePersist();
});

function initialExpanded(): boolean {
  return !!props.defaultExpanded;
}

watch(
  () => props.status,
  (next, prev) => {
    if (props.disableAutoCollapse) return;
    // 出错强制展开（哪怕用户折叠过，也展开方便看错误）
    if (next === 'error') {
      expanded.value = true;
      return;
    }
    // 初始化未完成 / 已有保存值 / 用户操作过 → 不允许自动状态机改写
    if (!initialized.value) return;
    if (!allowAutoStatusToggle.value) return;
    if (prev === 'doing' && next === 'done') {
      expanded.value = false;
      return;
    }
    if (prev === 'done' && next !== 'done') {
      expanded.value = true;
      return;
    }
  },
);

function toggle() {
  expanded.value = !expanded.value;
  allowAutoStatusToggle.value = false;
}

/** 供父组件外部强制展开（如顶部状态条点击徽章跳转到对应配置项） */
function expand() {
  expanded.value = true;
  allowAutoStatusToggle.value = false;
}

defineExpose({ expand });

const statusDot = computed(() => {
  switch (props.status) {
    case 'done':
      return { cls: 'bg-green-500', label: '已完成' };
    case 'doing':
      return { cls: 'bg-blue-500 animate-pulse', label: '进行中' };
    case 'error':
      return { cls: 'bg-red-500', label: '出错' };
    case 'warn':
      return { cls: 'bg-amber-500 animate-pulse', label: '需处理' };
    default:
      return { cls: 'bg-slate-400', label: '未开始' };
  }
});

// 头部底色按状态着色（折叠态更显眼，展开态保持但更浅）
const headerClass = computed(() => {
  switch (props.status) {
    case 'done':
      return [
        'border-l-[3px] border-l-green-500',
        expanded.value
          ? 'bg-green-50/40 hover:bg-green-50'
          : 'bg-green-50 hover:bg-green-100',
      ].join(' ');
    case 'doing':
      return [
        'border-l-[3px] border-l-blue-500',
        expanded.value ? 'bg-blue-50/50 hover:bg-blue-50' : 'bg-blue-50 hover:bg-blue-100',
      ].join(' ');
    case 'error':
      return [
        'border-l-[3px] border-l-red-500',
        expanded.value ? 'bg-red-50/50 hover:bg-red-50' : 'bg-red-50 hover:bg-red-100',
      ].join(' ');
    case 'warn':
      return [
        'border-l-[3px] border-l-amber-500',
        expanded.value
          ? 'bg-amber-50/50 hover:bg-amber-50'
          : 'bg-amber-50 hover:bg-amber-100',
      ].join(' ');
    default:
      return [
        'border-l-[3px] border-l-slate-300',
        expanded.value ? 'bg-slate-50 hover:bg-slate-100' : 'bg-slate-100 hover:bg-slate-200',
      ].join(' ');
  }
});

// 标题文字颜色随状态略微变化
const titleClass = computed(() => {
  switch (props.status) {
    case 'done':
      return 'text-green-800';
    case 'doing':
      return 'text-blue-800';
    case 'error':
      return 'text-red-800';
    case 'warn':
      return 'text-amber-800';
    default:
      return 'text-slate-700';
  }
});

function actionClasses(a: QuickAction): string {
  if (a.variant === 'danger')
    return 'text-[12px] px-2 py-0.5 rounded border border-red-200 text-red-600 hover:bg-red-50';
  if (a.variant === 'primary')
    return 'text-[12px] px-2 py-0.5 rounded border border-brand text-white bg-brand hover:opacity-90';
  return 'text-[12px] px-2 py-0.5 rounded border border-slate-300 text-slate-600 hover:text-brand hover:border-brand';
}
</script>

<template>
  <section class="rounded-md border border-slate-200 bg-white mb-3 overflow-hidden shadow-sm">
    <header
      class="flex items-center gap-2 px-3 py-2.5 cursor-pointer select-none transition-colors"
      :class="headerClass"
      @click="toggle"
    >
      <span :class="['w-2.5 h-2.5 rounded-full shrink-0', statusDot.cls]" :title="statusDot.label"></span>

      <span v-if="step != null" class="text-[11px] text-slate-500 font-mono shrink-0">{{ step }}.</span>

      <span class="text-[13px] font-semibold shrink-0" :class="titleClass">{{ title }}</span>

      <span
        v-if="!expanded && summary"
        class="text-[12px] text-slate-500 truncate flex-1 min-w-0"
        :title="summary"
      >· {{ summary }}</span>
      <span v-else class="flex-1"></span>

      <!-- 折叠态显示快捷操作 -->
      <template v-if="!expanded && actions.length">
        <button
          v-for="(a, i) in actions"
          :key="i"
          :class="actionClasses(a)"
          @click.stop="a.onClick()"
        >{{ a.label }}</button>
      </template>

      <svg
        xmlns="http://www.w3.org/2000/svg"
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
        class="text-slate-400 transition-transform shrink-0"
        :class="expanded ? 'rotate-180' : ''"
        aria-hidden="true"
      >
        <path d="m6 9 6 6 6-6" />
      </svg>
    </header>

    <Transition
      enter-active-class="transition-[max-height,opacity] duration-200 ease-out overflow-hidden"
      enter-from-class="max-h-0 opacity-0"
      enter-to-class="max-h-[2000px] opacity-100"
      leave-active-class="transition-[max-height,opacity] duration-150 ease-in overflow-hidden"
      leave-from-class="max-h-[2000px] opacity-100"
      leave-to-class="max-h-0 opacity-0"
    >
      <div v-show="expanded" class="border-t border-slate-100 px-3 py-3">
        <slot />
      </div>
    </Transition>
  </section>
</template>
