/** 把小红书前端的相对/中文时间归一化为 YYYY-MM-DD HH:mm:ss */
export function normalizePublishTime(text: string | undefined): string {
  if (!text || typeof text !== 'string') return text || '';
  const t = text.trim();
  if (!t) return '';
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  let m: RegExpMatchArray | null;

  m = t.match(/^(昨天|今天)\s*(\d{1,2}):(\d{2})$/);
  if (m) {
    const d = m[1] === '昨天' ? new Date(now.getTime() - 864e5) : now;
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${m[2]}:${m[3]}:00`;
  }
  m = t.match(/^(\d+)\s*分钟前$/);
  if (m) {
    const d = new Date(now.getTime() - Number(m[1]) * 60 * 1000);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }
  m = t.match(/^(\d+)\s*小时前$/);
  if (m) {
    const d = new Date(now.getTime() - Number(m[1]) * 3600 * 1000);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }
  m = t.match(/^(\d+)\s*天前$/);
  if (m) {
    const d = new Date(now.getTime() - Number(m[1]) * 864e5);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} 00:00:00`;
  }
  m = t.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return `${m[1]}-${m[2]}-${m[3]} 00:00:00`;
  m = t.match(/^(\d{2})-(\d{2})$/);
  if (m) {
    const y = now.getFullYear();
    let dt = new Date(y, +m[1] - 1, +m[2]);
    if (dt > now) dt = new Date(y - 1, +m[1] - 1, +m[2]);
    return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())} 00:00:00`;
  }
  return t;
}

export function getTodayDateStr(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** 解析 'HH:mm' 格式为当日分钟数；不合法返回 null */
export function parseTimeToMinutes(timeStr: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(timeStr.trim());
  if (!m) return null;
  const h = parseInt(m[1], 10);
  const min = parseInt(m[2], 10);
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  return h * 60 + min;
}

const DAY_MIN = 24 * 60;
const DAY_SEC = 24 * 3600;

/**
 * 把单个区间归一化为 [start, end) 闭开半开形式（分钟数）：
 * - 同日：[s, e)
 * - 跨午夜（s > e）：拆成 [s, 1440) 与 [0, e)
 * - end === start：视为「就该分钟内可执行」= [s, s+1)，即 [HH:mm:00, HH:mm+1:00)。
 *   这是用户在 picker 中选两次相同时间最自然的语义；
 *   "全天可执行"语义请通过「删光所有段」表达。
 *   边界：23:59-23:59 → [1439, 1440)，仍在当天范围内。
 * - 解析失败：返回 []
 */
function expandRangeMin(start: string, end: string): Array<[number, number]> {
  const s = parseTimeToMinutes(start);
  const e = parseTimeToMinutes(end);
  if (s === null || e === null) return [];
  if (s === e) return [[s, Math.min(s + 1, DAY_MIN)]];
  if (s < e) return [[s, e]];
  return [[s, DAY_MIN], [0, e]];
}

/** 合并 / 排序 / 去重叠 ，得到不相交、按 start 升序的区间集 */
function mergeRangesMin(ranges: Array<[number, number]>): Array<[number, number]> {
  if (ranges.length === 0) return [];
  const sorted = ranges.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const out: Array<[number, number]> = [];
  for (const [s, e] of sorted) {
    const last = out[out.length - 1];
    if (last && s <= last[1]) {
      if (e > last[1]) last[1] = e;
    } else {
      out.push([s, e]);
    }
  }
  return out;
}

/**
 * 把多段配置归一化为「合并后、按 start 升序、互不重叠」的分钟区间集合。
 * 任一区间字符串非法（含空串）→ 整段视为无效被丢弃。
 * 全部丢弃后返回空数组，调用方按"不限制"处理。
 */
export function buildEffectiveRangesMin(
  ranges: ReadonlyArray<{ start: string; end: string }>,
): Array<[number, number]> {
  const expanded: Array<[number, number]> = [];
  for (const r of ranges) {
    for (const seg of expandRangeMin(r.start, r.end)) expanded.push(seg);
  }
  return mergeRangesMin(expanded);
}

/**
 * 多区间版「可执行时间」判定。
 * - ranges 为空 / 全部非法 → 视为不限制：inRange=true，nextChangeMinutes=60（兜底刷新）
 * - 否则取并集后判定 nowMin 是否落在其中
 * @returns inRange + 距下一次「开窗或关窗」的分钟数（≥1）
 */
export function isInAllowedTimeRanges(
  ranges: ReadonlyArray<{ start: string; end: string }>,
): { inRange: boolean; nextChangeMinutes: number } {
  const eff = buildEffectiveRangesMin(ranges);
  if (eff.length === 0) return { inRange: true, nextChangeMinutes: 60 };

  const now = new Date();
  const nowMin = now.getHours() * 60 + now.getMinutes();

  for (const [s, e] of eff) {
    if (nowMin >= s && nowMin < e) {
      // 落在某段内，下一次切换 = 该段 end
      return { inRange: true, nextChangeMinutes: Math.max(1, e - nowMin) };
    }
  }
  // 不在任何段内 → 找「最近一个未来的 start」
  let nextStart = Infinity;
  for (const [s] of eff) {
    if (s > nowMin && s < nextStart) nextStart = s;
  }
  if (!isFinite(nextStart)) {
    // 今天之内没有更晚的开始点 → 取明天第一个开始点
    nextStart = DAY_MIN + eff[0][0];
  }
  return { inRange: false, nextChangeMinutes: Math.max(1, nextStart - nowMin) };
}

/**
 * 多区间版「下次切换」秒级倒计时（用于 UI 按秒刷新展示）。
 */
export function getNextAllowedChangeSecondsForRanges(
  ranges: ReadonlyArray<{ start: string; end: string }>,
): { inRange: boolean; nextChangeSeconds: number } {
  const eff = buildEffectiveRangesMin(ranges);
  if (eff.length === 0) return { inRange: true, nextChangeSeconds: 3600 };

  const now = new Date();
  const nowSec = now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds();

  for (const [s, e] of eff) {
    const startSec = s * 60;
    const endSec = e * 60;
    if (nowSec >= startSec && nowSec < endSec) {
      return { inRange: true, nextChangeSeconds: Math.max(1, endSec - nowSec) };
    }
  }
  let nextStartSec = Infinity;
  for (const [s] of eff) {
    const startSec = s * 60;
    if (startSec > nowSec && startSec < nextStartSec) nextStartSec = startSec;
  }
  if (!isFinite(nextStartSec)) {
    nextStartSec = DAY_SEC + eff[0][0] * 60;
  }
  return { inRange: false, nextChangeSeconds: Math.max(1, nextStartSec - nowSec) };
}

/**
 * 检查当前时间是否在允许执行的时间范围内。
 * - 同一天内：start <= end，如 10:00-21:00
 * - 跨午夜：start > end，如 22:00-06:00
 * @returns `inRange` 当前是否在窗口内；`nextChangeMinutes` 距离下一次状态切换的分钟数（≥0）
 */
export function isInAllowedTimeRange(
  start: string,
  end: string,
): { inRange: boolean; nextChangeMinutes: number } {
  const startMin = parseTimeToMinutes(start);
  const endMin = parseTimeToMinutes(end);
  if (startMin === null || endMin === null) return { inRange: true, nextChangeMinutes: 60 };

  const now = new Date();
  const nowMin = now.getHours() * 60 + now.getMinutes();

  if (startMin <= endMin) {
    const inRange = nowMin >= startMin && nowMin < endMin;
    const nextChangeMinutes = inRange
      ? endMin - nowMin
      : nowMin < startMin
        ? startMin - nowMin
        : 24 * 60 - nowMin + startMin;
    return { inRange, nextChangeMinutes };
  } else {
    const inRange = nowMin >= startMin || nowMin < endMin;
    const nextChangeMinutes = inRange
      ? nowMin >= startMin
        ? 24 * 60 - nowMin + endMin
        : endMin - nowMin
      : startMin - nowMin;
    return { inRange, nextChangeMinutes };
  }
}

/**
 * 比 isInAllowedTimeRange 更精细：返回距下次切换的「秒数」。
 * 仅用于 UI 倒计时显示（按秒刷新）；调度逻辑请继续用 isInAllowedTimeRange。
 */
export function getNextAllowedChangeSeconds(start: string, end: string): {
  inRange: boolean;
  /** 距下一次「开窗 / 关窗」的剩余秒数；inRange=true 时是关窗时刻，false 时是开窗时刻 */
  nextChangeSeconds: number;
} {
  const startMin = parseTimeToMinutes(start);
  const endMin = parseTimeToMinutes(end);
  if (startMin === null || endMin === null) {
    return { inRange: true, nextChangeSeconds: 3600 };
  }
  const now = new Date();
  const nowSec = now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds();
  const startSec = startMin * 60;
  const endSec = endMin * 60;
  const DAY = 24 * 3600;

  if (startMin <= endMin) {
    const inRange = nowSec >= startSec && nowSec < endSec;
    const nextChangeSeconds = inRange
      ? endSec - nowSec
      : nowSec < startSec
        ? startSec - nowSec
        : DAY - nowSec + startSec;
    return { inRange, nextChangeSeconds };
  } else {
    const inRange = nowSec >= startSec || nowSec < endSec;
    const nextChangeSeconds = inRange
      ? nowSec >= startSec
        ? DAY - nowSec + endSec
        : endSec - nowSec
      : startSec - nowSec;
    return { inRange, nextChangeSeconds };
  }
}

export function getTraceId(): string {
  // 按你最新需求，traceid 前缀用 年-月-日-时-分-秒 的格式（中间有 - 号），比如 2024-06-08-12-30-45xxxx
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const dateStr = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
  const rand = Math.random().toString(36).substring(2, 10);
  return dateStr + rand;
//   return 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'.replace(/x/g, () =>
//     ((Math.random() * 16) | 0).toString(16),
//   );
}
