// 列表视图共用的「工具栏动作」收口（0.1.20，B3 重构）。
// GenericListView / NextView / ProjectListView 三处 cleanCompleted / batchDelete /
// moveTo 逻辑逐字重复，仅「已完成 id 来源」「删除方式（inbox 走 removeInbox
// 还是类别走 deleteTx）」「移动拦截（Project 含子父事务不可移动）」有差异。
// 把不变的部分（加载回收站、清空选择、写回 store）收进本 hook，
// 差异点由各视图以回调注入，既消除重复又保留各自语义。
//
// 1.1.6：一键清理 / 批量删除去掉「二次确认」，改成点了就删 + toast 撤销条。
// 删除仍是软删进回收站，撤销 = restoreMany；但软删会级联后代、restore 不级联，
// 所以删除前先用 collectUndoIds 记下「根 + 整棵子树」，撤销时一起恢复。
import { useTxStore } from "../store/useTxStore";
import type { Category } from "../types/transaction";
import { buildCategoryPatch, collectUndoIds } from "../services/transactionService";
import { playClearSound } from "../utils/clearSound";
import { showToast } from "../toast";

export interface ListActionsConfig {
  selected: Set<number>;
  setSelected: (s: Set<number>) => void;
  selMode: boolean;
  setSelMode: (b: boolean) => void;
  // 选中「已完成」的 id（各视图语义不同：Project 含子事务）。
  getCompletedIds: () => number[];
  // 对一组 id 执行删除（Generic：区分 inbox/类别；Next/Project：直接 deleteTx 列表）。
  deleteSelected: (ids: number[]) => Promise<void>;
  // 移动前拦截：返回 { movable, blocked }（如 Project 过滤含子的父事务）。
  filterMovable?: (ids: number[]) => { movable: number[]; blocked: number[] };
  // 移动后回调（如 Project 设置「含子事务无法移动」提示）。
  onMoved?: (blocked: number[]) => void;
}

export function useListActions(cfg: ListActionsConfig) {
  const { reorder, updateTx, loadTrash, active, inbox, releaseDescendants, restoreMany } =
    useTxStore();

  // 1.1.5：每次渲染都实时取「当前已完成 id」，按钮可用性 / 清理范围都读它，
  // 避免确认态期间数据集变化导致「数字与实际删除范围不一致」。
  // 1.1.6 去掉确认态后仍保留实时口径：点下去那一刻才算数。
  const completedIds = cfg.getCompletedIds();

  // 排序：各视图保留自己的比较器（Project 完成度排序不同），只统一最后的 reorder 调用。
  function applySort(sortedIds: number[]) {
    reorder(sortedIds);
  }

  // 删除 + 撤销条（1.1.6）：先把「根 + 整棵子树」记下来再删，删完 toast 给 5 秒撤销窗口。
  // undoIds 必须在删除前算：软删后 active 里那些后代的父子关系已经查不到了。
  async function deleteWithUndo(ids: number[], verb: "清理" | "删除") {
    if (ids.length === 0) return;
    const undoIds = collectUndoIds([...active, ...inbox], ids);
    await cfg.deleteSelected(ids);
    await loadTrash();
    cfg.setSelected(new Set());
    showToast(`已${verb} ${ids.length} 项`, {
      label: "撤销",
      onClick: () => {
        // 撤销成功后把提示条换成「已恢复」；失败（如库被占用）给可执行的下一步，
        // 而不是让用户对着没反应的提示条发呆。
        void (async () => {
          try {
            await restoreMany(undoIds);
            showToast(`已恢复 ${ids.length} 项`);
          } catch {
            showToast("撤销失败，请到回收站里手动恢复");
          }
        })();
      },
    });
  }

  // 一键清理：点了就删全部已完成（1.1.6 去掉二次确认）。
  async function cleanCompleted() {
    const ids = cfg.getCompletedIds(); // 删除那一刻实时取，绝不用上一次渲染的旧值
    if (ids.length === 0) return;
    await deleteWithUndo(ids, "清理");
    playClearSound(); // 1.0.3：清理音（受全局音效开关控制）
  }

  // 批量删除：同样点了就删（1.1.6 去掉二次确认），删完退出多选。
  async function batchDelete() {
    const ids = [...cfg.selected];
    if (ids.length === 0) return;
    await deleteWithUndo(ids, "删除");
    cfg.setSelMode(false);
  }

  // 移动到其它类别：先按 filterMovable 过滤（如 Project 已不再拦截含子的父事务），
  // 再批量改类。A(1.1.3)：含子父事务随移动离开 Project 时，整棵子树先释放进回收站
  // （排除同样被选中的后代，使其随父一起改类别而非被删），仅当目标类别≠project 才释放。
  async function moveTo(target: Category) {
    const ids = [...cfg.selected];
    let movable = ids;
    let blocked: number[] = [];
    if (cfg.filterMovable) {
      const r = cfg.filterMovable(ids);
      movable = r.movable;
      blocked = r.blocked;
    }
    if (movable.length === 0) {
      if (cfg.onMoved) cfg.onMoved(blocked);
      return;
    }
    // A（1.1.3）：含子父事务离开 Project → 先释放整棵子树（排除同样被选中的后代）
    let releasedTotal = 0;
    if (target !== "project") {
      for (const id of movable) {
        const hasKids = active.some((t) => t.parent_id === id);
        if (hasKids) {
          const released = await releaseDescendants(id, movable);
          releasedTotal += released.length;
        }
      }
    }
    for (const id of movable) {
      // 1.1.4：与拖拽 / 编辑弹窗共用同一套类别迁移规则——改成顶层 Project 时一并清
      // show_in_next + time_slot（父 Project 不作为 Next 项）。
      const t = active.find((x) => x.id === id);
      await updateTx(id, t ? buildCategoryPatch(t, target) : { category: target, clear_parent: true });
    }
    if (releasedTotal > 0) showToast(`已释放 ${releasedTotal} 个子事务进入回收站`);
    cfg.setSelected(new Set());
    cfg.setSelMode(false);
    if (cfg.onMoved) cfg.onMoved(blocked);
  }

  return { applySort, cleanCompleted, batchDelete, moveTo, completedIds };
}
