// 业务规则收口层（0.1.19）
// 把散落在各列表视图里的「类别迁移规则 / 是否在 Next 展示 / 来源标签」等纯逻辑
// 收拢到一处。视图只管渲染与交互，规则都在这里——以后改做法只翻这一本「食谱」。
import type { Category, DeadlineType, Transaction } from "../types/transaction";
import { byOrder } from "../types/transaction";

// 类别迁移补丁（原 GenericListView.catTarget 的业务核心）：
//   - inbox 禁止互转、拖到自己所在类别无操作：由调用方（视图）早返回拦截，本函数只产补丁；
//   - 原生 next_action 离开 Next：清 parent_id / time_slot / show_in_next（脱离 Next 上下文）；
//   - 1.1.4：任何类别改成顶层 Project → 清 show_in_next + time_slot（父 Project 不作为 Next 项，
//     否则 Waiting/Someday 凭 show_in_next 透出的项改 Project 后仍赖在 Next 里）；
//   - 其余 someday / waiting 互转：仅改 category，保持 show_in_next 与 time_slot 不变。
export function buildCategoryPatch(
  tx: Transaction,
  target: Category,
): Partial<Transaction> & { clear_parent?: boolean } {
  // 类别未变：不产任何补丁，避免下面几条规则误清 show_in_next / time_slot。
  if (tx.category === target) return {};
  if (tx.category === "next_action") {
    return { category: target, clear_parent: true, time_slot: "none", show_in_next: false };
  }
  if (target === "project") {
    return { category: target, show_in_next: false, time_slot: "none" };
  }
  return { category: target };
}

// Next 视图里「加入 Next」按钮何时出现：waiting / someday 透出到全局 Next。
export function canShowInNext(category: Category): boolean {
  return category === "waiting" || category === "someday";
}

// 切换「是否展示在 Next」(show_in_next) 时产出的补丁（NextToggleButton 三处共用）。
// 1.1.4 修复：取消展示时一并清掉 time_slot，否则拖到某时段后取消、下次再展示
// 仍会沿用旧时段直接落回原栏，绕过了「未分配时段」区。
export function nextTogglePatch(willShow: boolean): Partial<Transaction> {
  const patch: Partial<Transaction> = { show_in_next: willShow };
  if (!willShow) patch.time_slot = "none";
  return patch;
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

// A（1.1.3）：父事务改类别离开 Project 时，收集其全部后代 id（不含父自身，含任意层级），
// 用于整棵子树软删进回收站。excludeIds 用于批量移动：排除「同样被选中、要被移动」的后代，
// 使其不被释放、而是随父一起改类别（避免把也选中的子项误删）。
export function collectReleaseIds(
  items: Transaction[],
  parentId: number,
  excludeIds?: number[],
): number[] {
  const all = collectSubtreeIds(items, parentId);
  if (!excludeIds || excludeIds.length === 0) return all;
  const ex = new Set(excludeIds);
  return all.filter((id) => !ex.has(id));
}

// A（1.1.3）：回收站「恢复」护栏——Project 子事务若其所属父事务不在 active（已删 / 已不再是
// Project），单独恢复会变成「孤儿」（子事务只在 Project 视图渲染），应拦截，提示先恢复父事务。
// 返回 true 表示允许单独恢复；false 表示需先恢复所属的 Project 父事务。
export function canRestoreChild(t: Transaction, active: Transaction[]): boolean {
  if (t.parent_id == null) return true; // 顶层事务，随意恢复
  const parent = active.find((p) => p.id === t.parent_id);
  // 父不存在 / 已软删 / 已不是 Project → 不允许单独恢复子项
  return !!parent && parent.category === "project" && !parent.deleted;
}

// ── 1.1.4 新增：编辑弹窗「改为 Project 并选择父事务」 ────────────────

// 可作为父事务的候选：顶层 Project（parent_id 为空）、未完成、非自己。
// items 传 store 的 active（已排除 deleted），这里再加 !deleted 兜底。
export function parentCandidates(items: Transaction[], excludeId?: number): Transaction[] {
  return items
    .filter(
      (t) =>
        t.category === "project" &&
        t.parent_id === null &&
        t.status !== "completed" &&
        !t.deleted &&
        t.id !== excludeId,
    )
    .sort(byOrder);
}

// 挂父补丁：UI 上「类型=Project + 选了父」，落库必须是 next_action + parent_id
// （NowTree 的子事务本就存为 next_action，见 store.addChild）。
// order_index 追加到目标父末尾，避免与新父已有子事务排序交错。
// show_in_next 一律不动；若该条挂父后不再出现在 Next，则清掉时段槽（与 nextTogglePatch 同口径）。
export function attachToParentPatch(
  tx: Transaction,
  parentId: number,
  items: Transaction[],
): Partial<Transaction> {
  const maxIdx = items
    .filter((t) => t.parent_id === parentId)
    .reduce((m, t) => Math.max(m, t.order_index ?? -1), -1);
  const patch: Partial<Transaction> = {
    category: "next_action",
    parent_id: parentId,
    order_index: maxIdx + 1,
  };
  if (!tx.show_in_next) patch.time_slot = "none";
  return patch;
}

// ── 1.1.4 新增：编辑保存的「是否真有改动」判定 ──────────────────────
// 只收录用户可编辑字段；派生字段（time_slot / order_index / reminder_done /
// wait_auto_next / updated_time）不计入——挂父等连带写入不单独触发提示。
export interface TxSnapshot {
  title: string;
  note: string | null;
  category: Category | null;
  priority: number | null;
  deadline_type: DeadlineType;
  deadline_date: string | null;
  reminder_time: string | null;
  parent_id: number | null;
}

export function txSnapshotOf(tx: Transaction): TxSnapshot {
  return {
    title: tx.title,
    note: tx.note,
    category: tx.category,
    priority: tx.priority,
    deadline_type: tx.deadline_type,
    deadline_date: tx.deadline_date,
    reminder_time: tx.reminder_time,
    parent_id: tx.parent_id,
  };
}

// 归一化后逐字段比较：
// - note：两侧 (x ?? "").trim() || null，避免「空串 vs null」误判为改动
// - priority：两侧 ?? 1，兼容老数据 priority=null（表单初值本就是 1，不该算改动）
// - reminder_time：两侧 || null
// - 其余严格 ===
export function isSameSnapshot(a: TxSnapshot, b: TxSnapshot): boolean {
  const note = (x: string | null) => (x ?? "").trim() || null;
  return (
    a.title === b.title &&
    note(a.note) === note(b.note) &&
    a.category === b.category &&
    (a.priority ?? 1) === (b.priority ?? 1) &&
    a.deadline_type === b.deadline_type &&
    a.deadline_date === b.deadline_date &&
    (a.reminder_time || null) === (b.reminder_time || null) &&
    a.parent_id === b.parent_id
  );
}
