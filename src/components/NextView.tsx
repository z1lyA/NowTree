// Next Actions 分栏视图（0.1.16）。
// 左栏：未分配时段的 Next 事务（time_slot === "none"），保留原「下一步」子页面语义；
// 右栏：早 / 午 / 晚 三个时段栏，把左栏事务长按拖入即分配时段（time_slot），
//   拖回左栏则取消分配。分配的时段持久化到本地库，影响「启动弹窗」的今日任务。
// 工具栏（一键清理 / 排序 / 多选）复用 CategoryListView 的同款逻辑，作用于全部 Next 事务。
import { useEffect, useMemo, useRef, useState } from "react";
import { useTxStore } from "../store/useTxStore";
import type { Transaction, TimeSlot } from "../types/transaction";
import {
  byOrder,
  byPriority,
  byTime,
  byCompletion,
  TIME_SLOT_LABELS,
  CAT_MAP,
} from "../types/transaction";
import EditModal from "./EditModal";
import AddModal from "./AddModal";
import Fab from "./Fab";
import { showToast } from "../toast";
import { useNoteExpand } from "../hooks/useNoteExpand";
import { useSelection } from "../hooks/useSelection";
import { useListActions } from "../hooks/useListActions";
import TxRow from "./TxRow";
import DragGhost from "./DragGhost";
import ListToolbar from "./ListToolbar";
import {
  LONG_PRESS_MS,
  AUTOSCROLL_EDGE_PX,
  AUTOSCROLL_STEP_PX,
  findScrollableAncestor,
  rowHalfOf,
  nearestRowEl,
  enterDragVisuals,
  exitDragVisuals,
  isBeyondThreshold,
} from "../hooks/dragUtils";

const SLOTS: TimeSlot[] = ["morning", "noon", "evening"];

// 注意：LONG_PRESS_MS / DRAG_THRESHOLD / findScrollableAncestor / rowHalfOf / nearestRowEl
// 已从本地拷贝改为从 ../hooks/dragUtils 引入（0.1.19 共享，消除与 useListDrag 的重复）。

