// 1.1.5：右下角提醒弹窗的个性化偏好（localStorage，零 Rust / 数据库改动）。
//
// 可配置项：
//   - enabled          是否允许弹窗通知（关闭后所有提醒卡都不弹；事务提醒仍按时间正常消费）
//   - corner           弹窗位置：屏幕四个角落
//   - width            弹窗宽度：窄 / 标准 / 宽
//   - showDailyDigest  是否自动显示每日摘要卡
//   - snoozeMinutes    「稍后」时长：5 / 15 / 30 分钟
//
// 说明：拖拽只影响当前这一次显示，不记忆位置——位置以本配置（corner）为准，
// 避免「拖到某处后换显示器 / 改四角设置」互相打架。

export type ReminderCorner = "top-left" | "top-right" | "bottom-left" | "bottom-right";
export type SnoozeMinutes = 5 | 15 | 30;

export interface ReminderPrefs {
  enabled: boolean;
  corner: ReminderCorner;
  width: number;
  showDailyDigest: boolean;
  snoozeMinutes: SnoozeMinutes;
}

export const REMINDER_WIDTH_OPTIONS = [340, 380, 420] as const;
export const SNOOZE_OPTIONS: SnoozeMinutes[] = [5, 15, 30];
export const CORNER_OPTIONS: ReminderCorner[] = [
  "top-left",
  "top-right",
  "bottom-left",
  "bottom-right",
];

export const CORNER_LABELS: Record<ReminderCorner, string> = {
  "top-left": "左上",
  "top-right": "右上",
  "bottom-left": "左下",
  "bottom-right": "右下",
};

// 距屏幕工作区边缘的间距（逻辑像素）。1.1.5 起由 16 调大到 40：
// 弹窗整体稍微往左上（或所选角落的内侧）一点，不再紧贴边缘。
export const REMINDER_EDGE_MARGIN = 40;

export const DEFAULT_REMINDER_PREFS: ReminderPrefs = {
  enabled: true,
  corner: "bottom-right",
  width: 380,
  showDailyDigest: true,
  snoozeMinutes: 5,
};

const KEY = "nowtree_reminder_prefs";

interface PrefsStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function defaultStore(): PrefsStore | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

function normalizeCorner(v: unknown): ReminderCorner {
  return CORNER_OPTIONS.includes(v as ReminderCorner)
    ? (v as ReminderCorner)
    : DEFAULT_REMINDER_PREFS.corner;
}

function normalizeWidth(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  return REMINDER_WIDTH_OPTIONS.includes(n as (typeof REMINDER_WIDTH_OPTIONS)[number])
    ? n
    : DEFAULT_REMINDER_PREFS.width;
}

function normalizeSnooze(v: unknown): SnoozeMinutes {
  const n = typeof v === "number" ? v : Number(v);
  return (SNOOZE_OPTIONS as number[]).includes(n)
    ? (n as SnoozeMinutes)
    : DEFAULT_REMINDER_PREFS.snoozeMinutes;
}

// 读取偏好：缺失 / 解析失败 / 非法值一律逐项回落默认。
export function getReminderPrefs(store: PrefsStore | null = defaultStore()): ReminderPrefs {
  try {
    const raw = store?.getItem(KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<ReminderPrefs>;
      return {
        enabled:
          typeof parsed.enabled === "boolean"
            ? parsed.enabled
            : DEFAULT_REMINDER_PREFS.enabled,
        corner: normalizeCorner(parsed.corner),
        width: normalizeWidth(parsed.width),
        showDailyDigest:
          typeof parsed.showDailyDigest === "boolean"
            ? parsed.showDailyDigest
            : DEFAULT_REMINDER_PREFS.showDailyDigest,
        snoozeMinutes: normalizeSnooze(parsed.snoozeMinutes),
      };
    }
  } catch {
    /* 解析失败 → 默认 */
  }
  return { ...DEFAULT_REMINDER_PREFS };
}

export function setReminderPrefs(
  prefs: ReminderPrefs,
  store: PrefsStore | null = defaultStore(),
): void {
  const safe: ReminderPrefs = {
    enabled: !!prefs.enabled,
    corner: normalizeCorner(prefs.corner),
    width: normalizeWidth(prefs.width),
    showDailyDigest: !!prefs.showDailyDigest,
    snoozeMinutes: normalizeSnooze(prefs.snoozeMinutes),
  };
  try {
    store?.setItem(KEY, JSON.stringify(safe));
  } catch {
    /* 存储异常忽略 */
  }
}

export function resetReminderPrefs(store: PrefsStore | null = defaultStore()): void {
  setReminderPrefs(DEFAULT_REMINDER_PREFS, store);
}

// 传给 Rust 的布局参数（与 src-tauri/src/reminder.rs 的 ReminderLayout 对应）。
export interface ReminderLayout {
  corner: ReminderCorner;
  width: number;
  margin: number;
}

export function reminderLayoutOf(
  prefs: ReminderPrefs = getReminderPrefs(),
): ReminderLayout {
  return {
    corner: prefs.corner,
    width: prefs.width,
    margin: REMINDER_EDGE_MARGIN,
  };
}
