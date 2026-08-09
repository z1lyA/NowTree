// 列表视图合并（0.1.19）：把 InboxView 与 CategoryListView 抽成一个 GenericListView。
// 两者 90% 同构（列表渲染 / 拖拽接线 / 备注展开 / 多选逻辑完全一致），
// 仅数据来源与工具栏/行操作有差异，用 mode 参数区分：
//   - mode === "inbox"：数据来自 store.inbox（status=inbox），工具栏有「批量转换」，行无完成勾选、删除走 removeInbox。
//   - mode 为某类别：数据来自 store.active 按类别过滤，工具栏有「一键清理 / 排序 / 移动到」，行有完成勾选、删除走 deleteTx。
// Project 树状视图（含子列表改父拖拽）结构不同，保持独立 ProjectListView，不并入本组件。
// 0.1.10：多选模式（批量删除 / 批量移动）、排序工具栏。
// 0.1.11：灵感无时间/优先度，故去掉排序按钮（inbox 模式）；多选进入后批量功能以边框分组；圆形选中框。
// 0.1.16：备注默认一行收起，点击展开，点其它地方自动收起（useNoteExpand + Note）。
// 0.1.17：跨类别拖到左侧导航栏改类别（inbox↔类别禁止互转）。
import { useEffect, useMemo, useState } from "react";
import { useTxStore } from "../store/useTxStore";
import type { Category, Transaction } from "../types/transaction";
import {
  CATEGORY_LABELS,
  CAT_MAP,
  byOrder,
  byPriority,
  byTime,
  byCompletion,
} from "../types/transaction";

// 各视图共用的常量（CATEGORIES / CAT_MAP）已收敛到 types/transaction.ts（0.1.20）。
const CATEGORY_HINTS: Record<Category, string> = {
  next_action: "立刻能做的下一步，按优先级推进。",
  project: "需要多步推进的目标，可拆成子事务。",
  waiting: "在等别人或外部条件，设了时间要求到期会自动进 Next，记得定期回顾别漏掉。",
  someday: "也许将来想做，先记着，不占用当下精力。",
  habit: "每天重复、需要坚持的事，完成后次日自动复位重新开始。",
};

import EditModal from "./EditModal";
import AddModal from "./AddModal";
import ConvertModal from "./ConvertModal";
import Fab from "./Fab";
import { TxGutter, TxMain } from "./TxRow";
import DragGhost from "./DragGhost";
import { useListDrag } from "../hooks/useListDrag";
import { showToast } from "../toast";
import { useNoteExpand } from "../hooks/useNoteExpand";
import { useSelection } from "../hooks/useSelection";
import { useListActions } from "../hooks/useListActions";
import { buildCategoryPatch, canShowInNext } from "../services/transactionService";
import ListToolbar from "./ListToolbar";

type ListViewMode = "inbox" | Category;

interface GenericListViewProps {
  mode: ListViewMode;
}

