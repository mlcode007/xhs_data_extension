import { STORAGE_KEYS } from './constants';
import { storage } from './storage';

// ---------- 导出数据类型 ----------

export interface ExportGroup {
  id: string;
  label: string;
  description: string;
  keys: string[];
}

export const EXPORT_GROUPS: ExportGroup[] = [
  {
    id: 'config',
    label: '基础配置',
    description: 'API 地址、搜索站点、自动登录页等',
    keys: [
      STORAGE_KEYS.apiHost,
      STORAGE_KEYS.searchSite,
      STORAGE_KEYS.searchSiteBase,
      STORAGE_KEYS.autoLoginPage,
    ]
  },
  {
    id: 'accounts',
    label: '账号配置',
    description: '账号列表、验证码映射、扫码配置等',
    keys: [
      STORAGE_KEYS.accountList,
      STORAGE_KEYS.selectedAccountIndex,
      STORAGE_KEYS.smsCodeMap,
      STORAGE_KEYS.loginMode,
      STORAGE_KEYS.qrLoginApiUrl,
      STORAGE_KEYS.qrLoginDefaultMax,
      STORAGE_KEYS.qrLoginSite,
      STORAGE_KEYS.qrSessionStats,
    ]
  },
  {
    id: 'keywords',
    label: '关键词配置',
    description: '关键词列表、筛选器、已执行标记等',
    keys: [
      STORAGE_KEYS.pluginSearchKeywords,
      STORAGE_KEYS.publishTimeFilter,
      STORAGE_KEYS.pluginKeywordTaskInfos,
      STORAGE_KEYS.orderedSearchExecutedKeywords,
    ]
  },
  {
    id: 'execution',
    label: '执行配置',
    description: '自动任务间隔、搜索模式、时间范围等',
    keys: [
      STORAGE_KEYS.autoTaskIntervalMin,
      STORAGE_KEYS.autoTaskIntervalMax,
      STORAGE_KEYS.autoTaskRunInBackground,
      STORAGE_KEYS.autoTaskAutoLoginEnabled,
      STORAGE_KEYS.orderedExecuteDelayMinSec,
      STORAGE_KEYS.orderedExecuteDelayMaxSec,
      STORAGE_KEYS.searchTriggerMode,
      STORAGE_KEYS.autoLoginOnDialog,
      STORAGE_KEYS.allowedTimeStart,
      STORAGE_KEYS.allowedTimeEnd,
      STORAGE_KEYS.allowedTimeRanges,
    ]
  },
  {
    id: 'stats',
    label: '采集统计',
    description: '账号每日采集统计、回传统计等',
    keys: [
      STORAGE_KEYS.accountCollectStats,
      STORAGE_KEYS.callbackDailyStats,
    ]
  },
];

/** storage key → 面板可读中文名 */
export const STORAGE_KEY_LABEL: Record<string, string> = {
  [STORAGE_KEYS.apiHost]: 'API 根地址',
  [STORAGE_KEYS.searchSite]: '搜索站点',
  [STORAGE_KEYS.searchSiteBase]: '搜索页地址',
  [STORAGE_KEYS.autoLoginPage]: '自动登录页',
  [STORAGE_KEYS.accountList]: '账号列表',
  [STORAGE_KEYS.selectedAccountIndex]: '当前选中账号',
  [STORAGE_KEYS.smsCodeMap]: '验证码映射',
  [STORAGE_KEYS.loginMode]: '登录方式',
  [STORAGE_KEYS.qrLoginApiUrl]: '扫码接口地址',
  [STORAGE_KEYS.qrLoginDefaultMax]: 'QR 每日上限',
  [STORAGE_KEYS.qrLoginSite]: '扫码站点',
  [STORAGE_KEYS.qrSessionStats]: 'QR 账号统计',
  [STORAGE_KEYS.pluginSearchKeywords]: '关键词列表',
  [STORAGE_KEYS.publishTimeFilter]: '发布时间筛选',
  [STORAGE_KEYS.pluginKeywordTaskInfos]: '关键词任务元数据',
  [STORAGE_KEYS.orderedSearchExecutedKeywords]: '已执行关键词',
  [STORAGE_KEYS.autoTaskIntervalMin]: '自动任务间隔下限',
  [STORAGE_KEYS.autoTaskIntervalMax]: '自动任务间隔上限',
  [STORAGE_KEYS.autoTaskRunInBackground]: '后台运行',
  [STORAGE_KEYS.autoTaskAutoLoginEnabled]: '自动登录',
  [STORAGE_KEYS.orderedExecuteDelayMinSec]: '顺序执行延迟下限',
  [STORAGE_KEYS.orderedExecuteDelayMaxSec]: '顺序执行延迟上限',
  [STORAGE_KEYS.searchTriggerMode]: '搜索触发方式',
  [STORAGE_KEYS.autoLoginOnDialog]: '弹窗自动登录',
  [STORAGE_KEYS.allowedTimeStart]: '可执行开始时间（旧版兼容）',
  [STORAGE_KEYS.allowedTimeEnd]: '可执行结束时间（旧版兼容）',
  [STORAGE_KEYS.allowedTimeRanges]: '可执行时间区间',
  [STORAGE_KEYS.accountCollectStats]: '账号采集统计',
  [STORAGE_KEYS.callbackDailyStats]: '回传日统计',
};

