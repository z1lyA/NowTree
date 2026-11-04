import { describe, it, expect } from "vitest";
import {
  DEFAULT_WEEKLY_REVIEW,
  WEEKLY_REVIEW_KEY,
  WEEKLY_REVIEW_LAST_KEY,
  getLastShownDate,
  getWeeklyReview,
  localDateKey,
  markWeeklyReviewShown,
  resetWeeklyReview,
  setWeeklyReview,
  shouldShowWeeklyReview,
  weekdayLabel,
  type KeyValueStore,
} from "./weeklyReview";

// 内存存储：node 环境没有 localStorage，用最小实现替代。
function memStore(): KeyValueStore {
  const map = new Map<string, string>();
  return {
    getItem: (k) => (map.has(k) ? map.get(k)! : null),
    setItem: (k, v) => {
      map.set(k, v);
    },
  };
}

describe("weeklyReview 配置", () => {
  it("默认启用、周日", () => {
    expect(getWeeklyReview(memStore())).toEqual({ enabled: true, weekday: 0 });
    expect(DEFAULT_WEEKLY_REVIEW).toEqual({ enabled: true, weekday: 0 });
  });

  it("非法 JSON 回落默认", () => {
    const store = memStore();
    store.setItem(WEEKLY_REVIEW_KEY, "not-a-json");
    expect(getWeeklyReview(store)).toEqual(DEFAULT_WEEKLY_REVIEW);
  });

  it("weekday 越界 / 非整数回落周日，enabled 非布尔回落默认", () => {
    const store = memStore();
    store.setItem(WEEKLY_REVIEW_KEY, JSON.stringify({ enabled: "yes", weekday: 99 }));
    expect(getWeeklyReview(store)).toEqual({ enabled: true, weekday: 0 });
  });

  it("保存后可读回，并做值收敛", () => {
    const store = memStore();
    setWeeklyReview({ enabled: false, weekday: 3 }, store);
    expect(getWeeklyReview(store)).toEqual({ enabled: false, weekday: 3 });
    setWeeklyReview({ enabled: true, weekday: 2.7 }, store);
    expect(getWeeklyReview(store).weekday).toBe(2);
  });

  it("恢复默认", () => {
    const store = memStore();
    setWeeklyReview({ enabled: false, weekday: 5 }, store);
    resetWeeklyReview(store);
    expect(getWeeklyReview(store)).toEqual(DEFAULT_WEEKLY_REVIEW);
  });

  it("weekdayLabel 覆盖 0–6 并兜底", () => {
    expect(weekdayLabel(0)).toBe("周日");
    expect(weekdayLabel(6)).toBe("周六");
    expect(weekdayLabel(42)).toBe("周日");
  });

  it("localDateKey 用本地日期（23:30 不会跨到次日 UTC）", () => {
    expect(localDateKey(new Date(2026, 0, 5, 23, 30))).toBe("2026-01-05");
    expect(localDateKey(new Date(2026, 10, 3, 0, 5))).toBe("2026-11-03");
  });

  it("标记已提醒后可读回，且只记录日期", () => {
    const store = memStore();
    markWeeklyReviewShown(new Date(2026, 10, 3, 10, 0), store);
    expect(getLastShownDate(store)).toBe("2026-11-03");
    expect(store.getItem(WEEKLY_REVIEW_LAST_KEY)).toBe("2026-11-03");
  });
});

describe("shouldShowWeeklyReview", () => {
  // 2026-11-01 是周日，2026-11-02 是周一
  const sunday10 = new Date(2026, 10, 1, 10, 0);
  const setting = { enabled: true, weekday: 0 };
  const base = { now: sunday10, setting, lastShownDate: null, inboxCount: 2 };

  it("周日 10 点、Inbox 非空、今天未提醒 → 弹", () => {
    expect(shouldShowWeeklyReview(base)).toBe(true);
  });

  it("星期不匹配 → 不弹", () => {
    expect(
      shouldShowWeeklyReview({ ...base, now: new Date(2026, 10, 2, 10, 0) }),
    ).toBe(false);
  });

  it("今天已提醒 → 不弹", () => {
    expect(shouldShowWeeklyReview({ ...base, lastShownDate: "2026-11-01" })).toBe(false);
    // 昨天提醒过则今天照常弹
    expect(shouldShowWeeklyReview({ ...base, lastShownDate: "2026-10-25" })).toBe(true);
  });

  it("Inbox 为空 → 不打扰", () => {
    expect(shouldShowWeeklyReview({ ...base, inboxCount: 0 })).toBe(false);
  });

  it("时间窗外（09:00 前 / 22:00 起）→ 不弹", () => {
    expect(shouldShowWeeklyReview({ ...base, now: new Date(2026, 10, 1, 8, 59) })).toBe(false);
    expect(shouldShowWeeklyReview({ ...base, now: new Date(2026, 10, 1, 9, 0) })).toBe(true);
    expect(shouldShowWeeklyReview({ ...base, now: new Date(2026, 10, 1, 21, 59) })).toBe(true);
    expect(shouldShowWeeklyReview({ ...base, now: new Date(2026, 10, 1, 22, 0) })).toBe(false);
  });

  it("开关关闭 → 不弹", () => {
    expect(
      shouldShowWeeklyReview({ ...base, setting: { enabled: false, weekday: 0 } }),
    ).toBe(false);
  });
});
