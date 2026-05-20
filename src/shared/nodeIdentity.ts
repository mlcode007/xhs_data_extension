/**
 * 节点身份与环境信息采集（100 节点集中管控 · 第一类指标）。
 *
 * 设计原则：
 * 1. 纯独立脚本，不依赖 Vue / 业务代码；可在 background SW、side panel、content
 *    （需 chrome.storage 权限）任意上下文里跑。
 * 2. 一次性 + 变更触发：单次启动只采一遍，写入 storage 后下次直接读缓存。
 * 3. 失败降级：所有取数都包了 try-catch，缺字段也能拼出可用快照。
 * 4. 浏览器 / 系统信息走 UA Client Hints 高熵字段，拿不到的情况下回退到
 *    navigator.userAgent + navigator.platform。
 * 5. 出口 IP 来自 https://ipinfo.io/json，结果按 IP_CACHE_TTL_MS 短缓存，
 *    避免 100 节点同时打爆免费额度。
 *
 * 仅本文件维护一份「字段定义」，UI / 上报 / 后端都用这份类型。
 */

import { STORAGE_KEYS } from './constants';
import { storage } from './storage';

// ---------- 缓存窗口 ----------
/** 出口 IP 拉取后保留多久才允许下一次刷新（也是 panel 显示「N 分钟前」的依据） */
export const OUTBOUND_IP_CACHE_TTL_MS = 5 * 60 * 1000;
/** 出口 IP 探针超时（避免代理 / 离线时一直挂着） */
export const OUTBOUND_IP_FETCH_TIMEOUT_MS = 6000;

// ---------- 类型定义 ----------

export interface OutboundIpInfo {
  /** 拉取时间戳 */
  at: number;
  /** 是否拉到了；false 时 ip / 地理字段全为空 */
  ok: boolean;
  /** 失败原因（HTTP / network / timeout / parse 等） */
  error?: string;
  ip?: string;
  hostname?: string;
  city?: string;
  region?: string;
  country?: string;
  loc?: string;
  /** ipinfo 上的 ASN / ISP 字段 */
  org?: string;
  postal?: string;
  timezone?: string;
}

/** UA Client Hints 字段（兼容老版 Chrome / 没有 navigator.userAgentData 的环境） */
export interface UserAgentInfo {
  /** UA-CH：可读品牌列表（低熵），如 [{brand:'Chromium', version:'132'}] */
  brands?: { brand: string; version: string }[];
  /** UA-CH：全量版本品牌（高熵） */
  fullVersionList?: { brand: string; version: string }[];
  /** UA-CH：是否移动设备 */
  mobile?: boolean;
  /** UA-CH：'macOS' / 'Windows' / 'Linux' ... */
  platform?: string;
  /** UA-CH：OS 版本（'14.6.0'） */
  platformVersion?: string;
  /** UA-CH：架构（'arm' / 'x86'） */
  architecture?: string;
  /** UA-CH：位宽（'64' / '32'） */
  bitness?: string;
  /** UA-CH：终端型号（桌面通常为空） */
  model?: string;
  /** 原始 navigator.userAgent（兜底用，遇到内部对账可以原样比对） */
  raw: string;
  /** 哪一路拿到的：'uach' = 高熵 API，'ua' = 仅 navigator.userAgent */
  source: 'uach' | 'ua';
}

/** IP 地址作用域分类，用于 UI 区分「真有用的内网地址 / 网卡链路本地噪音 / 公网」 */
export type IpScope = 'loopback' | 'link-local' | 'private' | 'public';

/** 单条网卡上的一个 IP（getNetworkInterfaces 一张网卡可能多条 v4/v6） */
export interface LanInterface {
  /** 网卡名，如 'en0' / 'utun3'（VPN）/ 'eth0' / 'wlp2s0' */
  name: string;
  /** IP 字面值，例如 '192.168.1.23' 或 'fe80::abcd:1234%en0' */
  address: string;
  /** 子网前缀长度（CIDR），例如 24 / 64 */
  prefixLength: number;
  family: 'v4' | 'v6';
  scope: IpScope;
}

