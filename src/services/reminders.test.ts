import { describe, it, expect } from "vitest";
import type { Transaction } from "../types/transaction";
import {
  localDateTimeValue,
  reminderCardOf,
  reminderPreviewCard,
  snoozeTargetValue,
  weeklyReviewCard,
} from "./reminders";

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

describe("localDateTimeValue", () => {
  it("输出本地 datetime-local 字符串（补零）", () => {
    expect(localDateTimeValue(new Date(2026, 10, 3, 9, 5))).toBe("2026-11-03T09:05");
    expect(localDateTimeValue(new Date(2026, 0, 1, 0, 0))).toBe("2026-01-01T00:00");
  });
});

describe("snoozeTargetValue", () => {
  it("默认 +5 分钟（与「稍后」默认时长一致），可跨天", () => {
    expect(snoozeTargetValue(new Date(2026, 10, 3, 23, 55))).toBe("2026-11-04T00:00");
    expect(snoozeTargetValue(new Date(2026, 10, 3, 8, 0), 30)).toBe("2026-11-03T08:30");
  });
});

describe("reminderCardOf", () => {
  it("一条事务一张卡，key 用 task:<id>", () => {
    const card = reminderCardOf(mk({ id: 7, title: "交房租", note: "本月最后一天" }));
    expect(card.key).toBe("task:7");
    expect(card.kind).toBe("task");
    expect(card.id).toBe(7);
    expect(card.title).toBe("交房租");
    expect(card.note).toBe("本月最后一天");
  });

  it("备注为空时保持 null", () => {
    expect(reminderCardOf(mk({ id: 8, note: null })).note).toBeNull();
  });
});

describe("weeklyReviewCard", () => {
  it("按本地日期生成 key，并带上 Inbox 数量", () => {
    const card = weeklyReviewCard(3, new Date(2026, 10, 3, 10, 0));
    expect(card.key).toBe("review:2026-11-03");
    expect(card.kind).toBe("review");
    expect(card.count).toBe(3);
    expect(card.note).toContain("3");
  });

  it("Inbox 为空时仍可预览（文案不出现 0 条）", () => {
    const card = weeklyReviewCard(0, new Date(2026, 10, 3, 10, 0));
    expect(card.count).toBe(0);
    expect(card.note).not.toContain("0 条");
  });
});

describe("reminderPreviewCard", () => {
  it("设置里的预览卡：固定测试内容、标记 preview、无事务 id", () => {
    const card = reminderPreviewCard();
    expect(card.kind).toBe("task");
    expect(card.preview).toBe(true);
    expect(card.id ?? null).toBeNull();
    expect(card.title).toBe("测试事务");
    expect(card.key).toBe("preview:test");
    expect(card.note).toContain("实验弹窗");
  });
});
