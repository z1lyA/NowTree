// Project 树状视图：把 Project 渲染成树。
// - 顶层：category=project 且 parent_id=null 的项目；
// - 嵌套子事务（parent_id=项目 id）；
// - 子事务可「加入 Next / 移出 Next」；
// - 项目与子事务都带「完成」勾选框，勾选后划线虚化、不消失（与全局 Next 同步，同一条记录）。
// - 完成后再显示「删除/归档」按钮，快捷删除。
// 0.1.10：新增「多选」模式（批量删除 / 批量移动到其他三类）、列表排序工具栏。
// 0.1.11：排序改为「一次性整理」按钮；多选与排序并入同一紧凑工具栏。
// 0.1.16：
//   - 子事务可收起：默认收起，点击父标题/箭头切换展开或收起；
//   - 所有备注默认一行收起，点击展开，点其它地方自动收起；
//   - Project 子事务编辑隐藏「类型」选项；
//   - 「加子步骤」改为「批量添加子事项」（连续弹窗，逐个生成子事项直至退出）；
//   - 布局修复：父事务行右侧工具栏不再挤压子列表，子列表可拉到最右边。
import { useEffect, useMemo, useRef, useState } from "react";
import { useTxStore } from "../store/useTxStore";
import type { Transaction } from "../types/transaction";
import { byOrder, byPriority, byTime, byCompletion, CAT_MAP } from "../types/transaction";
import { buildCategoryPatch } from "../services/transactionService";
import EditModal from "./EditModal";
import AddChildModal from "./AddChildModal";
import AddModal from "./AddModal";
import Fab from "./Fab";
import { useListDrag } from "../hooks/useListDrag";
import { showToast } from "../toast";
import { useNoteExpand } from "../hooks/useNoteExpand";
import { useSelection } from "../hooks/useSelection";
import TxRow, { TxGutter, TxMain } from "./TxRow";
import DragGhost from "./DragGhost";
import ListToolbar from "./ListToolbar";
import { useListActions } from "../hooks/useListActions";
import { childrenOf as svcChildrenOf, parentDoneRatioOf } from "../services/transactionService";

// 各视图共用的常量（CATEGORIES / CAT_MAP）已收敛到 types/transaction.ts（0.1.20）。