/** chrome.system.network 调用结果（含「当前环境是否支持」标记） */
export interface LanInterfacesResult {
  /**
   * chrome.system.network 在当前运行环境是否可用。
   * 桌面 Chrome（Win/Mac/Linux）MV3 扩展永远是 false：
   *   chrome.system.network 是 ChromeOS 专属的 Apps API，桌面环境下对象不存在。
   * 只有 ChromeOS 上才会是 true。
   */
  supported: boolean;
  list: LanInterface[];
}

/** WebRTC ICE candidate 探针的结果 */
export interface WebRtcLanProbeResult {
  /** 抓到的真实内网 IPv4 列表（去重 + 排序） */
  ipv4: string[];
  /**
   * Chrome 110+ 默认对 page-context 的 RTCPeerConnection 启用 mDNS 混淆，
   * 把内网 IP 替换成 `xxxxx.local`。如果我们只看到 .local 没看到真实 IP，
   * 这个标记会被置 true，UI 据此提示用户手填。
   * （chrome-extension:// 上下文通常被视为 trusted，不会被混淆，但仍兜底）
   */
  blockedByMdns: boolean;
  /** 探测耗时（ms） */
  durationMs: number;
}

export interface DeviceInfo {
  /** navigator.languages（首选语言在前） */
  languages: string[];
  /** Intl 解析出来的时区，例如 'Asia/Shanghai' */
  timezone: string;
  /** 当前时区相对 UTC 的偏移（分钟，东区为正） */
  timezoneOffsetMin: number;
  /** 屏幕分辨率 + DPR；side panel 取的就是用户屏幕本身 */
  screen: {
    width: number;
    height: number;
    availWidth: number;
    availHeight: number;
    devicePixelRatio: number;
    colorDepth: number;
  };
  /** navigator.platform（旧字段，与 UA-CH 互为补充） */
  navigatorPlatform: string;
  /** navigator.onLine：起码能感知一下 SW 是否离线 */
  online: boolean;
  /** 硬件并发（≈ CPU 逻辑核心数） */
  hardwareConcurrency?: number;
  /** 估算的内存（GB，仅 Chrome 暴露给 high-entropy 等价物） */
  deviceMemoryGb?: number;
}

export interface ManifestInfo {
  /** 扩展名 */
  name: string;
  /** 当前版本号 */
  version: string;
  /** 扩展 ID（chrome.runtime.id） */
  extId: string;
  /** vendor-specific：MV3 manifest 版本号，方便回滚定位 */
  manifestVersion: number;
}

/** 一次全量身份 / 环境快照 */
export interface NodeIdentitySnapshot {
  nodeId: string;
  nodeAlias: string;
  /** 节点第一次跑起来的时间戳（≠ 浏览器启动时间） */
  firstSeenAt: number;
  /** 浏览器最近一次启动的时间戳 */
  startupAt: number;
  /** 取快照那一刻已经运行的时间（ms） */
  uptimeMs: number;
  manifest: ManifestInfo;
  ua: UserAgentInfo;
  device: DeviceInfo;
  /** 用户手填的主机名 / 物理位置标签 */
  hostname: string;
  /**
   * 用户手填的内网 IPv4，作为「群控定位」的权威值。
   * 自动探测结果只填到这里之外的「建议值」字段，不直接覆盖手填。
   */
  manualLanIpV4: string;
  /**
   * WebRTC 自动探测到的本机真实内网 IPv4 列表（不含 mDNS .local / 0.0.0.0）。
   * 仅供 UI / 上报时参考；权威值是 manualLanIpV4。
   */
  webrtcLanIpsV4: string[];
  /**
   * chrome.system.network 调用结果（含 supported 标记）。
   * - 桌面 Chrome：supported=false, list=[]
   * - ChromeOS：supported=true，list 是真实网卡数组
   */
  lanInterfacesResult: LanInterfacesResult;
  /** 出口 IP；可能为 null 表示从未拉过 / 网络不通 */
  outboundIp: OutboundIpInfo | null;
  /** 取快照的时间戳，便于上报对账 */
  takenAt: number;
}