export default function GenericListView({ mode }: GenericListViewProps) {
  const {
    inbox,
    active,
    loading,
    error,
    loadInbox,
    loadActive,
    removeInbox,
    updateTx,
    toggleComplete,
    deleteTx,
    reorder,
  } = useTxStore();

  const inboxMode = mode === "inbox";

  const [editing, setEditing] = useState<Transaction | null>(null);
  const [converting, setConverting] = useState<Transaction | null>(null);
  const [adding, setAdding] = useState(false);
  // 单条删除二次确认：deletingId 存待确认的事务 id
  const [deletingId, setDeletingId] = useState<number | null>(null);
  const [clearConfirm, setClearConfirm] = useState(false);
  // Inbox 批量转换队列（0.1.13）
  const [batchQueue, setBatchQueue] = useState<Transaction[]>([]);
  const [batchIdx, setBatchIdx] = useState(0);
  const { dragId, overIdx, overHalf, dragPos, startDrag } = useListDrag();
  const { expandedNoteId, setExpandedNoteId, containerRef } = useNoteExpand();

  // 数据源：inbox 模式取 store.inbox；类别模式取 store.active 并按 mode 过滤
  const items = useMemo(() => {
    if (inboxMode) return inbox;
    if (mode === "next_action") {
      return active.filter(
        (t) =>
          (t.category === "next_action" && t.parent_id === null) ||
          t.show_in_next,
      );
    }
    return active.filter((t) => t.category === mode && t.parent_id === null);
  }, [inboxMode, inbox, active, mode]);

  const ordered = useMemo(() => [...items].sort(byOrder), [items]);

  // 0.1.20：选择状态收敛到 useSelection hook
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

  // 首次进入且尚未加载过对应数据时拉取；切换分类直接客户端过滤，不再请求
  useEffect(() => {
    if (inboxMode) {
      if (inbox.length === 0) loadInbox();
    } else {
      if (active.length === 0) loadActive();
    }
  }, [inboxMode, inbox.length, active.length, loadInbox, loadActive]);

  // 切换 mode 时重置多选 / 一键清理 / 待删态
  useEffect(() => {
    setSelMode(false);
    setSelected(new Set());
    setConfirmBatch(false);
    setClearConfirm(false);
    setDeletingId(null);
  }, [mode, setSelMode, setSelected, setConfirmBatch]);

  // 监听全局「快速新增」事件（App 在按 Enter 时派发）
  useEffect(() => {
    const h = () => setAdding(true);
    window.addEventListener("nowtree:quick-add", h);
    return () => window.removeEventListener("nowtree:quick-add", h);
  }, []);


  // ===== 工具栏动作（统一收口到 useListActions，0.1.20 B3）=====
  const listActions = useListActions({
    selected,
    setSelected,
    clearConfirm,
    setClearConfirm,
    confirmBatch,
    setConfirmBatch,
    selMode,
    setSelMode,
    // 选中「已完成」的 id（类别模式：ordered 中已完成的）
    getCompletedIds: () =>
      ordered.filter((t) => t.status === "completed").map((t) => t.id),
    // 删除方式：inbox 走 removeInbox，类别走 deleteTx
    deleteSelected: inboxMode
      ? async (ids) => { for (const id of ids) await removeInbox(id); }
      : async (ids) => { for (const id of ids) await deleteTx(id); },
  });
  const { cleanCompleted, cancelClean, batchDelete, moveTo } = listActions;
  function applySort(m: "priority" | "time" | "completion") {
    const sorted = [...items].sort(
      m === "priority" ? byPriority : m === "completion" ? byCompletion : byTime,
    );
    listActions.applySort(sorted.map((t) => t.id));
  }

  // Inbox 批量转换队列（0.1.13）
  function startBatch() {
    const q = [...ordered];
    if (q.length === 0) return;
    setBatchQueue(q);
    setBatchIdx(0);
  }
  function advanceBatch() {
    const n = batchIdx + 1;
    if (n >= batchQueue.length) {
      setBatchQueue([]);
      setBatchIdx(0);
    } else {
      setBatchIdx(n);
    }
  }
  function abortBatch() {
    setBatchQueue([]);
    setBatchIdx(0);
  }

  // 0.1.17：跨类别拖拽落点——拖到左侧导航栏改类别（在此命名为 changeCategoryOnDrop 以表意）。
  // 规则：inbox 禁止互转（拖到 Inbox 导航不高亮、无操作）；拖到自己所在类别的导航 = 无操作；
  //       原生 next_action 项离开 Next：清 parent_id / time_slot / show_in_next；
  //       someday / waiting 项改类别：仅改 category，**保持 show_in_next 与 time_slot（不影响 Next 展示状态）**。
  // 类别迁移规则收口到 service（见 buildCategoryPatch）：inbox 互转 / 拖到自己类别
  // 由上面早返回拦截；这里只负责「原生 next_action 离开 Next 清父子关系」等补丁。
  function changeCategoryOnDrop(id: number, cat: string) {
    if (cat === "inbox" || cat === mode) return;
    const tx = active.find((t) => t.id === id);
    if (!tx) return;
    const c = CAT_MAP[cat];
    if (!c) return;
    updateTx(id, buildCategoryPatch(tx, c));
  }

  const dragTx = dragId != null ? items.find((t) => t.id === dragId) ?? null : null;

  const titleText = inboxMode ? "Inbox" : CATEGORY_LABELS[mode as Category];
  const hint = inboxMode
    ? "把脑子里冒出来的事先丢进来，稍后再整理成正式事务；点右下角 ＋ 直接记录。"
    : CATEGORY_HINTS[mode as Category];

  return (
    <section className={"view " + (inboxMode ? "inbox-view" : "category-view")}>
      <header className="view-header">
        <h2>{titleText}</h2>
        <span className="count-badge">{items.length}</span>
      </header>
      <p className="view-sub muted">{hint}</p>

      <ListToolbar
        selMode={selMode}
        selectedCount={selected.size}
        confirmBatch={confirmBatch}
        setConfirmBatch={setConfirmBatch}
        onToggleSelMode={() => { setDeletingId(null); toggleSelMode(); }}
        showClean={!inboxMode}
        cleanConfirm={clearConfirm}
        cleanDisabled={!clearConfirm && ordered.filter((t) => t.status === "completed").length === 0}
        onClean={cleanCompleted}
        onCancelClean={cancelClean}
        showSort={!inboxMode}
        onSort={applySort}
        showMove={!inboxMode}
        onMove={moveTo}
        onSelectAll={selectAll}
        onClearSel={clearSel}
        onBatchDelete={batchDelete}
        extra={
          inboxMode ? (
            <>
              <button
                className="btn-ghost tb-btn"
                onClick={() => { setDeletingId(null); startBatch(); }}
                disabled={inbox.length === 0}
                title={inbox.length === 0 ? "Inbox 为空" : "依次把每条灵感整理为正式事务"}
              >
                批量转换
              </button>
              {batchQueue.length > 0 && (
                <>
                  <span className="batch-progress">
                    转换中 {Math.min(batchIdx + 1, batchQueue.length)}/{batchQueue.length}
                  </span>
                  <button className="btn-ghost" onClick={abortBatch}>
                    退出批量
                  </button>
                </>
              )}
            </>
          ) : null
        }
      />

      <div className="sub-panel" ref={containerRef}>
        {loading && <p className="muted">加载中…</p>}
        {error && <p className="error">出错了：{error}</p>}
        {!loading && items.length === 0 && (
          <div className="empty">
            {inboxMode
              ? "Inbox 还是空的，点右下角 ＋ 记录第一个想法吧。"
              : (
                <>
                  还没有「{CATEGORY_LABELS[mode as Category]}」类型的事务。
                  <br />
                  去 Inbox 整理几个，或先记下想法。
                </>
              )}
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
                (!inboxMode && t.status === "completed" ? " done" : "") +
                (!inboxMode && t.priority != null ? ` pri-row-${t.priority}` : "") +
                (dragId === t.id ? " dragging" : "") +
                (overIdx === t.id && dragId !== t.id
                  ? ` drag-over ${overHalf === "bottom" ? "drag-over-bottom" : "drag-over-top"}`
                  : "") +
                ((selMode || (!inboxMode && clearConfirm)) && selected.has(t.id) ? " selected" : "")
              }
              onPointerDown={(e) => {
                if (selMode) return;
                const opts = inboxMode
                  ? undefined
                  : {
                      allowCrossCat: true,
                      onCatTarget: changeCategoryOnDrop,
                      disabled: t.status === "completed",
                      onDisabledPress: () => showToast("已完成事务无法拖拽"),
                    };
                startDrag(e, t.id, ordered.map((x) => x.id), reorder, opts);
              }}
              onClick={() => {
                if (selMode) toggleSel(t.id);
              }}
            >
              {/* 0.1.19 修复的占位符问题，现由 TxGutter 的 mode="none" 处理：
                  inbox 非多选 → gutter="none" 不渲染，标题前不再留空白 */}
              <TxGutter
                mode={selMode ? "sel" : (!inboxMode ? "done" : "none")}
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
                showMeta={!inboxMode}
                showSource={mode === "next_action"}
                expandedNoteId={expandedNoteId}
                setExpandedNoteId={setExpandedNoteId}
              />
              {!selMode && (!inboxMode || batchQueue.length === 0) && (
                <div className="tx-actions">
                  {inboxMode && (
                    <button className="btn-ghost" onClick={() => { setDeletingId(null); setConverting(t); }}>
                      整理
                    </button>
                  )}
                  {!inboxMode && canShowInNext(mode) && (
                    <button
                      className={`btn-ghost ${t.show_in_next ? "on" : ""}`}
                      onClick={() => { setDeletingId(null); updateTx(t.id, { show_in_next: !t.show_in_next }); }}
                    >
                      {t.show_in_next ? "在 Next ✓" : "加入 Next"}
                    </button>
                  )}
                  <button className="btn-ghost" onClick={() => { setDeletingId(null); setEditing(t); }}>
                    编辑
                  </button>
                  {inboxMode ? (
                    <button
                      className={"btn-ghost" + (deletingId === t.id ? " btn-danger" : "")}
                      onClick={() => {
                        if (deletingId === t.id) {
                          removeInbox(t.id);
                          setDeletingId(null);
                        } else {
                          setDeletingId(t.id);
                        }
                      }}
                    >
                      {deletingId === t.id ? "确认删除？" : "删除"}
                    </button>
                  ) : (
                    t.status === "completed" && (
                      <button
                        className={"btn-danger" + (deletingId === t.id ? " on" : "")}
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
                    )
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
      </div>

      {converting && batchQueue.length === 0 && (
        <ConvertModal tx={converting} onClose={() => setConverting(null)} />
      )}
      {/* 0.1.13：批量依次转换——逐个弹出 ConvertModal；
          成功（onConverted）推进下一个；退出（onClose）即中断。key 用 id 保证切到下一条时重挂载。 */}
      {batchQueue.length > 0 && batchIdx < batchQueue.length && (
        <ConvertModal
          key={batchQueue[batchIdx].id}
          tx={batchQueue[batchIdx]}
          onConverted={advanceBatch}
          onClose={abortBatch}
        />
      )}
      {editing && (
        <EditModal
          tx={editing}
          inbox={inboxMode}
          onDelete={inboxMode ? () => removeInbox(editing.id) : undefined}
          onClose={() => setEditing(null)}
        />
      )}

      <Fab
        label={inboxMode ? "新增 Inbox 记录" : `在「${CATEGORY_LABELS[mode as Category]}」直接新增事务`}
        onClick={() => { setDeletingId(null); setAdding(true); }}
      />
      {adding && <AddModal category={mode} onClose={() => setAdding(false)} />}

      {/* 0.1.20：拖拽浮层收敛为共享 DragGhost */}
      <DragGhost tx={dragTx} pos={dragPos} />
    </section>
  );
}