export default function ProjectListView() {
  const { active, loading, error, loadActive, updateTx, toggleComplete, deleteTx, reorder } =
    useTxStore();
  const [editing, setEditing] = useState<Transaction | null>(null);
  // 0.1.16：子事务编辑隐藏「类型」——记录当前编辑项是否为子事务
  const [editingChild, setEditingChild] = useState(false);
  // 0.1.16：批量添加子事项——当前正在批量添加的父事务 id（null 表示未开启）
  const [batchFor, setBatchFor] = useState<number | null>(null);
  const [deletingId, setDeletingId] = useState<number | null>(null);
  const [adding, setAdding] = useState(false);
  const [clearConfirm, setClearConfirm] = useState(false);
  // 0.1.13：每个父事务可单独对其子事务排序；childSortFor 记录当前展开子排序菜单的父事务 id
  const [childSortFor, setChildSortFor] = useState<number | null>(null);
  const [moveHint, setMoveHint] = useState<string>("");
  // 0.1.16：子事务折叠——记录已展开的父事务 id（默认空 = 全部收起）
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const childSortRef = useRef<HTMLDivElement>(null);
  const { dragId, overIdx, overHalf, dragPos, startDrag } = useListDrag();
  // 0.1.16：备注展开/收起（全局落在外自动收起）
  const { expandedNoteId, setExpandedNoteId, containerRef } = useNoteExpand();

  useEffect(() => {
    if (active.length === 0) loadActive();
  }, [active.length, loadActive]);

  // 监听全局「快速新增」事件（App 在按 Enter 时派发）
  useEffect(() => {
    const h = () => setAdding(true);
    window.addEventListener("nowtree:quick-add", h);
    return () => window.removeEventListener("nowtree:quick-add", h);
  }, []);

  // 点击外部关闭子排序下拉
  useEffect(() => {
    if (childSortFor === null) return;
    const onClick = (e: MouseEvent) => {
      const target = e.target as Node;
      if (childSortRef.current && !childSortRef.current.contains(target))
        setChildSortFor(null);
    };
    document.addEventListener("pointerdown", onClick);
    return () => document.removeEventListener("pointerdown", onClick);
  }, [childSortFor]);

  const projects = active.filter(
    (t) => t.category === "project" && t.parent_id === null,
  );
  const projectsOrdered = useMemo(() => [...projects].sort(byOrder), [projects]);

  // 0.1.20：选择状态收敛到 useSelection hook（操作对象含父事务及其子事务）
  const allProjectItems = useMemo(
    () => [
      ...projectsOrdered,
      ...projectsOrdered.flatMap((p) => active.filter((t) => t.parent_id === p.id)),
    ],
    [projectsOrdered, active],
  );
  const {
    selMode,
    setSelMode,
    selected,
    setSelected,
    confirmBatch,
    setConfirmBatch,
    toggleSel,
    toggleSelMode,
    selectAll,
    clearSel,
  } = useSelection({ items: allProjectItems });

  async function applySort(mode: "priority" | "time" | "completion") {
    const sorted = [...projects].sort((a, b) => {
      if (mode === "priority") return byPriority(a, b);
      if (mode === "completion") {
        // 父事务按「完成度」排序：已完成子事务占比，低的在前；无子父事务按其自身 status
        const da = parentDoneRatio(a);
        const db = parentDoneRatio(b);
        if (da !== db) return da - db;
        return byOrder(a, b);
      }
      return byTime(a, b);
    });
    await reorder(sorted.map((t) => t.id));
  }

  // 父事务完成度：路由到 transactionService.parentDoneRatioOf（单一真相源，C6）。
  const parentDoneRatio = (p: Transaction) => parentDoneRatioOf(p, active);

  // 0.1.13：对某个父事务的子事务单独排序（按优先度 / 时间 / 完成情况），复用 reorder 写回 order_index
  async function sortChildren(pid: number, mode: "priority" | "time" | "completion") {
    const kids = childrenOf(pid);
    if (kids.length <= 1) {
      setChildSortFor(null);
      return;
    }
    const comparator =
      mode === "priority" ? byPriority : mode === "completion" ? byCompletion : byTime;
    const sorted = [...kids].sort(comparator);
    await reorder(sorted.map((k) => k.id));
    setChildSortFor(null);
  }

  // 子事务集合：路由到 transactionService.childrenOf（单一真相源，C6）。
  const childrenOf = (pid: number) => svcChildrenOf(active, pid);

  // 0.1.16：切换某个父事务的子列表展开/收起
  function toggleExpand(id: number) {
    setExpanded((prev) => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  }

  function toggleSelModeLocal() {
    toggleSelMode();
    setClearConfirm(false);
  }

  // 0.1.13：一键清理——第一次点击仅选中所有已完成（含子事务）并进入确认态（不打开多选工具栏），
  // 第二次点击才批量删除；确认态下可点右侧「取消」退出。
  // 工具栏动作（含清理/批量删除/移动）统一收口到 useListActions（0.1.20 B3）；
  // Project 的差异点（含子事务的 id 来源、含子的父事务移动拦截）以回调注入。
  const listActions = useListActions({
    selected,
    setSelected,
    clearConfirm,
    setClearConfirm,
    confirmBatch,
    setConfirmBatch,
    selMode,
    setSelMode,
    // 一键清理候选：
    //  - 任意已完成项（父或子，status==="completed"）均清理；
    //  - 父事务仍 active 但「所有子都已完成」→ 视为整体已完成，连父带子一起清理；
    //  - 空父（无子且 active）保留——它可能正等待设立子事项，勿误删。
    getCompletedIds: () => {
      const ids: number[] = [];
      for (const p of projectsOrdered) {
        const kids = childrenOf(p.id);
        if (p.status === "completed") {
          ids.push(p.id); // 已完成父项：直接清
        } else if (kids.length > 0 && kids.every((c) => c.status === "completed")) {
          ids.push(p.id); // 父壳待清（子项随后也会入列）
        }
        for (const c of kids) if (c.status === "completed") ids.push(c.id);
      }
      return ids;
    },
    deleteSelected: async (ids) => { for (const id of ids) await deleteTx(id); },
    // 0.1.14：父事务若含子事务则禁止移动（会破坏层级）；以 filterMovable 拦截。
    filterMovable: (ids) => {
      const blocked = new Set(
        projectsOrdered
          .filter((p) => ids.includes(p.id) && childrenOf(p.id).length > 0)
          .map((p) => p.id),
      );
      return { movable: ids.filter((id) => !blocked.has(id)), blocked: [...blocked] };
    },
    onMoved: (blocked) => {
      if (blocked.length > 0) {
        setMoveHint("含子事务无法移动");
        setTimeout(() => setMoveHint(""), 2500);
      }
    },
  });
  const { cleanCompleted, cancelClean, batchDelete, moveTo } = listActions;

  async function toggleNext(c: Transaction) {
    const next = !c.show_in_next;
    await updateTx(c.id, { show_in_next: next });
  }

  // 0.1.19：子事务跨类别拖拽落点——拖到左侧导航栏改类别。
  // 规则：inbox 禁止互转（拖到 Inbox 导航不高亮、无操作）；
  //       其余类别正常改；**保持 show_in_next 与 time_slot（不影响 Next 展示状态），并脱离原父项目**。
  // 0.1.19/1.1.0：project 子事务或顶层项目拖到 Habits——复用 buildCategoryPatch 的统一清理，
  // 否则会残留 priority / show_in_next / time_slot / wait_auto_next / deadline 这些 habit 用不上的字段。
  function toHabit(id: number) {
    const tx = useTxStore.getState().active.find((t) => t.id === id);
    if (tx) updateTx(id, buildCategoryPatch(tx, "habit"));
  }
  function childCatTarget(id: number, cat: string) {
    if (cat === "inbox") return;
    const c = CAT_MAP[cat];
    if (!c) return;
    if (c === "habit") toHabit(id);
    else updateTx(id, { category: c, clear_parent: true });
  }
  // 0.1.18：无子父事务跨类别拖拽落点——拖到左侧导航栏改类别。
  // 规则：inbox 禁止互转；拖到 Project 导航 = 无操作（已在 Project）；
  //       含子父事务只能排序，此处通过 startDrag 传 disabled 控制；无子父事务正常改。
  function parentCatTarget(id: number, cat: string) {
    if (cat === "inbox" || cat === "project") return;
    if (childrenOf(id).length > 0) return; // 含子父事务不可改类别
    const c = CAT_MAP[cat];
    if (!c) return;
    // 离开 Project 上下文：转 habit 走统一清理；其它目标清 parent_id + 重置 time_slot（保持 show_in_next）
    if (c === "habit") toHabit(id);
    else updateTx(id, { category: c, clear_parent: true, time_slot: "none" });
  }
  // 0.1.17：子事务拖到某个父事务行（data-parent-id）= 改父（成为该父的子事务）。
  // 含子的父事项按 0.1.14/0.1.17 规则只能排序，不可改父（此处不会被传 allowReparent）。
  function childReparent(id: number, parentId: number) {
    updateTx(id, { parent_id: parentId });
  }

  const dragTx = dragId != null ? active.find((t) => t.id === dragId) ?? null : null;

  const DeleteButton = ({ t }: { t: Transaction }) => (
    <button
      className={`btn-danger ${deletingId === t.id ? "on" : ""}`}
      onClick={() => {
        if (deletingId === t.id) {
          deleteTx(t.id);
          setDeletingId(null);
        } else {
          setDeletingId(t.id);
        }
      }}
    >
      {deletingId === t.id ? "确认删除？" : "删除"}
    </button>
  );

  return (
    <section className="view category-view">
      <header className="view-header">
        <h2>Projects</h2>
        <span className="count-badge">{projects.length}</span>
      </header>
      <p className="view-sub muted">
        可拆成子事务的目标。子事务默认只在项目内显示，需要时「加入 Next」进入全局下一步。
      </p>

      <ListToolbar
        selMode={selMode}
        selectedCount={selected.size}
        confirmBatch={confirmBatch}
        setConfirmBatch={setConfirmBatch}
        onToggleSelMode={toggleSelModeLocal}
        cleanConfirm={clearConfirm}
        cleanDisabled={
          !clearConfirm &&
          projectsOrdered.filter((p) => p.status === "completed").length === 0 &&
          projectsOrdered.every((p) => childrenOf(p.id).filter((c) => c.status === "completed").length === 0)
        }
        onClean={cleanCompleted}
        onCancelClean={cancelClean}
        onSort={applySort}
        onMove={moveTo}
        onSelectAll={selectAll}
        onClearSel={clearSel}
        onBatchDelete={batchDelete}
        moveExtra={
          moveHint ? (
            <span className="move-hint" style={{ color: "#e0533d", marginLeft: 8, fontSize: 12 }}>
              {moveHint}
            </span>
          ) : null
        }
      />

      <div className="sub-panel" ref={containerRef}>
      {loading && <p className="muted">加载中…</p>}
      {error && <p className="error">出错了：{error}</p>}

      {!loading && projects.length === 0 && (
        <div className="empty">
          还没有 Project 类型的事务。
          <br />
          去 Inbox 把某个目标整理成 Project 吧。
        </div>
      )}

      <ul className="tx-list">
        {projectsOrdered.map((p) => {
          const kids = childrenOf(p.id);
          // 0.1.13：父事务完成态由子事务派生——全部子事务完成则父项视为完成，
          // 不再提供手动复选框（无子事务时保留手动复选框）。
          const allDone = kids.length > 0 && kids.every((k) => k.status === "completed");
          const parentDone = p.status === "completed" || allDone;
          const pClass =
            "tx-item project-node" +
            (parentDone ? " done" : "") +
            (p.priority != null ? ` pri-row-${p.priority}` : "");
          const isExpanded = expanded.has(p.id);
          return (
            <li
              key={p.id}
              data-drag-idx={p.id}
              data-parent-id={p.id}
              title={selMode ? "点击整行选中/取消" : "长按可拖动排序（含子父项仅可排序，无子父项可拖去改类别）"}
              className={
                pClass + " draggable-row" +
                (selMode ? " sel-clickable" : "") +
                (dragId === p.id ? " dragging" : "") +
                (overIdx === p.id && dragId !== p.id
                  ? ` drag-over ${overHalf === "bottom" ? "drag-over-bottom" : "drag-over-top"}`
                  : "") +
                ((selMode || clearConfirm) && selected.has(p.id) ? " selected" : "")
              }
              onPointerDown={(e) => {
                if (selMode) return;
                const hasChildren = childrenOf(p.id).length > 0;
                startDrag(e, p.id, projectsOrdered.map((x) => x.id), reorder, {
                  allowCrossCat: !hasChildren,
                  onCatTarget: parentCatTarget,
                  disabled: parentDone,
                  onDisabledPress: () => showToast("已完成事务无法拖拽"),
                });
              }}
              onClick={(e) => {
                if (selMode) {
                  e.stopPropagation();
                  toggleSel(p.id);
                }
              }}
            >
              {/* 0.1.16：父事务行改为纵向结构，子列表占满整行宽度 */}
              <div className="proj-top">
                <TxGutter
                  mode={selMode ? "sel" : "none"}
                  selected={selected.has(p.id)}
                  onToggleSelect={() => toggleSel(p.id)}
                />
                <TxMain
                  tx={p}
                  showMeta={true}
                  expandedNoteId={expandedNoteId}
                  setExpandedNoteId={setExpandedNoteId}
                  onTitleClick={() => toggleExpand(p.id)}
                  leadingSlot={
                    <span
                      className="tx-caret"
                      title={isExpanded ? "收起子事务" : "展开子事务"}
                      onClick={(e) => { e.stopPropagation(); toggleExpand(p.id); }}
                    >
                      {isExpanded ? "▾" : "▸"}
                    </span>
                  }
                  trailingSlot={
                    kids.length > 0 ? (() => {
                      const doneKids = kids.filter((k) => k.status === "completed").length;
                      const pct = Math.round((doneKids / kids.length) * 100);
                      return (
                        <div
                          className="proj-progress"
                          title={`${doneKids}/${kids.length} 子事务已完成`}
                        >
                          <div className="proj-progress-bar">
                            <div
                              className="proj-progress-fill"
                              style={{ width: pct + "%" }}
                            />
                          </div>
                          <span className="proj-progress-text">
                            事务健康度 {doneKids}/{kids.length} 完成
                          </span>
                        </div>
                      );
                    })() : null
                  }
                />

                {!selMode && (
                  <div className="project-actions">
                    {/* 0.1.13：对当前父事务的子事务单独排序 */}
                    {kids.length > 0 && (
                      <div
                        className="dropdown"
                        ref={childSortFor === p.id ? childSortRef : undefined}
                      >
                        <button
                          className="btn-ghost dropdown-toggle"
                          onClick={() => setChildSortFor((v) => (v === p.id ? null : p.id))}
                          title="对子事务排序"
                        >
                          子排序
                        </button>
                        {childSortFor === p.id && (
                          <div className="dropdown-menu">
                            <button
                              className="dropdown-item"
                              onClick={() => sortChildren(p.id, "priority")}
                            >
                              按优先度
                            </button>
                            <button
                              className="dropdown-item"
                              onClick={() => sortChildren(p.id, "time")}
                            >
                              按时间
                            </button>
                            <button
                              className="dropdown-item"
                              onClick={() => sortChildren(p.id, "completion")}
                            >
                              按完成情况
                            </button>
                          </div>
                        )}
                      </div>
                    )}
                    <button className="btn-ghost" onClick={() => { setEditingChild(false); setEditing(p); }}>
                      编辑
                    </button>
                    {/* 0.1.16：「加子步骤」改为「批量添加子事项」 */}
                    <button className="btn-ghost" onClick={() => setBatchFor(p.id)}>
                      批量添加子事项
                    </button>
                    {parentDone && <DeleteButton t={p} />}
                  </div>
                )}
              </div>

              {/* 0.1.16：子列表作为父 li 的直接子节点（非 tx-main 内），
                  展开时占满整行宽度，拉到最右边 */}
              {isExpanded && kids.length > 0 && (
                <ul className="tx-children">
                  {kids.map((c) => {
                    const cClass =
                      "tx-child" +
                      (c.status === "completed" ? " done" : "") +
                      (c.priority != null ? ` pri-row-${c.priority}` : "");
                    return (
                      <TxRow
                        key={c.id}
                        tx={c}
                        className={
                          cClass + " draggable-row" +
                          (selMode ? " sel-clickable" : "") +
                          (dragId === c.id ? " dragging" : "") +
                          (overIdx === c.id && dragId !== c.id
                            ? ` drag-over ${overHalf === "bottom" ? "drag-over-bottom" : "drag-over-top"}`
                            : "") +
                          ((selMode || clearConfirm) && selected.has(c.id) ? " selected" : "")
                        }
                        rowProps={{
                          "data-drag-idx": c.id,
                          title: selMode ? "点击整行选中/取消" : "长按可拖动排序、改父或改类别",
                          onPointerDown: (e) => {
                            e.stopPropagation();
                            if (selMode) return;
                            startDrag(e, c.id, kids.map((k) => k.id), reorder, {
                              allowCrossCat: true,
                              onCatTarget: childCatTarget,
                              allowReparent: true,
                              onReparent: childReparent,
                              excludeParentId: c.parent_id ?? undefined,
                              disabled: c.status === "completed",
                              onDisabledPress: () => showToast("已完成事务无法拖拽"),
                            });
                          },
                          onClick: (e) => {
                            if (selMode) {
                              e.stopPropagation();
                              toggleSel(c.id);
                            }
                          },
                        }}
                        gutter={selMode ? "sel" : "done"}
                        selected={selected.has(c.id)}
                        onToggleSelect={() => toggleSel(c.id)}
                        done={c.status === "completed"}
                        onToggleDone={() => {
                          const wasDone = c.status === "completed";
                          toggleComplete(c.id);
                          if (wasDone && deletingId === c.id) setDeletingId(null);
                        }}
                        showMeta={true}
                        expandedNoteId={expandedNoteId}
                        setExpandedNoteId={setExpandedNoteId}
                        actions={
                          !selMode ? (
                            <>
                              <button
                                className="btn-ghost"
                                onClick={() => { setEditingChild(true); setEditing(c); }}
                              >
                                编辑
                              </button>
                              <button
                                className={`btn-ghost ${c.show_in_next ? "on" : ""}`}
                                onClick={() => toggleNext(c)}
                              >
                                {c.show_in_next ? "在 Next ✓" : "加入 Next"}
                              </button>
                              {c.status === "completed" && <DeleteButton t={c} />}
                            </>
                          ) : null
                        }
                      />
                    );
                  })}
                </ul>
              )}
            </li>
          );
        })}
      </ul>
      </div>
      {editing && (
        <EditModal tx={editing} hideCategory={editingChild} onClose={() => setEditing(null)} />
      )}
      {batchFor != null && (
        <AddChildModal
          parentId={batchFor}
          batch
          onAdded={() => {}}
          onClose={() => setBatchFor(null)}
        />
      )}

      <Fab label="新增 Project 事务" onClick={() => setAdding(true)} />
      {adding && (
        <AddModal category="project" onClose={() => setAdding(false)} />
      )}

      {/* 0.1.20：拖拽浮层收敛为共享 DragGhost */}
      <DragGhost tx={dragTx} pos={dragPos} />
    </section>
  );
}