export interface ExportData {
  version: string;
  exportedAt: string;
  groups: Record<string, any>;
}

// ---------- 导出功能 ----------

/**
 * 导出选中的数据
 * @param selectedKeys 要导出的 storage key 列表
 * @returns 导出数据对象
 */
export async function exportData(selectedKeys: string[]): Promise<ExportData> {
  const keySet = new Set(selectedKeys);
  const allStorageData = await new Promise<Record<string, any>>((resolve) => {
    chrome.storage.local.get(null, (items) => resolve(items || {}));
  });
  const groups: Record<string, any> = {};

  for (const group of EXPORT_GROUPS) {
    const matchedKeys = group.keys.filter(k => keySet.has(k));
    if (matchedKeys.length === 0) continue;

    const groupData: Record<string, any> = {};
    for (const key of matchedKeys) {
      if (key in allStorageData && allStorageData[key] != null) {
        groupData[key] = allStorageData[key];
      }
    }
    if (Object.keys(groupData).length > 0) {
      groups[group.id] = groupData;
    }
  }

  return {
    version: '1.0',
    exportedAt: new Date().toISOString(),
    groups,
  };
}

// ---------- 导入功能 ----------

export interface ImportPreview {
  version: string;
  exportedAt: string;
  groups: Array<{
    id: string;
    label: string;
    description: string;
    keys: string[];
  }>;
  actions: Array<{
    key: string;
    action: 'overwrite' | 'create' | 'skip';
    currentValue?: any;
    newValue?: any;
  }>;
}

/**
 * 校验导入文件并生成预览
 * @param file 导入的 JSON 文件
 * @returns 预览对象或错误信息
 */
export async function validateImportFile(file: File): Promise<ImportPreview | { error: string }> {
  try {
    const text = await file.text();
    const data = JSON.parse(text) as unknown;

    if (!isValidExportData(data)) {
      return { error: '文件格式不正确，请确保是从此插件导出的文件' };
    }

    const actions: ImportPreview['actions'] = [];
    const allKeys = new Set<string>();

    for (const groupId in data.groups) {
      const group = EXPORT_GROUPS.find(g => g.id === groupId);
      if (!group) continue;

      const groupData = data.groups[groupId];
      for (const key in groupData) {
        allKeys.add(key);
      }
    }

    const currentData = await storage.get(Array.from(allKeys));

    for (const groupId in data.groups) {
      const group = EXPORT_GROUPS.find(g => g.id === groupId);
      if (!group) continue;

      const groupData = data.groups[groupId];
      for (const key in groupData) {
        const currentValue = currentData[key];
        const newValue = groupData[key];

        if (currentValue !== undefined) {
          actions.push({
            key,
            action: 'overwrite',
            currentValue,
            newValue,
          });
        } else {
          actions.push({
            key,
            action: 'create',
            newValue,
          });
        }
      }
    }

    const groups = EXPORT_GROUPS.filter(g => data.groups[g.id]);

    return {
      version: data.version,
      exportedAt: data.exportedAt,
      groups,
      actions,
    };
  } catch (e) {
    return { error: '文件解析失败，请确保是有效的 JSON 文件' };
  }
}

function isValidExportData(data: unknown): data is ExportData {
  if (!data || typeof data !== 'object') return false;
  const d = data as ExportData;
  return typeof d.version === 'string' &&
         typeof d.exportedAt === 'string' &&
         d.groups !== null &&
         typeof d.groups === 'object';
}

/** 所有合法的可导入 key 白名单 */
const ALLOWED_IMPORT_KEYS = new Set(EXPORT_GROUPS.flatMap(g => g.keys));

/**
 * 执行导入（覆盖或新增）
 * @param file 导入的 JSON 文件
 * @param selectedGroupIds 用户选择要导入的分组 ID；为空则导入文件中所有分组
 * @returns { ok, count } — ok 表示是否成功，count 表示实际写入的 key 数量
 */
export async function importData(
  file: File,
  selectedGroupIds?: string[],
): Promise<{ ok: boolean; count: number }> {
  try {
    const text = await file.text();
    const data = JSON.parse(text) as unknown;

    if (!isValidExportData(data)) {
      return { ok: false, count: 0 };
    }

    const groupFilter = selectedGroupIds && selectedGroupIds.length > 0
      ? new Set(selectedGroupIds)
      : null;

    const toSet: Record<string, any> = {};

    for (const groupId in data.groups) {
      if (groupFilter && !groupFilter.has(groupId)) continue;
      const groupData = data.groups[groupId];
      for (const key in groupData) {
        if (!ALLOWED_IMPORT_KEYS.has(key)) continue;
        if (groupData[key] == null) continue;
        toSet[key] = groupData[key];
      }
    }

    if (Object.keys(toSet).length === 0) {
      return { ok: true, count: 0 };
    }

    await storage.set(toSet);
    return { ok: true, count: Object.keys(toSet).length };
  } catch (e) {
    return { ok: false, count: 0 };
  }
}

/**
 * 生成下载文件
 * @param data 导出数据对象
 * @param filename 文件名（不含扩展名）
 */
export function downloadExportFile(data: ExportData, filename: string = 'xhs-crawler-config') {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  const dateStr = new Date().toISOString().slice(0, 10);
  a.download = `${filename}-${dateStr}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
