// 1.1.5：Inbox「每周回顾」提醒的配置与判定（纯前端，localStorage，零 Rust / DB 改动）。
//
// 大白话：每周挑一天提醒你「Inbox 堆着了，该把灵感整理成事务了」。
// 默认周日、启用；触发条件 = 开关开 + 今天是所选星期 + 当天还没提醒过 + Inbox 非空
// + 本地时间落在 09:00–22:00（避免深夜弹窗）。
//
// 存储：
//   nowtree_weekly_review      JSON { enabled, weekday }（weekday 对齐 JS getDay()：0=周日…6=周六）
//   nowtree_weekly_review_last 上次提醒的本地日期 YYYY-MM-DD
//
// 存储访问做成可注入参数，便于在 node 环境下单测（不依赖浏览器 localStorage）。

export interface WeeklyReviewSetting {
  enabled: boolean;
  weekday: number;
}

export const DEFAULT_WEEKLY_REVIEW: WeeklyReviewSetting = {
  enabled: true,
  weekday: 0, // 周日
};

// 按 JS getDay() 顺序索引：0=周日。
export const WEEKDAY_LABELS: string[] = [
  "周日",
  "周一",
  "周二",
  "周三",
  "周四",
  "周五",
  "周六",
];

export const REVIEW_START_HOUR = 9;
export const REVIEW_END_HOUR = 22;

export const WEEKLY_REVIEW_KEY = "nowtree_weekly_review";
export const WEEKLY_REVIEW_LAST_KEY = "nowtree_weekly_review_last";

// 最小存储接口（localStorage 子集），便于测试注入内存实现。
export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function defaultStore(): KeyValueStore | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

function normalizeWeekday(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return DEFAULT_WEEKLY_REVIEW.weekday;
  const i = Math.floor(n);
  return i >= 0 && i <= 6 ? i : DEFAULT_WEEKLY_REVIEW.weekday;
}

// 读取设置：缺失 / 解析失败 / 非法值一律回落默认（默认启用、周日）。
export function getWeeklyReview(store: KeyValueStore | null = defaultStore()): WeeklyReviewSetting {
  try {
    const raw = store?.getItem(WEEKLY_REVIEW_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<WeeklyReviewSetting>;
      return {
        enabled: typeof parsed.enabled === "boolean" ? parsed.enabled : DEFAULT_WEEKLY_REVIEW.enabled,
        weekday: normalizeWeekday(parsed.weekday),
      };
    }
  } catch {
    /* 解析失败 → 默认 */
  }
  return { ...DEFAULT_WEEKLY_REVIEW };
}

export function setWeeklyReview(
  setting: WeeklyReviewSetting,
  store: KeyValueStore | null = defaultStore(),
): void {
  const safe: WeeklyReviewSetting = {
    enabled: !!setting.enabled,
    weekday: normalizeWeekday(setting.weekday),
  };
  try {
    store?.setItem(WEEKLY_REVIEW_KEY, JSON.stringify(safe));
  } catch {
    /* 存储异常忽略 */
  }
}

export function resetWeeklyReview(store: KeyValueStore | null = defaultStore()): void {
  setWeeklyReview(DEFAULT_WEEKLY_REVIEW, store);
}

// 星期中文名（非法值回落周日）。
export function weekdayLabel(weekday: number): string {
  return WEEKDAY_LABELS[normalizeWeekday(weekday)];
}

// 本地日期 YYYY-MM-DD（勿用 toISOString：UTC 会把凌晨算到前一天）。
export function localDateKey(d: Date = new Date()): string {
  const y = d.getFullYear();
  const m = d.getMonth() + 1;
  const day = d.getDate();
  return `${y}-${String(m).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

export function getLastShownDate(
  store: KeyValueStore | null = defaultStore(),
): string | null {
  try {
    return store?.getItem(WEEKLY_REVIEW_LAST_KEY) ?? null;
  } catch {
    return null;
  }
}

// 记为「今天已提醒」，避免同一天重复弹卡。
export function markWeeklyReviewShown(
  d: Date = new Date(),
  store: KeyValueStore | null = defaultStore(),
): void {
  try {
    store?.setItem(WEEKLY_REVIEW_LAST_KEY, localDateKey(d));
  } catch {
    /* 存储异常忽略 */
  }
}

// 是否该弹「每周回顾」卡（纯判定，无副作用；不传 now 时用当前时间）。
export function shouldShowWeeklyReview(args: {
  now: Date;
  setting: WeeklyReviewSetting;
  lastShownDate: string | null;
  inboxCount: number;
}): boolean {
  const { now, setting, lastShownDate, inboxCount } = args;
  if (!setting.enabled) return false;
  if (setting.weekday !== now.getDay()) return false;
  if (inboxCount <= 0) return false;
  const hour = now.getHours();
  if (hour < REVIEW_START_HOUR || hour >= REVIEW_END_HOUR) return false;
  return lastShownDate !== localDateKey(now);
}