// ---------- nodeId / alias / startupAt 持久化 ----------

function generateUuid(): string {
  try {
    const c: any = (globalThis as any).crypto;
    if (c?.randomUUID) return c.randomUUID();
  } catch {}
  // RFC4122 v4 兜底（环境太古老时）
  const hex = '0123456789abcdef';
  let s = '';
  for (let i = 0; i < 36; i++) {
    if (i === 8 || i === 13 || i === 18 || i === 23) {
      s += '-';
    } else if (i === 14) {
      s += '4';
    } else if (i === 19) {
      s += hex[(Math.random() * 4) | 0 | 8];
    } else {
      s += hex[(Math.random() * 16) | 0];
    }
  }
  return s;
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0;
}

/**
 * 保证 nodeId 存在并返回。
 *
 * 竞态说明：background / panel 同时首启时各自会读到空值并各生成一个 UUID，
 * 最后写者胜。这里写完再读一次「最终值」返回，确保调用方拿到的就是 storage 真实值，
 * 后续上报不会出现自己内存里一个 ID、storage 里另一个 ID 的分裂。
 */
export async function ensureNodeId(): Promise<string> {
  const existing = await storage.getOne<string>(STORAGE_KEYS.nodeId);
  if (isNonEmptyString(existing)) return existing;
  const fresh = generateUuid();
  await storage.setOne(STORAGE_KEYS.nodeId, fresh);
  const final = await storage.getOne<string>(STORAGE_KEYS.nodeId);
  return isNonEmptyString(final) ? final : fresh;
}

export async function getNodeAlias(): Promise<string> {
  const raw = await storage.getOne<string>(STORAGE_KEYS.nodeAlias);
  return typeof raw === 'string' ? raw : '';
}

export async function setNodeAlias(alias: string): Promise<void> {
  await storage.setOne(STORAGE_KEYS.nodeAlias, (alias || '').slice(0, 64));
}

/**
 * 标记一次「真正的浏览器启动」。
 * - chrome.runtime.onStartup
 * - chrome.runtime.onInstalled（install / update / chrome_update）
 * 都该调一下；SW 单纯被回收又拉起来不调（避免 startupAt 频繁刷新）。
 */
export async function markStartup(now: number = Date.now()): Promise<void> {
  await storage.setOne(STORAGE_KEYS.nodeStartupAt, now);
}

export async function getStartupAt(): Promise<number> {
  const v = await storage.getOne<number>(STORAGE_KEYS.nodeStartupAt);
  return typeof v === 'number' && v > 0 ? v : 0;
}

export async function ensureFirstSeenAt(now: number = Date.now()): Promise<number> {
  const v = await storage.getOne<number>(STORAGE_KEYS.nodeFirstSeenAt);
  if (typeof v === 'number' && v > 0) return v;
  await storage.setOne(STORAGE_KEYS.nodeFirstSeenAt, now);
  const final = await storage.getOne<number>(STORAGE_KEYS.nodeFirstSeenAt);
  return typeof final === 'number' && final > 0 ? final : now;
}

// ---------- 浏览器 / OS （UA Client Hints + 兜底） ----------

/**
 * 优先取 navigator.userAgentData.getHighEntropyValues 高熵字段；
 * 拿不到（非 Chromium / 隐私模式 / 老内核）就只填 raw + source='ua'。
 */
