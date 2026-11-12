// 1.1.5：提醒投递 seam（替代原来的系统通知 seam notification.ts）。
// 主窗口（React）不再直接调用 OS 通知，而是把「卡片」交给 Rust：由 Rust 创建 / 复用
// 右下角无边框置顶窗口 reminder，并把卡片事件推给该窗口渲染。
// 抽成 seam 的理由与原 notification.ts 相同：UI 不依赖具体投递方式，将来换实现只改这里。
//
// 非 Tauri 环境（纯浏览器预览 / 单测）没有窗口能力，静默跳过，不影响主流程。
import { invoke } from "@tauri-apps/api/core";
import type { Transaction } from "../types/transaction";
import type { ReminderCard } from "./reminderCards";
import { localDateKey } from "../utils/weeklyReview";
import { getReminderPrefs, reminderLayoutOf, type ReminderPrefs } from "../utils/reminderPrefs";
import { isTauri } from "../utils/isTauri";

const SNOOZE_MINUTES = 5;

// 把一批卡片交给 Rust：没有窗口则创建，已存在则追加/替换后重新显示。
// 返回 true 表示已投递；false 表示「弹窗通知被关闭」或非 Tauri 环境（调用方据此决定是否写去重标记）。
// 布局（四角位置 / 宽度 / 边距）随每次投递一起带给 Rust——偏好改了，下一次弹窗就生效。
// prefsOverride 供设置里的「预览」用草稿值（不落盘）先行试看。
export async function pushReminderCards(
  cards: ReminderCard[],
  prefsOverride?: ReminderPrefs,
): Promise<boolean> {
  if (cards.length === 0) return false;
  const prefs = prefsOverride ?? getReminderPrefs();
  if (!prefs.enabled) return false;
  if (!isTauri()) return false;
  await invoke("show_reminder_cards", { cards, layout: reminderLayoutOf(prefs) });
  return true;
}

// 事务提醒卡：一条事务一张卡，key 用 task:<id> 保证同一事务不会重复堆卡。
export function reminderCardOf(tx: Transaction): ReminderCard {
  return {
    key: `task:${tx.id}`,
    kind: "task",
    id: tx.id,
    title: tx.title,
    note: tx.note ?? null,
  };
}

// Inbox 每周回顾卡：key 按本地日期，一天最多一张。
export function weeklyReviewCard(inboxCount: number, now: Date = new Date()): ReminderCard {
  return {
    key: `review:${localDateKey(now)}`,
    kind: "review",
    title: "该整理 Inbox 了",
    note:
      inboxCount > 0
        ? `还有 ${inboxCount} 条灵感等着被整理成下一步。`
        : "把攒下的灵感整理成下一步吧。",
    count: inboxCount,
  };
}

// 设置 → 弹窗个性化 → 「预览」用的实验卡：内容固定，只用来检查样式 / 位置 / 宽度。
export function reminderPreviewCard(): ReminderCard {
  return {
    key: "preview:test",
    kind: "task",
    title: "测试事务",
    note: "这是一条实验弹窗，用来预览提醒卡的样式、位置与宽度。",
    preview: true,
  };
}

// Date → 本地 `datetime-local` 字符串（YYYY-MM-DDTHH:MM），与编辑弹窗的存储格式一致。
export function localDateTimeValue(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(
    d.getHours(),
  )}:${pad(d.getMinutes())}`;
}

// 「稍后提醒」目标时间：默认 10 分钟后，返回本地 datetime-local 字符串。
export function snoozeTargetValue(
  now: Date = new Date(),
  minutes: number = SNOOZE_MINUTES,
): string {
  return localDateTimeValue(new Date(now.getTime() + minutes * 60_000));
}

export { SNOOZE_MINUTES };