export default function NextView({
  openSlot,
  setOpenSlot,
}: {
  openSlot: TimeSlot | null;
  setOpenSlot: (s: TimeSlot | null) => void;
}) {
  const { active, loadActive, updateTx, toggleComplete, deleteTx, reorder } = useTxStore();
  const [editing, setEditing] = useState<Transaction | null>(null);
  const [adding, setAdding] = useState(false);
  const { expandedNoteId, setExpandedNoteId, containerRef } = useNoteExpand();

  const [clearConfirm, setClearConfirm] = useState(false);

  // 拖拽：dragId 当前拖动项；overSlot 悬停的栏（"left"=左栏）；overIdx 同栏内悬停目标行 id（排序指示）；overHalf 光标在目标行的上/下半（决定插上/插下）
  const [dragId, setDragId] = useState<number | null>(null);
  const [overSlot, setOverSlot] = useState<TimeSlot | "left" | null>(null);
  const [overIdx, setOverIdx] = useState<number | null>(null);
  const [overHalf, setOverHalf] = useState<"top" | "bottom" | null>(null);
  // 拖拽浮层（drag ghost）：跟随光标的半透明预览卡片
  const [dragPos, setDragPos] = useState<{ x: number; y: number } | null>(null);
  // 三时段「收纳文件夹」：一次只展开一个时段，其余收起；点标题切换。
  // openSlot / setOpenSlot 由 App 以 props 传入，切走再切回 Next 时保留上次展开项。
  const slotDragRef = useRef<{ id: number } | null>(null);
  // 自动滚动时用的镜像 ref，避免闭包读不到最新落点
  const overSlotRef = useRef<TimeSlot | "left" | null>(null);
  const overIdxRef = useRef<number | null>(null);
  const overHalfRef = useRef<"top" | "bottom" | null>(null);
  // 刚发生过拖拽：在紧接的 click 上抑制，避免误触（多选模式下误选/取消）
  const justDraggedRef = useRef(false);

  useEffect(() => {
    if (active.length === 0) loadActive();
  }, [active.length, loadActive]);

  // 监听全局「快速新增」事件（App 在按 Enter 时派发）→ 打开新增 Next 弹窗
  useEffect(() => {
    const h = () => setAdding(true);
    window.addEventListener("nowtree:quick-add", h);
    return () => window.removeEventListener("nowtree:quick-add", h);
  }, []);


  // 全部 Next 事务（含 project 子事务 show_in_next=1），作为工具栏操作对象
  const items = useMemo(
    () =>
      active.filter(
        (t) =>
          ((t.category === "next_action" && t.parent_id === null) ||
            t.show_in_next),
      ),
    [active],
  );
  const ordered = useMemo(() => [...items].sort(byOrder), [items]);

  // 0.1.20：选择状态收敛到 useSelection hook
  const {
    selMode,
    setSelMode,
    selected,
    setSelected,
    confirmBatch,
    setConfirmBatch,
    toggleSel,
    toggleSelMode,
    selectAllFiltered,
    clearSel,
  } = useSelection({ items: ordered });

  // 左栏：未分配时段的 Next 事务
  const left = useMemo(
    () => items.filter((t) => t.time_slot === "none").sort(byOrder),
    [items],
  );

  // 右栏：按 time_slot 分入三个时段
  const slotItems = useMemo(() => {
    const m: Record<TimeSlot, Transaction[]> = { none: [], morning: [], noon: [], evening: [] };
    for (const t of items) {
      if (t.time_slot !== "none") m[t.time_slot].push(t);
    }
    for (const s of SLOTS) m[s].sort(byOrder);
    return m;
  }, [items]);

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
    getCompletedIds: () =>
      ordered.filter((t) => t.status === "completed").map((t) => t.id),
    deleteSelected: async (ids) => { for (const id of ids) await deleteTx(id); },
  });
  const { cleanCompleted, cancelClean, batchDelete, moveTo } = listActions;
  function applySort(mode: "priority" | "time" | "completion") {
    const sorted = [...items].sort(
      mode === "priority" ? byPriority : mode === "completion" ? byCompletion : byTime,
    );
    listActions.applySort(sorted.map((t) => t.id));
  }
  // 全选：仅选中「未分配时段」(left) 的事务（用户要求：工具栏全选只选未分配）
  function selectAll() {
    selectAllFiltered((t) => (t as Transaction).time_slot === "none");
  }
  // 选中某个时段（早/午/晚）list 内的全部事务
  function selectSlot(slot: TimeSlot) {
    setSelected((prev) => {
      const n = new Set(prev);
      for (const t of slotItems[slot]) n.add(t.id);
      return n;
    });
  }
  function toggleSelModeLocal() {
    toggleSelMode();
    setClearConfirm(false);
  }

  // 1.1.2：Next 行内不再放「展示在 Next」开关——该开关已移到「编辑」弹窗内（与 Waiting/Someday 同款）。
  // 行内只保留「编辑」入口，展示开关 / 改日期等管理动作统一在编辑窗口完成。
  const renderRowActions = (t: Transaction) => {
    if (selMode || dragId != null) return null;
    return (
      <button className="btn-ghost" onClick={() => setEditing(t)}>
        编辑
      </button>
    );
  };

  // ===== 拖拽：长按后在同栏内拖动排序；或拖到其它时段/左栏改分配 =====
  function slotOfId(id: number): TimeSlot | "left" {
    const t = items.find((x) => x.id === id);
    if (!t || t.time_slot === "none") return "left";
    return t.time_slot;
  }
  function listIdsOf(slot: TimeSlot | "left"): number[] {
    return (slot === "left" ? left : slotItems[slot]).map((t) => t.id);
  }
  function startSlotDrag(e: React.PointerEvent, id: number) {
    if (selMode) return;
    if (e.button !== 0) return;
    const target = e.target as HTMLElement;
    if (target.closest("button, input, textarea, select, a, label")) return;
    const tx = items.find((t) => t.id === id);
    if (tx && tx.status === "completed") {
      // 0.1.19：已完成事务不可拖动——长按给提示，不进入拖拽
      let pt: number | null = window.setTimeout(() => {
        showToast("已完成事务无法拖拽");
      }, LONG_PRESS_MS);
      const pMove = (ev: PointerEvent) => {
        if (isBeyondThreshold(ev.clientX - startX, ev.clientY - startY)) {
          if (pt != null) {
            clearTimeout(pt);
            pt = null;
          }
        }
      };
      const pUp = () => {
        if (pt != null) {
          clearTimeout(pt);
          pt = null;
        }
      };
      window.addEventListener("pointermove", pMove);
      window.addEventListener("pointerup", pUp);
      return;
    }
    const startX = e.clientX;
    const startY = e.clientY;
    const startEl = (e.target as HTMLElement | null)?.closest("[data-drag-idx]") as HTMLElement | null;
    const listRoot = startEl?.closest(".tx-list") as HTMLElement | null;
    const scroller = findScrollableAncestor(listRoot);
    const srcSlot = slotOfId(id);
    let started = false;
    let rafId: number | null = null;
    let timer: number | null = null;
    let overCatEl: HTMLElement | null = null; // 跨类别：当前高亮的左侧分类导航项
    const lastMove = { ev: null as PointerEvent | null, x: e.clientX, y: e.clientY };

    // 命中的栏：某时段（data-slot）或左栏（data-left-list）
    const hit = (ev: PointerEvent): TimeSlot | "left" | null => {
      const el = document.elementFromPoint(ev.clientX, ev.clientY) as HTMLElement | null;
      const slot = el?.closest("[data-slot]") as HTMLElement | null;
      if (slot) return slot.dataset.slot as TimeSlot;
      const leftListEl = el?.closest("[data-left-list]") as HTMLElement | null;
      if (leftListEl) return "left";
      return null;
    };
    // 命中的行 id + 光标在该行的上/下半（同栏/跨栏排序的插入方向：top=插上、bottom=插下）
    // 0.1.18：命中空白缝隙/列表边缘时，找最近行，确保落点高亮始终可见。
    const rowHalf = (
      ev: PointerEvent,
      targetList: HTMLElement | null,
    ): { rowId: number | null; half: "top" | "bottom" } => {
      const el = document.elementFromPoint(ev.clientX, ev.clientY) as HTMLElement | null;
      // 0.1.19：悬停在工具栏 / 下拉菜单 / 左侧导航栏时，不当作列表行落点
      //   （拖动中本就不能点它们；避免这些区域仍高亮最近行）。
      if (el?.closest(".list-toolbar, .dropdown-menu, .side-menu")) {
        return { rowId: null, half: "top" };
      }
      let li = el?.closest("[data-drag-idx]") as HTMLElement | null;
      if (!li) {
        // 0.1.19：回退到「目标栏」的列表根，而非拖拽起点列表（listRoot）。
        //   否则从左侧未分配栏拖到右侧已展开时段时，光标不在行上会回退到左栏找最近行，
        //   导致左栏误亮绿线（与 0.1.18 跨类别修复同思路：落点指示只应出现在真正悬停的栏）。
        //   最近行计算复用共享原语 nearestRowEl（valid=null → 仅排除自身）。
        const root = targetList ?? listRoot ?? findScrollableAncestor(el) ?? el?.closest(".tx-list");
        li = nearestRowEl(root, ev.clientY, null, id);
      }
      if (!li) return { rowId: null, half: "top" };
      const r = li.getBoundingClientRect();
      const half = rowHalfOf(r.top, r.height, ev.clientY);
      return { rowId: Number(li.dataset.dragIdx), half };
    };
    // 自动滚动（auto-scroll）：拖到列表上下边缘时，让实际可滚动祖先自己滚，
    // 并实时把落点行标到当前列表根（listRoot）露出来的最前/最后一行，松手即可排到两端。
    const autoScrollTick = () => {
      // 持续调度：首帧 ev 未就绪只跳过滚动、不可自杀式 return，否则自动滚动失效
      if (!started) {
        rafId = null;
        return;
      }
      rafId = requestAnimationFrame(autoScrollTick);
      const ev = lastMove.ev;
      if (!ev) return;
      // 0.2.0 修复：自动滚动的滚动容器取「当前光标下方所在的列表」，而非拖拽起点的固定 scroller。
      //   这样从「未分配时段」(左栏) 拖到右侧已展开的时段时，光标落在右栏列表上，
      //   滚动与落点高亮都作用于右栏，不再「死盯着」左栏不动。
      const under = document.elementFromPoint(ev.clientX, ev.clientY) as HTMLElement | null;
      const tList = under?.closest(".tx-list") as HTMLElement | null;
      const list = tList ? (findScrollableAncestor(tList) ?? tList) : scroller;
        if (list) {
          const r = list.getBoundingClientRect();
          const m = AUTOSCROLL_EDGE_PX; // 边缘触发区高度
          const nearBottom = ev.clientY > r.bottom - m;
          const nearTop = ev.clientY < r.top + m;
          // 0.1.19：光标须「横向」也落在滚动容器内，才滚动/标边行。
          //   拖到左侧导航栏（去改类）时，Y 贴近列表边沿不应误触发滚动/高亮最末行。
          const overX = ev.clientX >= r.left && ev.clientX <= r.right;
          if (overX && (nearBottom || nearTop)) {
          list.scrollTop += nearBottom ? AUTOSCROLL_STEP_PX : -AUTOSCROLL_STEP_PX;
          const rows = tList
            ? (Array.from(tList.querySelectorAll("[data-drag-idx]")) as HTMLElement[]).filter(
                (x) => Number(x.dataset.dragIdx) !== id,
              )
            : [];
          if (rows.length) {
            const edgeId = Number(
              (nearBottom ? rows[rows.length - 1] : rows[0]).dataset.dragIdx,
            );
            const slotEl = under?.closest("[data-slot]") as HTMLElement | null;
            const slot: TimeSlot | "left" =
              (slotEl?.dataset.slot as TimeSlot) ||
              (under?.closest("[data-left-list]") ? "left" : srcSlot);
            overSlotRef.current = slot;
            overIdxRef.current = edgeId;
            overHalfRef.current = nearBottom ? "bottom" : "top";
            setOverSlot(slot);
            setOverIdx(edgeId);
            setOverHalf(nearBottom ? "bottom" : "top");
          }
        }
      }
    };
    const begin = () => {
      if (started) return;
      started = true;
      slotDragRef.current = { id };
      setDragId(id);
      setDragPos({ x: lastMove.x, y: lastMove.y });
      rafId = requestAnimationFrame(autoScrollTick);
      enterDragVisuals();
    };
    const move = (ev: PointerEvent) => {
      lastMove.ev = ev;
      lastMove.x = ev.clientX;
      lastMove.y = ev.clientY;
      if (!started) {
        // 长按期间若移动超过阈值，视为滑动/滚动，取消拖拽
        if (isBeyondThreshold(ev.clientX - startX, ev.clientY - startY)) {
          cleanup();
        }
        return;
      }
      setDragPos({ x: ev.clientX, y: ev.clientY });
      // 跨类别：若悬停在左侧分类导航栏（带 data-cat 的 nav-item），高亮它并清空时段指示
      const under = document.elementFromPoint(ev.clientX, ev.clientY) as HTMLElement | null;
      const catEl = under?.closest("[data-cat]") as HTMLElement | null;
      // 0.1.19：仅「原生 next_action（category=next_action 且 parent_id=null）」可在 Next 改类别；
      //   其余在 Next 展示的外来项（project 子项 / waiting / someday 凭 show_in_next 展示）一律不可改类别。
      //   注意：project 子项虽 category=next_action，但 parent_id 有值，必须排除。
      const curTx = slotDragRef.current
        ? items.find((t) => t.id === slotDragRef.current!.id)
        : null;
      const nativeNext = !!curTx && curTx.category === "next_action" && curTx.parent_id === null;
      const foreign = !nativeNext;
      if (catEl && !foreign) {
        const cat = catEl.dataset.cat as string;
        // 0.1.18：Inbox / Next 导航项在拖拽时不高亮（inbox↔类别禁止互转，next 是自家类别）
        if (cat === "inbox" || cat === "next") {
          if (overCatEl !== null) {
            overCatEl.classList.remove("cat-drop-over");
            overCatEl = null;
          }
          overSlotRef.current = null;
          setOverSlot(null);
          overIdxRef.current = null;
          overHalfRef.current = null;
          setOverIdx(null);
          setOverHalf(null);
          return;
        }
        if (overCatEl !== catEl) {
          overCatEl?.classList.remove("cat-drop-over");
          catEl.classList.add("cat-drop-over");
          overCatEl = catEl;
        }
        overSlotRef.current = null;
        setOverSlot(null);
        overIdxRef.current = null;
        overHalfRef.current = null;
        setOverIdx(null);
        setOverHalf(null);
        return;
      } else if (overCatEl) {
        overCatEl.classList.remove("cat-drop-over");
        overCatEl = null;
      }
      const h = hit(ev);
      overSlotRef.current = h;
      setOverSlot(h);
      if (!h) {
        // 悬停到空白：清空行级插入指示
        overIdxRef.current = null;
        overHalfRef.current = null;
        setOverIdx(null);
        setOverHalf(null);
        return;
      }
      // 行级精确插入位：仅当“目标栏列表可见”时才显示——
      // 左栏常驻可见；三个时段中只有“已展开”那一个可见；其余两个收起的文件夹只高亮整列。
      const targetVisible = h === "left" || h === openSlot;
      if (targetVisible) {
        // 0.1.19：按当前悬停的栏（h）取对应列表容器作为落点回退根，
        //   避免拖到右栏时段仍回退到左栏而误亮左栏绿线。
        let targetList: HTMLElement | null = null;
        if (h === "left") {
          targetList = document.querySelector("[data-left-list] .tx-list") as HTMLElement | null;
        } else {
          targetList = document.querySelector(`[data-slot="${h}"] .tx-list`) as HTMLElement | null;
        }
        const { rowId, half } = rowHalf(ev, targetList);
        overIdxRef.current = rowId;
        overHalfRef.current = half;
        setOverIdx(rowId);
        setOverHalf(half);
      } else {
        overIdxRef.current = null;
        overHalfRef.current = null;
        setOverIdx(null);
        setOverHalf(null);
      }
    };
    const up = (ev: PointerEvent) => {
      if (started && slotDragRef.current) {
        justDraggedRef.current = true;
        const did = slotDragRef.current.id;
        const upUnder = document.elementFromPoint(ev.clientX, ev.clientY) as HTMLElement | null;
        const catEl = upUnder?.closest("[data-cat]") as HTMLElement | null;
        if (catEl) {
          ev.preventDefault();
          const cat = catEl.dataset.cat as string;
          // 0.1.18：inbox/Next 导航无操作；其余类别改类别并离开 Next 上下文。
          //   仅「原生 next_action（无父、且非他人父项）」可改类别；project 子项等外来项一律不改。
          if (cat !== "inbox" && cat !== "next") {
            const tx = active.find((t) => t.id === did);
            if (
              tx &&
              tx.category === "next_action" &&
              tx.parent_id === null &&
              !active.some((c) => c.parent_id === did)
            ) {
              const c = CAT_MAP[cat];
              // 离开 Next 上下文：清 parent_id、重置 time_slot、并确保 show_in_next=0（防止外来项残留 Next）
              if (c) updateTx(did, { category: c, clear_parent: true, time_slot: "none", show_in_next: false });
            }
          }
        } else {
          const h = hit(ev) ?? overSlotRef.current;
          if (h && h !== srcSlot) {
            // 跨栏：改分配时段（拖到左栏 = 取消分配），并支持精确插入位置。
            const dst = h === "left" ? "none" : h;
            const dstIds = listIdsOf(h); // 目标栏当前顺序（不含被拖项）
            const targetVisible = h === "left" || h === openSlot;
            let insertAt = dstIds.length; // 默认追加末尾（收起的文件夹无精确位置）
            if (targetVisible) {
              const tList = h === "left"
                ? (document.querySelector("[data-left-list] .tx-list") as HTMLElement | null)
                : (document.querySelector(`[data-slot="${h}"] .tx-list`) as HTMLElement | null);
              const rh = rowHalf(ev, tList);
              let hitId = rh.rowId ?? overIdxRef.current;
              let half: "top" | "bottom" = rh.half;
              if (hitId == null && overHalfRef.current) half = overHalfRef.current;
              if (hitId != null) {
                const ti = dstIds.indexOf(hitId);
                if (ti !== -1) insertAt = half === "top" ? ti : ti + 1;
              }
            }
            // 重组四栏全局顺序：源栏移除被拖项，目标栏 insertAt 处插入；reorder 按数组位置重写 order_index
            const slotsOrder: (TimeSlot | "left")[] = ["left", "morning", "noon", "evening"];
            const global: number[] = [];
            for (const s of slotsOrder) {
              let arr = listIdsOf(s);
              if (s === srcSlot) arr = arr.filter((x) => x !== did);
              if (s === h) {
                arr = [...arr];
                arr.splice(insertAt, 0, did);
              }
              global.push(...arr);
            }
            updateTx(did, { time_slot: dst });
            reorder(global);
          } else if (h && h === srcSlot) {
            // 同栏内：拖动排序（按光标在目标行的上/下半决定插上还是插下；边缘自动滚动落点用镜像 ref 兜底）
            const tList = srcSlot === "left"
              ? (document.querySelector("[data-left-list] .tx-list") as HTMLElement | null)
              : (document.querySelector(`[data-slot="${srcSlot}"] .tx-list`) as HTMLElement | null);
            const rh = rowHalf(ev, tList);
            let oId = rh.rowId;
            let half = rh.half;
            if (oId == null) { oId = overIdxRef.current; half = overHalfRef.current ?? "top"; }
            const listIds = listIdsOf(srcSlot);
            const cur = listIds.indexOf(did);
            const oi = oId != null ? listIds.indexOf(oId) : -1;
            if (cur !== -1 && oi !== -1 && cur !== oi && oId != null) {
              const next = [...listIds];
              const [mm] = next.splice(cur, 1);
              // 移除被拖项后，目标行在新数组中的下标 tIdx；top=插到目标前，bottom=插到目标后
              let tIdx = next.indexOf(oId);
              if (tIdx === -1) tIdx = next.length;
              next.splice(half === "top" ? tIdx : tIdx + 1, 0, mm);
              // 重组四栏拼接的全局有序 id，reorder 按数组顺序重写 order_index
              const global = [
                ...(srcSlot === "left" ? next : listIdsOf("left")),
                ...(srcSlot === "morning" ? next : listIdsOf("morning")),
                ...(srcSlot === "noon" ? next : listIdsOf("noon")),
                ...(srcSlot === "evening" ? next : listIdsOf("evening")),
              ];
              reorder(global);
            }
          }
        }
      }
      cleanup();
    };
    const cleanup = () => {
      if (timer != null) {
        clearTimeout(timer);
        timer = null;
      }
      if (rafId != null) {
        cancelAnimationFrame(rafId);
        rafId = null;
      }
      started = false;
      lastMove.ev = null;
      if (overCatEl) {
        overCatEl.classList.remove("cat-drop-over");
        overCatEl = null;
      }
      overSlotRef.current = null;
      overIdxRef.current = null;
      overHalfRef.current = null;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      slotDragRef.current = null;
      setDragId(null);
      setOverSlot(null);
      setOverIdx(null);
      setOverHalf(null);
      setDragPos(null);
      exitDragVisuals();
    };

    timer = window.setTimeout(begin, LONG_PRESS_MS);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  // 0.1.20：原 NextRow 函数组件已收敛为共享 TxRow（见 ./TxRow）。
  // 拖拽接线(startSlotDrag) 与行 className 组合仍在此处按 Next 规则生成，行为零改动。

  const slotTotal = SLOTS.reduce((s, sl) => s + slotItems[sl].length, 0);

  // 拖拽浮层要显示的事务（仅拖动中）
  const dragTx = dragId != null ? items.find((t) => t.id === dragId) ?? null : null;

  return (
    <section className="view next-view">
      <header className="view-header">
        <h2>Next Actions</h2>
        <span className="count-badge">{left.length + slotTotal}</span>
      </header>
      <p className="view-sub muted">
        左栏是未分配时段的下一步；长按拖到右栏的早 / 午 / 晚，分配今天三个时段要做的任务，启动弹窗会据此介绍今天。
      </p>

      {/* 0.1.20：工具栏收敛为共享 ListToolbar */}
      <ListToolbar
        selMode={selMode}
        selectedCount={selected.size}
        confirmBatch={confirmBatch}
        setConfirmBatch={setConfirmBatch}
        onToggleSelMode={toggleSelModeLocal}
        cleanConfirm={clearConfirm}
        cleanDisabled={!clearConfirm && ordered.filter((t) => t.status === "completed").length === 0}
        onClean={cleanCompleted}
        onCancelClean={cancelClean}
        onSort={applySort}
        onMove={moveTo}
        selectAllTitle="仅选中未分配时段的事务"
        onSelectAll={selectAll}
        onClearSel={clearSel}
        onBatchDelete={batchDelete}
      />

      <div className="next-split" ref={containerRef}>
        <div className={`next-left ${overSlot === "left" ? "drop-over" : ""}`} data-left-list>
          <ul className="tx-list">
            {left.map((t) => (
              <TxRow
                key={t.id}
                tx={t}
                className={
                  "tx-item next-row draggable-row" +
                  (t.status === "completed" ? " done" : "") +
                  (t.priority != null ? ` pri-row-${t.priority}` : "") +
                  (dragId === t.id ? " dragging" : "") +
                  (overIdx === t.id && dragId !== t.id
                    ? ` drag-over ${overHalf === "bottom" ? "drag-over-bottom" : "drag-over-top"}`
                    : "") +
                  ((selMode || clearConfirm) && selected.has(t.id) ? " selected" : "")
                }
                rowProps={{
                  "data-drag-idx": t.id,
                  title: selMode ? "点击整行选中/取消" : "长按拖动：同栏内排序，或拖到其它时段改分配",
                  onPointerDown: (e) => startSlotDrag(e, t.id),
                  onClick: () => {
                    if (justDraggedRef.current) {
                      justDraggedRef.current = false;
                      return;
                    }
                    if (selMode) toggleSel(t.id);
                  },
                }}
                gutter={selMode ? "sel" : "done"}
                selected={selected.has(t.id)}
                onToggleSelect={() => toggleSel(t.id)}
                done={t.status === "completed"}
                onToggleDone={() => toggleComplete(t.id)}
                showMeta
                showSource
                expandedNoteId={expandedNoteId}
                setExpandedNoteId={setExpandedNoteId}
                actions={renderRowActions(t)}
              />
            ))}
            {left.length === 0 && <li className="next-empty muted">都分配好啦 🎉</li>}
          </ul>
        </div>

        <div className="next-right">
          {SLOTS.map((slot) => {
            const collapsed = openSlot !== slot;
            return (
              <div
                key={slot}
                className={`next-slot ${collapsed ? "collapsed" : ""} ${
                  overSlot === slot ? "drop-over" : ""
                }`}
                data-slot={slot}
              >
                <div
                  className="next-col-head folder-head"
                  onClick={() => {
                    // 始终有一个时段展开：点已展开的不变，点别的则切换过去
                    if (openSlot !== slot) setOpenSlot(slot);
                  }}
                  title="点击切换展开此时段（始终有一个时段是展开的）"
                >
                  <span className="folder-name">{TIME_SLOT_LABELS[slot]}（{slotItems[slot].length}）</span>
                  {selMode && (
                    <button
                      className="btn-ghost slot-selectall"
                      onClick={(e) => {
                        e.stopPropagation();
                        selectSlot(slot);
                      }}
                      disabled={slotItems[slot].length === 0}
                    >
                      全选
                    </button>
                  )}
                  <span className="folder-chevron">{collapsed ? "\u25B8" : "\u25BE"}</span>
                </div>
                {!collapsed && (
                  <ul className="tx-list">
                    {slotItems[slot].map((t) => (
                      <TxRow
                key={t.id}
                tx={t}
                className={
                  "tx-item next-row draggable-row" +
                  (t.status === "completed" ? " done" : "") +
                  (t.priority != null ? ` pri-row-${t.priority}` : "") +
                  (dragId === t.id ? " dragging" : "") +
                  (overIdx === t.id && dragId !== t.id
                    ? ` drag-over ${overHalf === "bottom" ? "drag-over-bottom" : "drag-over-top"}`
                    : "") +
                  ((selMode || clearConfirm) && selected.has(t.id) ? " selected" : "")
                }
                rowProps={{
                  "data-drag-idx": t.id,
                  title: selMode ? "点击整行选中/取消" : "长按拖动：同栏内排序，或拖到其它时段改分配",
                  onPointerDown: (e) => startSlotDrag(e, t.id),
                  onClick: () => {
                    if (justDraggedRef.current) {
                      justDraggedRef.current = false;
                      return;
                    }
                    if (selMode) toggleSel(t.id);
                  },
                }}
                gutter={selMode ? "sel" : "done"}
                selected={selected.has(t.id)}
                onToggleSelect={() => toggleSel(t.id)}
                done={t.status === "completed"}
                onToggleDone={() => toggleComplete(t.id)}
                showMeta
                showSource
                expandedNoteId={expandedNoteId}
                setExpandedNoteId={setExpandedNoteId}
                actions={renderRowActions(t)}
              />
                    ))}
                    {slotItems[slot].length === 0 && (
                      <li className="next-empty muted">把任务拖到这里</li>
                    )}
                  </ul>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {editing && (
        <EditModal
          tx={editing}
          onClose={() => setEditing(null)}
          hideCategory={!(editing.category === "next_action" && editing.parent_id === null)}
        />
      )}

      <Fab label="新增 Next 事务" onClick={() => setAdding(true)} />
      {adding && (
        <AddModal category="next_action" onClose={() => setAdding(false)} />
      )}

      {/* 0.1.20：拖拽浮层收敛为共享 DragGhost */}
      <DragGhost tx={dragTx} pos={dragPos} />
    </section>
  );
}