export async function collectUaInfo(): Promise<UserAgentInfo> {
  const raw = (typeof navigator !== 'undefined' && navigator.userAgent) || '';
  const uad: any = (typeof navigator !== 'undefined' && (navigator as any).userAgentData) || null;
  if (!uad) return { raw, source: 'ua' };
  try {
    const hints = await uad.getHighEntropyValues([
      'platform',
      'platformVersion',
      'architecture',
      'bitness',
      'model',
      'fullVersionList',
    ]);
    const brands = Array.isArray(uad.brands)
      ? uad.brands
          .filter((b: any) => b && typeof b.brand === 'string')
          .map((b: any) => ({ brand: String(b.brand), version: String(b.version || '') }))
      : undefined;
    const fullVersionList = Array.isArray(hints?.fullVersionList)
      ? hints.fullVersionList
          .filter((b: any) => b && typeof b.brand === 'string')
          .map((b: any) => ({ brand: String(b.brand), version: String(b.version || '') }))
      : undefined;
    return {
      raw,
      source: 'uach',
      brands,
      fullVersionList,
      mobile: typeof uad.mobile === 'boolean' ? uad.mobile : undefined,
      platform: typeof hints?.platform === 'string' ? hints.platform : undefined,
      platformVersion: typeof hints?.platformVersion === 'string' ? hints.platformVersion : undefined,
      architecture: typeof hints?.architecture === 'string' ? hints.architecture : undefined,
      bitness: typeof hints?.bitness === 'string' ? hints.bitness : undefined,
      model: typeof hints?.model === 'string' ? hints.model : undefined,
    };
  } catch {
    return { raw, source: 'ua' };
  }
}

// ---------- 屏幕 / 区域 ----------

function readScreenInfo(): DeviceInfo['screen'] {
  const fallback = {
    width: 0,
    height: 0,
    availWidth: 0,
    availHeight: 0,
    devicePixelRatio: 1,
    colorDepth: 24,
  };
  try {
    if (typeof screen === 'undefined') return fallback;
    return {
      width: Number(screen.width) || 0,
      height: Number(screen.height) || 0,
      availWidth: Number(screen.availWidth) || 0,
      availHeight: Number(screen.availHeight) || 0,
      devicePixelRatio:
        typeof window !== 'undefined' && typeof window.devicePixelRatio === 'number'
          ? window.devicePixelRatio
          : 1,
      colorDepth: Number(screen.colorDepth) || 24,
    };
  } catch {
    return fallback;
  }
}

function readTimezone(): { tz: string; offsetMin: number } {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || '';
    // getTimezoneOffset 返回的是「UTC - 本地」的分钟数，东区为负；这里翻一下符号
    const offsetMin = -new Date().getTimezoneOffset();
    return { tz, offsetMin };
  } catch {
    return { tz: '', offsetMin: 0 };
  }
}

export function collectDeviceInfo(): DeviceInfo {
  const screenInfo = readScreenInfo();
  const { tz, offsetMin } = readTimezone();
  const languages: string[] = (() => {
    try {
      if (typeof navigator === 'undefined') return [];
      if (Array.isArray(navigator.languages) && navigator.languages.length) {
        return navigator.languages.slice();
      }
      if (typeof navigator.language === 'string') return [navigator.language];
      return [];
    } catch {
      return [];
    }
  })();
  const navigatorPlatform = (() => {
    try {
      return (typeof navigator !== 'undefined' && navigator.platform) || '';
    } catch {
      return '';
    }
  })();
  const online = (() => {
    try {
      return typeof navigator !== 'undefined' ? !!navigator.onLine : true;
    } catch {
      return true;
    }
  })();
  const hardwareConcurrency = (() => {
    try {
      const v = typeof navigator !== 'undefined' ? navigator.hardwareConcurrency : undefined;
      return typeof v === 'number' && v > 0 ? v : undefined;
    } catch {
      return undefined;
    }
  })();
  const deviceMemoryGb = (() => {
    try {
      const v = (navigator as any)?.deviceMemory;
      return typeof v === 'number' && v > 0 ? v : undefined;
    } catch {
      return undefined;
    }
  })();
  return {
    languages,
    timezone: tz,
    timezoneOffsetMin: offsetMin,
    screen: screenInfo,
    navigatorPlatform,
    online,
    hardwareConcurrency,
    deviceMemoryGb,
  };
}

// ---------- 局域网网卡 / IP ----------

