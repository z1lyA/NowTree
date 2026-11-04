import { describe, it, expect } from "vitest";
import type { Transaction } from "../types/transaction";
import { dailyCardOf, dateTextOf, tasksForClockSlot } from "./dailyDigest";

function mk(p: Partial<Transaction>): Transaction {
  return {
    id: 1,
    title: "t",
    note: null,
    category: "next_action",
    status: "active",
    deadline_type: "none",
    deadline_date: null,
    priority: null,
    created_time: "2026-01-01T00:00:00.000Z",
    completed_time: null,
    updated_time: null,
    parent_id: null,
    show_in_next: false,
    deleted: false,
    order_index: null,
    reminder_time: null,
    reminder_done: 0,
    time_slot: "none",
    sync_id: null,
    deleted_at: null,
    wait_auto_next: false,
    ...p,
  };
}

describe("tasksForClockSlot", () => {
  it("只取当前时段、未完成、属于 Next 主线或 show_in_next 的项", () => {
    const items = [
      mk({ id: 1, title: "原生 next_action 早", time_slot: "morning" }),
      mk({ id: 2, title: "waiting 透出早", category: "waiting", time_slot: "morning", show_in_next: true }),
      mk({ id: 3, title: "已完成", time_slot: "morning", status: "completed" }),
      mk({ id: 4, title: "午时段", time_slot: "noon" }),
      mk({ id: 5, title: "子事务未透出", parent_id: 9, time_slot: "morning" }),
      mk({ id: 6, title: "someday 未透出", category: "someday", time_slot: "morning" }),
    ];
    expect(tasksForClockSlot(items, "morning").map((t) => t.id)).toEqual([1, 2]);
    expect(tasksForClockSlot(items, "noon").map((t) => t.id)).toEqual([4]);
  });

  it("按 order_index 排序（未设置的按 created_time 兜底）", () => {
    const items = [
      mk({ id: 1, title: "b", time_slot: "morning", order_index: 1 }),
      mk({ id: 2, title: "a", time_slot: "morning", order_index: 0 }),
      mk({ id: 3, title: "c", time_slot: "morning", order_index: null, created_time: "2025-01-01T00:00:00.000Z" }),
    ];
    expect(tasksForClockSlot(items, "morning").map((t) => t.id)).toEqual([2, 1, 3]);
  });

  it("rest 时段不列任务", () => {
    expect(tasksForClockSlot([mk({ time_slot: "morning" })], "rest")).toEqual([]);
  });
});

describe("dateTextOf", () => {
  it("输出中文日期与星期", () => {
    expect(dateTextOf(new Date(2026, 10, 3, 10, 0))).toBe("今天是 2026年11月3日 星期二");
  });
});

describe("dailyCardOf", () => {
  const now = new Date(2026, 10, 3, 10, 0); // 周二早上

  it("按日期 + 时段生成 key，并带问候 / 日期 / 引语 / 清单", () => {
    const active = [
      mk({ id: 1, title: "写周报", time_slot: "morning" }),
      mk({ id: 2, title: "回邮件", time_slot: "morning" }),
    ];
    const card = dailyCardOf({ now, slot: "morning", active });
    expect(card.key).toBe("daily:2026-11-03:morning");
    expect(card.kind).toBe("daily");
    expect(card.title).toBe("早上好");
    expect(card.slot).toBe("morning");
    expect(card.dateText).toBe("今天是 2026年11月3日 星期二");
    expect(card.tasks).toEqual(["写周报", "回邮件"]);
    expect(card.count).toBe(2);
    expect(typeof card.quote).toBe("string");
    expect(card.quote!.length).toBeGreaterThan(0);
  });

  it("空时段也给一张卡（暂无安排），供 UI 显示", () => {
    const card = dailyCardOf({ now, slot: "noon", active: [] });
    expect(card.tasks).toEqual([]);
    expect(card.count).toBe(0);
    expect(card.title).toBe("下午好");
  });

  it("rest 时段生成晚安卡", () => {
    const card = dailyCardOf({ now: new Date(2026, 10, 3, 2, 0), slot: "rest", active: [] });
    expect(card.title).toBe("晚安");
    expect(card.key).toBe("daily:2026-11-03:rest");
    expect(card.tasks).toEqual([]);
  });
});
