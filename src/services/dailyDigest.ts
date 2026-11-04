// 1.1.5：每日摘要（原「今日」启动弹窗）的数据组装。
//
// 背景：1.1.5 起，启动 / 跨时段时的「今日」内容不再用居中弹窗打断用户，
// 而是把原弹窗的全部内容（问候 / 日期 / 励志语 / 当前时段事务清单）装进
// 右下角的自定义卡片（kind = "daily"）。
//
// 时段沿用「设置 → 时段分界线」（src/utils/slotBounds.ts）：由 currentClockSlot() 决定当前是
// 早 / 午 / 晚 / 休息；卡片只列「当前时段」的未完成事务，筛选规则与原启动弹窗逐字一致。
import type { Transaction } from "../types/transaction";
import { byOrder } from "../types/transaction";
import type { ClockSlot } from "../utils/clock";
import { dailyQuote } from "../data/quotes";
import { localDateKey } from "../utils/weeklyReview";
import type { ReminderCard } from "./reminderCards";

const WEEK = ["日", "一", "二", "三", "四", "五", "六"];

// 四个时段对应的问候语（原 StartupModal 的 SLOT_GREETING，随组件一并迁入）。
export const SLOT_GREETING: Record<ClockSlot, string> = {
  morning: "早上好",
  noon: "下午好",
  evening: "晚上好",
  rest: "晚安",
};

// 当前时段的任务：未完成 + 分配到该时段（time_slot）+ 属于 Next 主线（原生 next_action 顶层）
// 或凭 show_in_next 透出的外来项（Project 子项 / Waiting / Someday），按 order_index 排序。
// 与原 StartupModal 的筛选完全一致，改规则只改这一处。
export function tasksForClockSlot(
  active: Transaction[],
  slot: ClockSlot,
): Transaction[] {
  if (slot === "rest") return [];
  return active
    .filter(
      (t) =>
        t.status !== "completed" &&
        ((t.category === "next_action" && t.parent_id === null) ||
          t.show_in_next) &&
        t.time_slot === slot,
    )
    .sort(byOrder);
}

// 「今天是 2026年11月3日 星期二」——创建卡片时定格，跨零点也不会和标题打架。
export function dateTextOf(d: Date = new Date()): string {
  return `今天是 ${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 星期${WEEK[d.getDay()]}`;
}

// 组装每日摘要卡。key 按「本地日期 + 时段」去重：同一时段每天只弹一次。
export function dailyCardOf(args: {
  now?: Date;
  slot: ClockSlot;
  active: Transaction[];
}): ReminderCard {
  const now = args.now ?? new Date();
  const tasks = tasksForClockSlot(args.active, args.slot);
  return {
    key: `daily:${localDateKey(now)}:${args.slot}`,
    kind: "daily",
    title: SLOT_GREETING[args.slot],
    slot: args.slot,
    dateText: dateTextOf(now),
    quote: dailyQuote(),
    tasks: tasks.map((t) => t.title),
    count: tasks.length,
  };
}