/**
 * 根据 RFC1918 / RFC4193 / RFC3927 / RFC4291 等约定，把 IP 地址分类到 4 个 scope：
 * - loopback：127.0.0.0/8、::1
 * - link-local：169.254.0.0/16、fe80::/10
 * - private：10/8、172.16/12、192.168/16、fc00::/7（ULA）
 * - public：剩余（包括 100.64/10 CGN，群控里也算公网处理）
 *
 * IPv6 字面值末尾可能带 "%scopeId"（zone identifier），需要先剥掉再判断。
 */
export function classifyIpAddress(address: string): { family: 'v4' | 'v6'; scope: IpScope } {
  const raw = String(address || '').trim();
  if (!raw) return { family: 'v4', scope: 'public' };
  // IPv6 含冒号
  if (raw.indexOf(':') !== -1) {
    const lower = raw.toLowerCase().split('%')[0];
    if (lower === '::1') return { family: 'v6', scope: 'loopback' };
    if (lower.startsWith('fe80:') || lower.startsWith('fe9') || lower.startsWith('fea') || lower.startsWith('feb')) {
      // fe80::/10
      return { family: 'v6', scope: 'link-local' };
    }
    // ULA：fc00::/7（首字节 0xfc / 0xfd）
    if (/^f[cd][0-9a-f]{0,2}:/.test(lower)) return { family: 'v6', scope: 'private' };
    return { family: 'v6', scope: 'public' };
  }
  // IPv4
  const parts = raw.split('.').map((s) => Number(s));
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n) || n < 0 || n > 255)) {
    return { family: 'v4', scope: 'public' };
  }
  const [a, b] = parts;
  if (a === 127) return { family: 'v4', scope: 'loopback' };
  if (a === 169 && b === 254) return { family: 'v4', scope: 'link-local' };
  if (a === 10) return { family: 'v4', scope: 'private' };
  if (a === 172 && b >= 16 && b <= 31) return { family: 'v4', scope: 'private' };
  if (a === 192 && b === 168) return { family: 'v4', scope: 'private' };
  return { family: 'v4', scope: 'public' };
}

/**
 * 列出本机所有网卡的 IP（含 IPv4 / IPv6 / loopback / link-local）。
 *
 * ⚠️ chrome.system.network.getNetworkInterfaces 实际上是 Chrome **Apps** API，
 *    在桌面 Chrome（Win/Mac/Linux）的 MV3 扩展里 chrome.system.network 对象**不存在**，
 *    只有 ChromeOS 才可用。所以本函数：
 *    - 桌面：返回 { supported: false, list: [] }
 *    - ChromeOS：返回 { supported: true, list: <真实网卡> }
 *
 * 桌面侧请配合 collectLanIpsFromWebRtc() + 用户手填值（nodeLanIpV4）使用。
 */
export async function collectLanInterfaces(): Promise<LanInterfacesResult> {
  try {
    const sys: any = (chrome as any)?.system;
    const net = sys?.network;
    if (!net || typeof net.getNetworkInterfaces !== 'function') {
      return { supported: false, list: [] };
    }
    const list: { name: string; address: string; prefixLength: number }[] = await new Promise(
      (resolve) => {
        try {
          // 同时兼容回调风格与新版 Promise 风格
          const ret = net.getNetworkInterfaces((items: any[]) => {
            void chrome.runtime.lastError;
            resolve(Array.isArray(items) ? items : []);
          });
          if (ret && typeof ret.then === 'function') {
            ret.then((items: any[]) => resolve(Array.isArray(items) ? items : [])).catch(() => resolve([]));
          }
        } catch {
          resolve([]);
        }
      },
    );
    const out: LanInterface[] = [];
    for (const it of list) {
      if (!it || typeof it.address !== 'string' || !it.address) continue;
      const cls = classifyIpAddress(it.address);
      out.push({
        name: String(it.name || ''),
        address: it.address,
        prefixLength: Number(it.prefixLength) || 0,
        family: cls.family,
        scope: cls.scope,
      });
    }
    // 排序：先 IPv4 后 IPv6；同一 family 内按 scope 优先级 private > public > link-local > loopback；
    // 再按网卡名稳定排序，便于人眼对比同一节点多次快照
    const scoreScope: Record<IpScope, number> = {
      private: 0,
      public: 1,
      'link-local': 2,
      loopback: 3,
    };
    out.sort((a, b) => {
      if (a.family !== b.family) return a.family === 'v4' ? -1 : 1;
      if (a.scope !== b.scope) return scoreScope[a.scope] - scoreScope[b.scope];
      if (a.name !== b.name) return a.name.localeCompare(b.name);
      return a.address.localeCompare(b.address);
    });
    return { supported: true, list: out };
  } catch {
    return { supported: false, list: [] };
  }
}

