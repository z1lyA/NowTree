// 1.1.0：Habits 视图——收容每天重复、需要坚持的事务，从 Next 主线剥离。
// 设计：复用 Transaction 单表（category='habit'），行为与 Next 不同——完成次日 6 点重置回未完成，
// 默认不进 Next，视图内可拖拽排序、可软删除、可跨视图拖拽转成普通事务。
// 实现：复用 GenericListView 同款的共享原语（useListDrag / useSelection / useListActions /
// TxRow / ListToolbar / Fab），但裁剪为习惯专属 UI——不显示优先级 / 时间要求 / 提醒 /
// 「加入 Next」/ 一键清理（habit 每天重置，没有"已完成待清"语义）。
import { useEffect, useMemo, useState } from "react";
import { useTxStore } from "../store/useTxStore";
import type { Transaction } from "../types/transaction";
import { byOrder, CAT_MAP, TIME_SLOT_LABELS } from "../types/transaction";

import EditModal from "./EditModal";
import AddModal from "./AddModal";
import Fab from "./Fab";
import { TxGutter, TxMain } from "./TxRow";
import DragGhost from "./DragGhost";
import { useListDrag } from "../hooks/useListDrag";
import { showToast } from "../toast";
import { useNoteExpand } from "../hooks/useNoteExpand";
import { useSelection } from "../hooks/useSelection";
import { useListActions } from "../hooks/useListActions";
import { buildCategoryPatch } from "../services/transactionService";
import ListToolbar from "./ListToolbar";

