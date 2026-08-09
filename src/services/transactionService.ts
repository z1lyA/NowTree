// 业务规则收口层（0.1.19）
// 把散落在各列表视图里的「类别迁移规则 / 是否在 Next 展示 / 来源标签」等纯逻辑
// 收拢到一处。视图只管渲染与交互，规则都在这里——以后改做法只翻这一本「食谱」。
import type { Category, Transaction } from "../types/transaction";
import { byOrder } from "../types/transaction";

// 类别迁移补丁（原 GenericListView.catTarget 的业务核心）：
//   - inbox 禁止互转、拖到自己所在类别无操作：由调用方（视图）早返回拦截，本函数只产补丁；
//   - 原生 next_action 离开 Next：清 parent_id / time_slot / show_in_next（脱离 Next 上下文）；
//   - someday / waiting 改类别：仅改 category，保持 show_in_next 与 time_slot 不变。
export function buildCategoryPatch(
  tx: Transaction,
  target: Category,
): Partial<Transaction> & { clear_parent?: boolean } {
  // 1.1.0：转成 habit 时——清 priority（habits 无优先级，与新建 habit 默认 1 一致，修复
  // 「拖入保留旧 priority / 新建=1」的数据不一致）、清 show_in_next + time_slot（否则被
  // 1.0.2 自动晋升的 waiting 拖进来后仍残留在 Next）、清 wait_auto_next（1.0.2 晋升标记，
  // 对 habit 无意义、留着是死数据）、清 deadline（时间要求对 habit 用不上）、清 parent_id（habit 不分层）。
  if (target === "habit") {
    return { category: "habit", priority: 1, show_in_next: false, time_slot: "none", wait_auto_next: false, deadline_type: "none", deadline_date: null, clear_parent: true };
  }
  if (tx.category === "next_action") {
    return { category: target, clear_parent: true, time_slot: "none", show_in_next: false };
  }
  return { category: target };
}

// Next 视图里「加入 Next」按钮何时出现：waiting / someday 透出到全局 Next。
export function canShowInNext(category: Category): boolean {
  return category === "waiting" || category === "someday";
}

// Next 行内「来源」标签（Project 子项 / Waiting / Someday 凭 show_in_next 透出）。
export function sourceText(t: Transaction): string | null {
  if (t.parent_id) return "来源：Project";
  if (t.category === "waiting") return "来源：Waiting";
  if (t.category === "someday") return "来源：Someday";
  return null;
}

// 某父事务的直接子事务（按 order 排序）——从传入的事务集合中筛选（C5：原在 ProjectListView
// 内联，属 service 职责，移出后视图只调用，避免 Feature Envy）。
export function childrenOf(items: Transaction[], pid: number): Transaction[] {
  return items.filter((t) => t.parent_id === pid).sort(byOrder);
}

// 收集 rootId 的全部后代 id（向下，任意层级），不含 root 自身（B5：store 删除/彻底删除时在
// 本地缓存里移除整棵子树用；DB 级联已由后端 adapter 承担，store 不再重写遍历算法）。
export function collectSubtreeIds(items: Transaction[], rootId: number): number[] {
  const out: number[] = [];
  const stack = [rootId];
  while (stack.length) {
    const cur = stack.pop()!;
    for (const t of items) {
      if (t.parent_id === cur) {
        out.push(t.id);
        stack.push(t.id);
      }
    }
  }
  return out;
}

// 父事务完成度：有子事务→已完成子事务占比(0~1)；无子事务→自身是否完成(0/1)。
// 同样只依赖传入的事务集合，不触碰视图的 active 状态（C5）。
export function parentDoneRatioOf(p: Transaction, items: Transaction[]): number {
  const kids = childrenOf(items, p.id);
  if (kids.length === 0) return p.status === "completed" ? 1 : 0;
  return kids.filter((k) => k.status === "completed").length / kids.length;
}
