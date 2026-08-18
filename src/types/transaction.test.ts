import { describe, it, expect } from "vitest";
import {
  normalizeDeadline,
  resolveDeadline,
  byOrder,
  byPriority,
  byCompletion,
  byTime,
  deadlineEndTime,
  isDeadlineOverdue,
  deadlineOptionLabel,
  type Transaction,
} from "./transaction";

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

describe("normalizeDeadline", () => {
  it("把今天的具体日期归一成今日", () => {
    const today = new Date();
    const d = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(
      today.getDate(),
    ).padStart(2, "0")}`;
    const r = normalizeDeadline("date", d, today);
    expect(r.type).toBe("today");
    expect(r.date).toBeNull();
  });
  it("非今天的日期保持原样", () => {
    const r = normalizeDeadline("date", "2030-05-20", new Date("2026-01-01"));
    expect(r.type).toBe("date");
    expect(r.date).toBe("2030-05-20");
  });
  it("非 date 类型原样返回", () => {
    const r = normalizeDeadline("week", null);
    expect(r.type).toBe("week");
  });
  it("1.1.1：明天——锚点日=今天时归一成今日", () => {
    const today = new Date();
    const d = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
    const r = normalizeDeadline("tomorrow", d, today);
    expect(r.type).toBe("today");
    expect(r.date).toBeNull();
  });
  it("1.1.1：下周——锚点日=本周周日时归一成本周", () => {
    const base = new Date(2026, 7, 19, 10, 0, 0); // 2026-08-19 周三，本周周日=2026-08-23
    const r = normalizeDeadline("next_week", "2026-08-23", base);
    expect(r.type).toBe("week");
    expect(r.date).toBeNull();
  });
});

describe("排序比较器", () => {
  it("byOrder：有 order_index 的排前面并升序，其余按 created_time", () => {
    const a = mk({ id: 1, order_index: 2, created_time: "2026-01-01" });
    const b = mk({ id: 2, order_index: null, created_time: "2026-01-02" });
    const c = mk({ id: 3, order_index: 1, created_time: "2026-01-03" });
    const sorted = [a, b, c].sort(byOrder);
    expect(sorted.map((t) => t.id)).toEqual([3, 1, 2]);
  });
  it("byPriority：高优先在前，同优先回退 byOrder（null 视为最低 0）", () => {
    const lo = mk({ id: 1, priority: 1, order_index: 0 });
    const hi = mk({ id: 2, priority: 5, order_index: 1 });
    const nu = mk({ id: 3, priority: null, order_index: 2 });
    const sorted = [lo, hi, nu].sort(byPriority);
    expect(sorted.map((t) => t.id)).toEqual([2, 1, 3]);
  });
  it("byCompletion：未完成在前，已完成在后", () => {
    const done = mk({ id: 1, status: "completed" });
    const active = mk({ id: 2, status: "active" });
    const sorted = [done, active].sort(byCompletion);
    expect(sorted.map((t) => t.id)).toEqual([2, 1]);
  });
});

describe("截止时间 / 逾期", () => {
  it("byTime：无时间要求的排最后", () => {
    const none = mk({ id: 1, deadline_type: "none" });
    const today = mk({ id: 2, deadline_type: "today" });
    const sorted = [none, today].sort(byTime);
    expect(sorted[0].id).toBe(2);
  });
  it("deadlineEndTime：today 取当天 23:59:59.999", () => {
    const base = new Date(2026, 0, 15, 10, 0, 0);
    const end = deadlineEndTime("today", null, base)!;
    expect(end.getFullYear()).toBe(2026);
    expect(end.getMonth()).toBe(0);
    expect(end.getDate()).toBe(15);
    expect(end.getHours()).toBe(23);
    expect(end.getMinutes()).toBe(59);
  });
  it("isDeadlineOverdue：未完成且已越过具体日期截止→true；已完成/未到→false", () => {
    const base = new Date(2026, 0, 21, 12, 0, 0); // 2026-01-21 中午
    const past = mk({ id: 1, deadline_type: "date", deadline_date: "2026-01-10", status: "active" });
    const done = mk({ id: 2, deadline_type: "date", deadline_date: "2026-01-10", status: "completed" });
    const future = mk({ id: 3, deadline_type: "month", status: "active" }); // 当月 1-31 月底，晚于 base
    expect(isDeadlineOverdue(past, base)).toBe(true);
    expect(isDeadlineOverdue(done, base)).toBe(false);
    expect(isDeadlineOverdue(future, base)).toBe(false);
  });

  // 回归：相对截止日必须锚定「创建时刻」，否则跨月后永不逾期（#本月不过期）
  it("isDeadlineOverdue：本月锚定创建月，跨月后应逾期", () => {
    const created = new Date(2026, 7, 5, 9, 0, 0).toISOString(); // 2026-08-05 创建、选本月
    const now = new Date(2026, 8, 2, 10, 0, 0); // 2026-09-02（已过 8 月）
    const t = mk({ id: 1, deadline_type: "month", status: "active", created_time: created });
    expect(isDeadlineOverdue(t, now)).toBe(true);
  });
  it("isDeadlineOverdue：本月内（创建当月）不逾期", () => {
    const created = new Date(2026, 7, 5, 9, 0, 0).toISOString();
    const now = new Date(2026, 7, 20, 10, 0, 0); // 仍在 8 月
    const t = mk({ id: 1, deadline_type: "month", status: "active", created_time: created });
    expect(isDeadlineOverdue(t, now)).toBe(false);
  });
  it("isDeadlineOverdue：本周锚定创建周，跨周后逾期", () => {
    const created = new Date(2026, 7, 3, 9, 0, 0).toISOString(); // 创建当周
    const now = new Date(2026, 7, 11, 10, 0, 0); // 创建周之后
    const t = mk({ id: 1, deadline_type: "week", status: "active", created_time: created });
    expect(isDeadlineOverdue(t, now)).toBe(true);
  });
  it("isDeadlineOverdue：今日锚定创建日，跨天后逾期", () => {
    const created = new Date(2026, 7, 5, 9, 0, 0).toISOString(); // 当日创建
    const now = new Date(2026, 7, 6, 10, 0, 0); // 次日
    const t = mk({ id: 1, deadline_type: "today", status: "active", created_time: created });
    expect(isDeadlineOverdue(t, now)).toBe(true);
  });

  // 回归：byTime 同样锚定创建时刻，跨月后更早截止的排更前（更紧急）
  it("byTime：本月任务锚定创建月，跨月后更早创建的排更前", () => {
    const aug = mk({ id: 1, deadline_type: "month", created_time: new Date(2026, 7, 5).toISOString() });
    const sep = mk({ id: 2, deadline_type: "month", created_time: new Date(2026, 8, 5).toISOString() });
    const sorted = [sep, aug].sort(byTime);
    expect(sorted[0].id).toBe(1); // aug 截止 8.31 比 sep 截止 9.30 更紧急
  });

  // 1.0.2：相对截止日锚定 deadline_date（最后修改时间要求那一刻），而非创建时刻
  it("resolveDeadline：相对类型把锚点日期写入 deadline_date", () => {
    const base = new Date(2026, 7, 3, 12, 0, 0); // 2026-08-03（周一）
    expect(resolveDeadline("today", null, base)).toEqual({ type: "today", date: "2026-08-03" });
    expect(resolveDeadline("week", null, base)).toEqual({ type: "week", date: "2026-08-09" }); // 8.3 那周周日
    expect(resolveDeadline("month", null, base)).toEqual({ type: "month", date: "2026-08-31" });
    expect(resolveDeadline("date", "2026-09-10", base)).toEqual({ type: "date", date: "2026-09-10" });
    expect(resolveDeadline("none", null, base)).toEqual({ type: "none", date: null });
  });
  it("1.1.1：resolveDeadline——明天解出明天日期", () => {
    const base = new Date(2026, 7, 17, 12, 0, 0); // 2026-08-17 周一
    expect(resolveDeadline("tomorrow", null, base)).toEqual({ type: "tomorrow", date: "2026-08-18" });
  });
  it("1.1.1：resolveDeadline——下周解出下周周日（本周周日+7）", () => {
    const base = new Date(2026, 7, 17, 12, 0, 0); // 2026-08-17 周一，本周周日=2026-08-23，下周周日=2026-08-30
    expect(resolveDeadline("next_week", null, base)).toEqual({ type: "next_week", date: "2026-08-30" });
  });
  it("isDeadlineOverdue：today 锚定 deadline_date，与创建时刻无关", () => {
    const created = new Date(2026, 0, 1).toISOString(); // 很早创建
    const now = new Date(2026, 7, 5, 10, 0, 0); // 8.5
    const today = mk({ id: 1, deadline_type: "today", created_time: created, deadline_date: "2026-08-05" });
    expect(isDeadlineOverdue(today, now)).toBe(false); // 锚点=当天，今天内不逾期
    const overdue = mk({ id: 2, deadline_type: "today", created_time: created, deadline_date: "2026-08-01" });
    expect(isDeadlineOverdue(overdue, now)).toBe(true); // 锚点=8.1，现在 8.5 已逾期
  });
  it("isDeadlineOverdue：week 锚定 deadline_date 所在周的周日", () => {
    const created = new Date(2026, 0, 1).toISOString();
    const t = mk({ id: 1, deadline_type: "week", created_time: created, deadline_date: "2026-08-09" });
    expect(isDeadlineOverdue(t, new Date(2026, 7, 9, 10, 0, 0))).toBe(false); // 周日内
    expect(isDeadlineOverdue(t, new Date(2026, 7, 10, 10, 0, 0))).toBe(true); // 次周一越过周日
  });
  it("isDeadlineOverdue：month 锚定 deadline_date 所在月月底", () => {
    const created = new Date(2026, 0, 1).toISOString();
    const t = mk({ id: 1, deadline_type: "month", created_time: created, deadline_date: "2026-07-31" });
    expect(isDeadlineOverdue(t, new Date(2026, 7, 2, 10, 0, 0))).toBe(true); // 7 月底锚点，8.2 已逾
  });
  it("byTime：优先取 deadline_date 锚点排序", () => {
    const created = new Date(2026, 0, 1).toISOString();
    const early = mk({ id: 1, deadline_type: "month", created_time: created, deadline_date: "2026-07-31" });
    const late = mk({ id: 2, deadline_type: "month", created_time: created, deadline_date: "2026-08-31" });
    const sorted = [late, early].sort(byTime);
    expect(sorted[0].id).toBe(1); // early(7.31) 比 late(8.31) 更紧急
  });
});

describe("deadlineOptionLabel", () => {
  it("today 带中文日期", () => {
    const base = new Date(2026, 0, 15);
    expect(deadlineOptionLabel("today", base)).toContain("今日");
  });
  it("none 返回 无", () => {
    expect(deadlineOptionLabel("none")).toBe("无");
  });
});