export default function HabitsView() {
  const {
    active,
    loading,
    error,
    loadActive,
    updateTx,
    toggleComplete,
    deleteTx,
    reorder,
  } = useTxStore();

  const [editing, setEditing] = useState<Transaction | null>(null);
  const [adding, setAdding] = useState(false);
  // 单条删除二次确认：deletingId 存待确认的事务 id
  const [deletingId, setDeletingId] = useState<number | null>(null);
  // clearConfirm 仅用于满足 useListActions 签名，Habits 视图不渲染一键清理按钮
  const [clearConfirm, setClearConfirm] = useState(false);
  const { dragId, overIdx, overHalf, dragPos, startDrag } = useListDrag();
  const { expandedNoteId, setExpandedNoteId, containerRef } = useNoteExpand();

  // 仅取 habit 类别、顶层（无父）的项
  const items = useMemo(
    () => active.filter((t) => t.category === "habit" && t.parent_id === null),
    [active],
  );

  const ordered = useMemo(() => [...items].sort(byOrder), [items]);

  const {
    selMode,
    setSelMode,
    selected,
    setSelected,
    confirmBatch,
    setConfirmBatch,
    toggleSelMode,
    toggleSel,
    selectAll,
    clearSel,
  } = useSelection({ items: ordered });

  useEffect(() => {
    if (active.length === 0) loadActive();
  }, [active.length, loadActive]);

  // 切换视图时重置多选 / 待删态
  useEffect(() => {
    setSelMode(false);
    setSelected(new Set());
    setConfirmBatch(false);
    setClearConfirm(false);
    setDeletingId(null);
  }, [setSelMode, setSelected, setConfirmBatch]);

  // 监听全局「快速新增」事件（App 在按 Enter 时派发）
  useEffect(() => {
    const h = () => setAdding(true);
    window.addEventListener("nowtree:quick-add", h);
    return () => window.removeEventListener("nowtree:quick-add", h);
  }, []);

  const listActions = useListActions({
    selected,
    setSelected,
    clearConfirm,
    setClearConfirm,
    confirmBatch,
    setConfirmBatch,
    selMode,
    setSelMode,
    getCompletedIds: () =>
      ordered.filter((t) => t.status === "completed").map((t) => t.id),
    // habit 删除走普通 deleteTx（软删除进回收站，可恢复）
    deleteSelected: async (ids) => {
      for (const id of ids) await deleteTx(id);
    },
  });
  const { batchDelete, moveTo } = listActions;

  // 跨类别拖拽落点——拖到左侧导航栏改类别（复用与 GenericListView 同款规则）：
  // inbox 禁止互转、拖回 habit 自身无操作；其余按 buildCategoryPatch 改类（habit ↔ 其它类别互转）。
  function changeCategoryOnDrop(id: number, cat: string) {
    if (cat === "inbox" || cat === "habit") return;
    const tx = active.find((t) => t.id === id);
    if (!tx) return;
    const c = CAT_MAP[cat];
    if (!c) return;
    updateTx(id, buildCategoryPatch(tx, c));
  }

  const dragTx = dragId != null ? items.find((t) => t.id === dragId) ?? null : null;

  return (
    <section className="view category-view">
      <header className="view-header">
        <h2>Habits</h2>
        <span className="count-badge">{items.length}</span>
      </header>
      <p className="view-sub muted">
        每天重复、需要坚持的事。勾掉即视为今天完成，明天 6 点自动复位重新开始；拖动可排序，拖到其它视图可转成普通事务。
      </p>

      <ListToolbar
        selMode={selMode}
        selectedCount={selected.size}
        confirmBatch={confirmBatch}
        setConfirmBatch={setConfirmBatch}
        onToggleSelMode={() => {
          setDeletingId(null);
          toggleSelMode();
        }}
        showClean={false}
        showSort={false}
        showMove={true}
        onMove={moveTo}
        onSelectAll={selectAll}
        onClearSel={clearSel}
        onBatchDelete={batchDelete}
      />

      <div className="sub-panel" ref={containerRef}>
        {loading && <p className="muted">加载中…</p>}
        {error && <p className="error">出错了：{error}</p>}
        {!loading && items.length === 0 && (
          <div className="empty">
            还没有习惯。
            <br />
            点右下角 ＋ 记下第一个想每天坚持的事。
          </div>
        )}

        <ul className="tx-list">
          {ordered.map((t) => (
            <li
              key={t.id}
              data-drag-idx={t.id}
              title={selMode ? "点击整行选中/取消" : "长按可拖动排序"}
              className={
                "tx-item draggable-row" +
                (selMode ? " sel-clickable" : "") +
                (t.status === "completed" ? " done" : "") +
                (dragId === t.id ? " dragging" : "") +
                (overIdx === t.id && dragId !== t.id
                  ? ` drag-over ${overHalf === "bottom" ? "drag-over-bottom" : "drag-over-top"}`
                  : "") +
                (selMode && selected.has(t.id) ? " selected" : "")
              }
              onPointerDown={(e) => {
                if (selMode) return;
                startDrag(e, t.id, ordered.map((x) => x.id), reorder, {
                  allowCrossCat: true,
                  onCatTarget: changeCategoryOnDrop,
                  disabled: t.status === "completed",
                  onDisabledPress: () => showToast("已完成事务无法拖拽"),
                });
              }}
              onClick={() => {
                if (selMode) toggleSel(t.id);
              }}
            >
              <TxGutter
                mode={selMode ? "sel" : "done"}
                selected={selected.has(t.id)}
                onToggleSelect={() => toggleSel(t.id)}
                done={t.status === "completed"}
                onToggleDone={() => {
                  const wasDone = t.status === "completed";
                  toggleComplete(t.id);
                  if (wasDone && deletingId === t.id) setDeletingId(null);
                }}
              />
              <TxMain
                tx={t}
                showMeta={false}
                expandedNoteId={expandedNoteId}
                setExpandedNoteId={setExpandedNoteId}
              />
              {!selMode && (
                <div className="tx-actions">
                  {/* 1.1.1：习惯可选时段（复用 time_slot 字段，不新增列）。三个按钮切换早/午/晚，
                      点已选中的再点一次→清回无时段；样式沿用「加入 Next」的高亮（.on）。 */}
                  {(["morning", "noon", "evening"] as const).map((s) => (
                    <button
                      key={s}
                      className={"btn-ghost slot-btn" + (t.time_slot === s ? " on" : "")}
                      title={"设为" + TIME_SLOT_LABELS[s]}
                      onClick={() => updateTx(t.id, { time_slot: t.time_slot === s ? "none" : s })}
                    >
                      {s === "morning" ? "早" : s === "noon" ? "午" : "晚"}
                    </button>
                  ))}
                  <button
                    className="btn-ghost"
                    onClick={() => {
                      setDeletingId(null);
                      setEditing(t);
                    }}
                  >
                    编辑
                  </button>
                  <button
                    className={"btn-ghost" + (deletingId === t.id ? " btn-danger" : "")}
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
                </div>
              )}
            </li>
          ))}
        </ul>
      </div>

      {editing && (
        <EditModal tx={editing} habit onClose={() => setEditing(null)} />
      )}

      <Fab label={`在「Habits」直接新增习惯`} onClick={() => { setDeletingId(null); setAdding(true); }} />
      {adding && <AddModal category="habit" onClose={() => setAdding(false)} />}

      {/* 拖拽浮层收敛为共享 DragGhost */}
      <DragGhost tx={dragTx} pos={dragPos} />
    </section>
  );
}
