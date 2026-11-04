import { describe, it, expect } from "vitest";
import {
  DEFAULT_REMINDER_PREFS,
  REMINDER_EDGE_MARGIN,
  getReminderPrefs,
  reminderLayoutOf,
  resetReminderPrefs,
  setReminderPrefs,
  type ReminderPrefs,
} from "./reminderPrefs";

function memStore() {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
    setItem: (k: string, v: string) => {
      map.set(k, v);
    },
  };
}

describe("reminderPrefs", () => {
  it("默认：启用、右下、380、显示每日摘要、稍后 5 分钟", () => {
    expect(getReminderPrefs(memStore())).toEqual(DEFAULT_REMINDER_PREFS);
    expect(DEFAULT_REMINDER_PREFS).toEqual({
      enabled: true,
      corner: "bottom-right",
      width: 380,
      showDailyDigest: true,
      snoozeMinutes: 5,
    });
  });

  it("保存后可读回", () => {
    const store = memStore();
    const prefs: ReminderPrefs = {
      enabled: false,
      corner: "top-left",
      width: 420,
      showDailyDigest: false,
      snoozeMinutes: 30,
    };
    setReminderPrefs(prefs, store);
    expect(getReminderPrefs(store)).toEqual(prefs);
  });

  it("非法值逐项回落默认", () => {
    const store = memStore();
    store.setItem(
      "nowtree_reminder_prefs",
      JSON.stringify({
        enabled: "yes",
        corner: "middle",
        width: 999,
        showDailyDigest: "no",
        snoozeMinutes: 7,
      }),
    );
    expect(getReminderPrefs(store)).toEqual(DEFAULT_REMINDER_PREFS);
  });

  it("恢复默认", () => {
    const store = memStore();
    setReminderPrefs({ ...DEFAULT_REMINDER_PREFS, corner: "top-right" }, store);
    resetReminderPrefs(store);
    expect(getReminderPrefs(store)).toEqual(DEFAULT_REMINDER_PREFS);
  });

  it("生成给 Rust 的布局：四角 + 宽度 + 边距", () => {
    const layout = reminderLayoutOf({
      ...DEFAULT_REMINDER_PREFS,
      corner: "top-left",
      width: 340,
    });
    expect(layout).toEqual({
      corner: "top-left",
      width: 340,
      margin: REMINDER_EDGE_MARGIN,
    });
    expect(REMINDER_EDGE_MARGIN).toBeGreaterThan(16);
  });
});