/**
 * 通过 WebRTC ICE candidate 探测本机真实内网 IPv4。
 *
 * 原理：
 * - new RTCPeerConnection() 收集 srflx / host 候选时，ICE 字符串里直接包含本机 IP
 * - Chrome 110+ 默认对网页里的 RTCPeerConnection 启用 mDNS 混淆（替换成 .local），
 *   但 chrome-extension:// 上下文（side panel / SW）属于 trusted，**通常不混淆**
 * - 即便混淆，我们只过滤掉 .local 和 0.0.0.0，剩下的就是可信的真实 IPv4
 *
 * 不抛异常；任何失败都返回 { ipv4: [], blockedByMdns: false, durationMs }，
 * 由调用方根据 ipv4 是否为空决定是否提示用户手填。
 */
export async function collectLanIpsFromWebRtc(timeoutMs = 1500): Promise<WebRtcLanProbeResult> {
  const startedAt = Date.now();
  const ipv4 = new Set<string>();
  let sawMdns = false;
  let sawRealIp = false;

  const RTC: any = (globalThis as any).RTCPeerConnection;
  if (typeof RTC !== 'function') {
    return { ipv4: [], blockedByMdns: false, durationMs: 0 };
  }

  let pc: any = null;
  try {
    pc = new RTC({ iceServers: [] });
    // 没有 datachannel / track 的 RTCPeerConnection 不会收集 candidate
    pc.createDataChannel('lan-probe');

    await new Promise<void>((resolve) => {
      const finish = () => {
        try { clearTimeout(timer); } catch {}
        resolve();
      };
      const timer = setTimeout(finish, timeoutMs);

      pc.onicecandidate = (ev: RTCPeerConnectionIceEvent) => {
        const cand = ev.candidate?.candidate;
        if (!cand) {
          // null candidate = 收集结束
          finish();
          return;
        }
        // ICE candidate 字符串格式：
        //   candidate:<foundation> <component> <protocol> <priority> <ip> <port> typ <type> ...
        const parts = cand.split(' ');
        if (parts.length < 8) return;
        const ip = parts[4];
        if (!ip || ip === '0.0.0.0') return;
        if (/\.local$/i.test(ip)) {
          sawMdns = true;
          return;
        }
        // 严格仅 IPv4：避免把 IPv6 / 主机名混进来
        if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(ip)) {
          // 同时排除 loopback；link-local 169.254 也排除（DHCP 失败兜底地址）
          const cls = classifyIpAddress(ip);
          if (cls.scope === 'loopback' || cls.scope === 'link-local') return;
          ipv4.add(ip);
          sawRealIp = true;
        }
      };

      // 触发 ICE 收集
      pc.createOffer()
        .then((offer: any) => pc.setLocalDescription(offer))
        .catch(() => finish());
    });
  } catch {
    // 静默失败
  } finally {
    try { pc && pc.close && pc.close(); } catch {}
  }

  return {
    ipv4: Array.from(ipv4).sort(),
    blockedByMdns: !sawRealIp && sawMdns,
    durationMs: Date.now() - startedAt,
  };
}

// ---------- 主机名 / 内网 IP 手填字段 ----------

