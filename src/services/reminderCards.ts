// 1.1.5：右下角提醒卡片的纯数据与队列规则（不依赖 React / Tauri，可单测）。
//
// 一套卡片模型供三种场景共用：
//   - task   事务提醒（每条事务独占一张卡，绝不把多条事务塞进一张卡）
//   - review Inbox 每周回顾
//   - daily  每日摘要（原「今日」启动弹窗的内容整体移入卡片）
//
// key 是去重与移除的唯一标识：
//   task:<id> / review:<本地日期> / daily:<本地日期>:<slot>
// 语言无关，主窗口与提醒窗口共用同一份规则。

export type ReminderKind = "task" | "review" | "daily";
export type ReminderSlot = "morning" | "noon" | "evening" | "rest";

export interface ReminderCard {
  key: string;
  kind: ReminderKind;
  // task 卡对应的事务 id（review / daily 为 null）
  id?: number | null;
  title: string;
  // task 卡展示的备注
  note?: string | null;
  // daily 卡：当前时段的事务标题（按 order_index 顺序）
  tasks?: string[];
  // review 卡：Inbox 待整理条数
  count?: number | null;
  // daily 卡：当前钟点所属时段
  slot?: ReminderSlot | null;
  // daily 卡：当日励志语
  quote?: string | null;
  // daily 卡：日期文案（创建时刻定格，避免跨零点后卡片与标题不一致）
  dateText?: string | null;
  // 设置里的「预览」实验卡：只展示样式，不提供完成 / 稍后（只有关闭）
  preview?: boolean;
}

// 合并新卡片到当前队列：
//  - 同 key 不重复入列（主窗口重扫、窗口重建取 pending 时可能重复投递）；
//  - daily 卡全局唯一：新的 daily 卡到来时先移除旧的，避免早上/中午两张卡同时挂着。
export function mergeCards(
  current: ReminderCard[],
  incoming: ReminderCard[],
): ReminderCard[] {
  const hasDaily = incoming.some((c) => c.kind === "daily");
  const base = hasDaily ? current.filter((c) => c.kind !== "daily") : current;
  const seen = new Set(base.map((c) => c.key));
  const out = [...base];
  for (const card of incoming) {
    if (seen.has(card.key)) continue;
    seen.add(card.key);
    out.push(card);
  }
  return out;
}

// 移除某张卡片（用户点关闭 / 完成 / 稍后 / 去整理后）。
export function removeCard(current: ReminderCard[], key: string): ReminderCard[] {
  return current.filter((c) => c.key !== key);
}