export async function getNodeHostname(): Promise<string> {
  const v = await storage.getOne<string>(STORAGE_KEYS.nodeHostname);
  return typeof v === 'string' ? v : '';
}

export async function setNodeHostname(value: string): Promise<void> {
  await storage.setOne(STORAGE_KEYS.nodeHostname, (value || '').trim().slice(0, 128));
}

export async function getManualLanIpV4(): Promise<string> {
  const v = await storage.getOne<string>(STORAGE_KEYS.nodeLanIpV4);
  return typeof v === 'string' ? v : '';
}

export async function setManualLanIpV4(value: string): Promise<void> {
  await storage.setOne(STORAGE_KEYS.nodeLanIpV4, (value || '').trim().slice(0, 64));
}

/** 判断字符串是不是合法 IPv4 字面值（用于 UI 显示「✓ 合法」/ 不阻止保存） */
export function isValidIpv4(v: string): boolean {
  return /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/.test(
    (v || '').trim(),
  );
}

// ---------- manifest 信息 ----------

export function collectManifestInfo(): ManifestInfo {
  try {
    const m = chrome.runtime.getManifest();
    return {
      name: String(m?.name || ''),
      version: String(m?.version || ''),
      extId: chrome.runtime.id || '',
      manifestVersion: typeof m?.manifest_version === 'number' ? m.manifest_version : 3,
    };
  } catch {
    return { name: '', version: '', extId: '', manifestVersion: 3 };
  }
}

// ---------- 出口 IP ----------

/**
 * 拉取出口 IP / 地理信息。默认走缓存（OUTBOUND_IP_CACHE_TTL_MS 内不重复请求），
 * 传 force=true 时无条件刷新。
 *
 * 返回 OutboundIpInfo（ok=false 时也会落盘，方便 UI 显示失败原因）。
 *
 * 必须能在 background SW 上下文跑：用原生 fetch + AbortController 超时，
 * 不依赖任何 window-only API。
 */
export async function getOutboundIp(opts: { force?: boolean } = {}): Promise<OutboundIpInfo | null> {
  const cached = await storage.getOne<OutboundIpInfo>(STORAGE_KEYS.outboundIpCache);
  const now = Date.now();
  if (!opts.force && cached && typeof cached.at === 'number' && now - cached.at < OUTBOUND_IP_CACHE_TTL_MS) {
    return cached;
  }

  const result: OutboundIpInfo = { at: now, ok: false };
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), OUTBOUND_IP_FETCH_TIMEOUT_MS);
  try {
    const resp = await fetch('https://ipinfo.io/json', {
      method: 'GET',
      signal: ac.signal,
      // 别带 cookie / referrer，最小化指纹泄露
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      cache: 'no-store',
    });
    if (!resp.ok) {
      result.error = `HTTP ${resp.status}`;
    } else {
      const body: any = await resp.json().catch(() => null);
      if (!body || typeof body !== 'object') {
        result.error = 'parse_error';
      } else {
        result.ok = true;
        if (typeof body.ip === 'string') result.ip = body.ip;
        if (typeof body.hostname === 'string') result.hostname = body.hostname;
        if (typeof body.city === 'string') result.city = body.city;
        if (typeof body.region === 'string') result.region = body.region;
        if (typeof body.country === 'string') result.country = body.country;
        if (typeof body.loc === 'string') result.loc = body.loc;
        if (typeof body.org === 'string') result.org = body.org;
        if (typeof body.postal === 'string') result.postal = body.postal;
        if (typeof body.timezone === 'string') result.timezone = body.timezone;
      }
    }
  } catch (e: any) {
    if (e?.name === 'AbortError') result.error = 'timeout';
    else result.error = String(e?.message || e || 'unknown');
  } finally {
    clearTimeout(t);
  }

  try {
    await storage.setOne(STORAGE_KEYS.outboundIpCache, result);
  } catch {}
  return result;
}

/** 仅读缓存，不主动发起请求；UI 初次渲染时用 */
export async function readCachedOutboundIp(): Promise<OutboundIpInfo | null> {
  const v = await storage.getOne<OutboundIpInfo>(STORAGE_KEYS.outboundIpCache);
  return v && typeof v === 'object' ? v : null;
}

// ---------- 聚合快照 ----------

/**
 * 聚合一次完整的节点身份 / 环境快照。
 * - 默认不发起 IP 网络请求（fetchIp=false），仅读缓存，适合心跳上报
 * - fetchIp=true 时会按缓存 TTL 决定是否真正发起请求
 */
export async function getNodeIdentitySnapshot(
  opts: { fetchIp?: boolean; forceFetchIp?: boolean } = {},
): Promise<NodeIdentitySnapshot> {
  const [
    nodeId,
    nodeAlias,
    hostname,
    manualLanIpV4,
    startupAt,
    firstSeenAt,
    ua,
    lanInterfacesResult,
  ] = await Promise.all([
    ensureNodeId(),
    getNodeAlias(),
    getNodeHostname(),
    getManualLanIpV4(),
    getStartupAt(),
    ensureFirstSeenAt(),
    collectUaInfo(),
    collectLanInterfaces(),
  ]);
  const outboundIp = opts.forceFetchIp
    ? await getOutboundIp({ force: true })
    : opts.fetchIp
      ? await getOutboundIp()
      : await readCachedOutboundIp();
  // WebRTC 探针每次都拉一遍（耗时通常 < 1s）；不缓存 — 网卡 / VPN 切换要立刻反映
  const webrtcProbe = await collectLanIpsFromWebRtc(1500).catch(
    (): WebRtcLanProbeResult => ({ ipv4: [], blockedByMdns: false, durationMs: 0 }),
  );
  const device = collectDeviceInfo();
  const manifest = collectManifestInfo();
  const takenAt = Date.now();
  const uptimeMs = startupAt > 0 ? Math.max(0, takenAt - startupAt) : 0;
  return {
    nodeId,
    nodeAlias,
    firstSeenAt,
    startupAt,
    uptimeMs,
    manifest,
    ua,
    device,
    hostname,
    manualLanIpV4,
    webrtcLanIpsV4: webrtcProbe.ipv4,
    lanInterfacesResult,
    outboundIp,
    takenAt,
  };
}

// ---------- background 侧初始化 ----------

/**
 * background SW 启动时调用一次。
 *
 * 职责：
 * 1. 保证 nodeId / firstSeenAt 存在；
 * 2. 监听 chrome.runtime.onStartup / onInstalled 更新 startupAt；
 * 3. 如果 storage 完全空（首次安装且 onInstalled 还没跑），兜底写一次 startupAt。
 *
 * 设计为幂等：多次调用不会出问题（只会重复 addListener，但 chrome.runtime 内部去重）。
 * 但仍建议只在 service worker 顶层调用一次。
 */
export function initNodeIdentityInBackground(): void {
  // 顶层就跑起来：拿不到 chrome.* 时静默退出，方便测试环境 import 也不爆
  try {
    if (typeof chrome === 'undefined' || !chrome.runtime) return;
  } catch {
    return;
  }

  // 1. 保证 nodeId + firstSeenAt（不阻塞后续逻辑）
  ensureNodeId().catch(() => {});
  ensureFirstSeenAt().catch(() => {});

  // 2. onStartup（浏览器启动）/ onInstalled（安装、升级）更新 startupAt
  try {
    chrome.runtime.onStartup.addListener(() => {
      markStartup().catch(() => {});
    });
  } catch {}
  try {
    chrome.runtime.onInstalled.addListener(() => {
      markStartup().catch(() => {});
    });
  } catch {}

  // 3. 兜底：storage 里完全没有 startupAt（首次安装且监听器还没机会触发），写一次
  storage
    .getOne<number>(STORAGE_KEYS.nodeStartupAt)
    .then((v) => {
      if (typeof v !== 'number' || v <= 0) {
        markStartup().catch(() => {});
      }
    })
    .catch(() => {});
}
