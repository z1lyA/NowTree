import { useCallback, useRef, useState } from "react";
import type React from "react";
import {
  LONG_PRESS_MS,
  AUTOSCROLL_EDGE_PX,
  AUTOSCROLL_STEP_PX,
  listRootOf,
  findScrollableAncestor,
  rowHalfOf,
  nearestRowEl,
  enterDragVisuals,
  exitDragVisuals,
  isBeyondThreshold,
} from "./dragUtils";
import { useTxStore } from "../store/useTxStore";

// 基于 Pointer Events 的列表拖拽排序（不依赖 HTML5 原生 DnD，规避 WebView 里"禁止"光标）。
// 0.1.9：去掉拖拽手柄，改为「长按整条」触发。
// 0.1.18：全面对齐 NextView 的拖拽手感与落点精确高亮：
//   - 长按 220ms 显示气泡浮层；长按前移动超过 10px 取消。
//   - 列表内排序按光标在目标行的上半/下半决定插入方向（top/bottom）。
//   - 空白缝隙/列表边缘命中时自动找到最近行，确保落点高亮不消失。
//   - 跨类别拖到左侧导航栏时，禁用 Inbox 高亮（四类↔Inbox 禁止互转）。
//   - 已完成事务不可拖动改类别/排序（返回不启动拖拽）。
//   - 提供 dragPos 供视图渲染跟随光标的半透明气泡。
//
// 列表每项需带 data-drag-idx={index}，用于命中检测。
// 0.1.19：底层几何/查找原语（长按阈值、可滚动祖先、最近行、上半/下半判定）
//   已抽到 ./dragUtils，本钩子只保留各自的编排逻辑。

export interface DragOpts {
  allowCrossCat?: boolean;
  onCatTarget?: (id: number, cat: string) => void;
  allowReparent?: boolean;
  onReparent?: (id: number, parentId: number) => void;
  disabled?: boolean; // 为 true 时本条不可拖动（如已完成）
  disabledCats?: string[]; // 跨类别时这些导航项不高亮、不响应（默认包含 inbox）
  onDisabledPress?: () => void; // 0.1.19：本条 disabled 时长按给出的提示（如「已完成无法拖拽」）
  excludeParentId?: number; // 0.1.19：改父时排除「自己的原父」（不能把子事务拖回它本来所在的父）
  // 1.1.3：拖到垃圾桶悬浮窗（[data-trash]）即删除；优先级高于跨类别/改父/排序，故最早判定。
  onTrash?: (id: number) => void;
}

export function useListDrag() {
  const [dragId, setDragId] = useState<number | null>(null);
  const [overIdx, setOverIdx] = useState<number | null>(null);
  const [overHalf, setOverHalf] = useState<"top" | "bottom" | null>(null);
  const [dragPos, setDragPos] = useState<{ x: number; y: number } | null>(null);
  const ref = useRef<{
    dragId: number | null;
    overCat: HTMLElement | null;
    overParent: HTMLElement | null;
    listRoot: HTMLElement | null;
    scroller: HTMLElement | null;
    // 0.1.19 修复：拖拽过程中 move 阶段已正确计算并高亮的最近落点；
    // 释放时若 rowHalf 未精确命中行，回退到它，避免错误落到列表最顶。
    lastOver: { idx: number | null; half: "top" | "bottom" } | null;
  }>({
    dragId: null,
    overCat: null,
    overParent: null,
    listRoot: null,
    scroller: null,
    lastOver: null,
  });

  const startDrag = useCallback(
    (
      e: React.PointerEvent,
      id: number,
      orderedIds: number[],
      onReorder: (ids: number[]) => void,
      opts?: DragOpts,
    ) => {
      if (e.button !== 0) return; // 仅左键
      // 交互元素上按下不拖（按钮 / 勾选框 / 输入 / 下拉 / 链接 / label 等）
      const target = e.target as HTMLElement | null;
      if (target && target.closest("button, input, textarea, select, a, label")) {
        return;
      }

      const startX = e.clientX;
      const startY = e.clientY;
      const startEl = (e.target as HTMLElement | null)?.closest("[data-drag-idx]") as HTMLElement | null;
      const listRoot = listRootOf(startEl);
      const scroller = findScrollableAncestor(listRoot);

      // 0.1.19：已完成等禁止拖动——长按给提示，不进入拖拽。
      if (opts?.disabled) {
        let timer: number | null = null;
        const cleanup = () => {
          if (timer != null) {
            clearTimeout(timer);
            timer = null;
          }
          window.removeEventListener("pointermove", onMove);
          window.removeEventListener("pointerup", onUp);
        };
        const onMove = (ev: PointerEvent) => {
          if (isBeyondThreshold(ev.clientX - startX, ev.clientY - startY)) {
            cleanup();
          }
        };
        const onUp = () => cleanup();
        timer = window.setTimeout(() => {
          cleanup();
          opts.onDisabledPress?.();
        }, LONG_PRESS_MS);
        window.addEventListener("pointermove", onMove);
        window.addEventListener("pointerup", onUp);
        return;
      }

      let started = false;
      let timer: number | null = null;
      let rafId: number | null = null;
      const lastEv = { ev: null as PointerEvent | null, x: startX, y: startY };
      const disabledCats = new Set(opts?.disabledCats ?? ["inbox"]);

      // 清理悬停高亮（跨类别 / 改父 两类落点的 classList 由本钩子托管）
      const clearHover = () => {
        if (ref.current.overCat) {
          ref.current.overCat.classList.remove("cat-drop-over");
          ref.current.overCat = null;
        }
        if (ref.current.overParent) {
          ref.current.overParent.classList.remove("reparent-over");
          ref.current.overParent = null;
        }
      };

      // 0.1.19：本次拖拽「合法落点行」集合——只有 orderedIds 里的行才算。
      //   过滤掉跨组的行：拖子事务时排除所有父行（父 <li> 也带 data-drag-idx），
      //   拖父事务时排除嵌套的子行。否则会出现「子不能在原父内排序」
      //   「子拖到父附近却高亮父的顶端/底端」等错位。
      const valid = new Set(orderedIds);
      // 命中目标行 + 光标在该行的上半/下半；空白缝隙/边缘时找最近行
      const rowHalf = (ev: PointerEvent): { idx: number | null; half: "top" | "bottom" } => {
        const under = document.elementFromPoint(ev.clientX, ev.clientY) as HTMLElement | null;
        // 0.1.19：悬停在视图工具栏 / 下拉菜单 / 左侧导航栏时，不当作列表行落点
        //   （拖动中本就不能点它们；避免这些区域仍高亮最近行）。
        if (under?.closest(".list-toolbar, .dropdown-menu, .side-menu")) {
          return { idx: null, half: "top" };
        }
        let li = under?.closest("[data-drag-idx]") as HTMLElement | null;
        if (li && !valid.has(Number(li.dataset.dragIdx))) li = null;
        if (!li) {
          // 0.1.19：复用共享原语 nearestRowEl（带 valid 过滤、排除自身 id），
          // 与 NextView 共用同一套「空白缝隙/边缘找最近行」逻辑，消除重复。
          const root = listRootOf(under) ?? findScrollableAncestor(under) ?? under?.closest(".tx-list");
          li = nearestRowEl(root, ev.clientY, valid, id);
        }
        if (!li) return { idx: null, half: "top" };
        const rect = li.getBoundingClientRect();
        const half = rowHalfOf(rect.top, rect.height, ev.clientY);
        return { idx: Number(li.dataset.dragIdx), half };
      };

      // 0.1.19：自动滚动（auto-scroll）。拖到列表上下边缘时让可滚动祖先自己滚，
      // 并把落点行标到当前列表根（listRoot）露出来的最前/最后一行，松手即可排到两端。
      const autoScrollTick = () => {
      if (!started) {
        rafId = null;
        return;
      }
      // 持续调度：首帧 ev 尚未就绪只跳过滚动，不可自杀式 return，否则自动滚动失效
      rafId = requestAnimationFrame(autoScrollTick);
      const ev = lastEv.ev;
      if (!ev) return;
      const list = ref.current.scroller;
        if (list) {
          const r = list.getBoundingClientRect();
          const m = AUTOSCROLL_EDGE_PX; // 边缘触发区高度
          const nearBottom = ev.clientY > r.bottom - m;
          const nearTop = ev.clientY < r.top + m;
          // 0.1.19：光标必须「横向」也落在滚动容器内，才滚动/标边行。
          //   否则拖到左侧导航栏（去改类）或工具栏时，只要 Y 贴近列表边沿仍会误滚动+高亮最末行。
          const overX = ev.clientX >= r.left && ev.clientX <= r.right;
          if (overX && (nearBottom || nearTop)) {
            list.scrollTop += nearBottom ? AUTOSCROLL_STEP_PX : -AUTOSCROLL_STEP_PX;
            const root = ref.current.listRoot;
            const rows = root
              ? (Array.from(root.querySelectorAll("[data-drag-idx]")) as HTMLElement[]).filter(
                  (r) => Number(r.dataset.dragIdx) !== id,
                )
              : [];
            if (rows.length) {
              const edge = rows[nearBottom ? rows.length - 1 : 0];
              const edgeHalf = nearBottom ? "bottom" : "top";
              // 0.1.19 修复：同步记录到 lastOver，自动滚动到边缘后释放也能落到该边行
              ref.current.lastOver = { idx: Number(edge.dataset.dragIdx), half: edgeHalf };
              setOverIdx(Number(edge.dataset.dragIdx));
              setOverHalf(edgeHalf);
            }
          }
        }
      };

      const begin = () => {
        timer = null;
        started = true;
        ref.current.dragId = id;
        ref.current.listRoot = listRoot;
        ref.current.scroller = scroller;
        setDragId(id);
        setDragPos({ x: startX, y: startY });
        rafId = requestAnimationFrame(autoScrollTick);
        enterDragVisuals();
        // 1.1.3：标记拖拽开始 → 垃圾桶悬浮窗显形
        useTxStore.getState().setDragUI({ active: true });
      };

      const move = (ev: PointerEvent) => {
        lastEv.ev = ev;
        lastEv.x = ev.clientX;
        lastEv.y = ev.clientY;
        if (!started) {
          // 长按尚未触发：若移动过大（用户想滚动/选择文字），取消长按
          if (isBeyondThreshold(ev.clientX - startX, ev.clientY - startY)) {
            cleanup();
          }
          return;
        }
        setDragPos({ x: ev.clientX, y: ev.clientY });
        const under = document.elementFromPoint(ev.clientX, ev.clientY) as HTMLElement | null;

        // 1.1.3：拖到垃圾桶悬浮窗 = 最高优先级删除落点（高于跨类别/改父/排序）。
        // 命中即点亮垃圾桶、清空其它落点高亮，并 return（不再做行级/类别指示）。
        if (opts?.onTrash) {
          const trashEl = under?.closest("[data-trash]") as HTMLElement | null;
          if (trashEl) {
            useTxStore.getState().setDragUI({ onTrash: true });
            clearHover();
            setOverIdx(null);
            setOverHalf(null);
            return;
          }
          // 离开垃圾桶：复位高亮（值不变不触发重渲染）
          useTxStore.getState().setDragUI({ onTrash: false });
        }

        // 跨类别：左侧导航栏（data-cat）作为落点，高亮它并清空行级指示
        if (opts?.allowCrossCat) {
          const catEl = under?.closest("[data-cat]") as HTMLElement | null;
          if (catEl) {
            const cat = catEl.dataset.cat as string;
            if (disabledCats.has(cat)) {
              clearHover();
            } else if (ref.current.overCat !== catEl) {
              clearHover();
              catEl.classList.add("cat-drop-over");
              ref.current.overCat = catEl;
            }
            setOverIdx(null);
            setOverHalf(null);
            return;
          }
        }
        // 改父：拖到某个父事务行（data-parent-id）作为落点
        //   （不允许拖到自己身上，也不允许拖回它自己原来的父——本就在那里）
        if (opts?.allowReparent) {
          const parentEl = under?.closest("[data-parent-id]") as HTMLElement | null;
          if (parentEl) {
            const pid = Number(parentEl.dataset.parentId);
            if (pid !== id && pid !== opts?.excludeParentId) {
              if (ref.current.overParent !== parentEl) {
                clearHover();
                parentEl.classList.add("reparent-over");
                ref.current.overParent = parentEl;
              }
              setOverIdx(null);
              setOverHalf(null);
              return;
            }
          }
        }
        clearHover();
        // 列表内排序：精确到行上半/下半
        const { idx, half } = rowHalf(ev);
        // 0.1.19 修复：记录本次 move 已正确计算的落点，供 up 释放时回退
        ref.current.lastOver = { idx, half };
        setOverIdx(idx);
        setOverHalf(half);
      };

      const up = (ev: PointerEvent) => {
        if (started) {
          const did = ref.current.dragId;
          if (did != null) {
            // 1.1.3：松手在垃圾桶 = 删除（最高优先级，早于跨类别/改父/排序）
            if (opts?.onTrash) {
              const trashEl = (document.elementFromPoint(ev.clientX, ev.clientY) as HTMLElement | null)?.closest(
                "[data-trash]",
              ) as HTMLElement | null;
              if (trashEl) {
                opts.onTrash(did);
                cleanup();
                return;
              }
            }
            // 跨类别优先：松手在导航栏 → 改类别（禁用的项不响应）
            if (opts?.allowCrossCat) {
              const catEl = (document.elementFromPoint(ev.clientX, ev.clientY) as HTMLElement | null)?.closest(
                "[data-cat]",
              ) as HTMLElement | null;
              if (catEl) {
                const cat = catEl.dataset.cat as string;
                if (!disabledCats.has(cat)) {
                  opts.onCatTarget?.(did, cat);
                }
                cleanup();
                return;
              }
            }
            // 改父次之：松手在父事务行 → 改父
            if (opts?.allowReparent) {
              const parentEl = (document.elementFromPoint(ev.clientX, ev.clientY) as HTMLElement | null)?.closest(
                "[data-parent-id]",
              ) as HTMLElement | null;
              if (parentEl) {
                const pid = Number(parentEl.dataset.parentId);
                // 0.1.19 修复：子列表底部绿线下方那小条，是「被拖子事务自己的父事务」身体死区。
                // 若落在此死区，pid 恰等于 excludeParentId；此时不能触发改父（否则原样 reparent 到自己父、
                // 排序根本没执行 → 事务留在原处），也不能提前 return，必须回落到下面的列表内排序，
                // 让「拖到底部绿线松手」能正常落到最末行。
                if (pid !== did && pid !== opts?.excludeParentId) {
                  opts.onReparent?.(did, pid);
                  cleanup();
                  return;
                }
              }
            }
            // 列表内排序（默认行为）
            let { idx, half } = rowHalf(ev);
            // 0.1.19 修复：释放时若未精确命中行（idx 为 null），
            // 回退到拖拽过程中 move 阶段已正确计算并高亮的最近落点（lastOver），
            // 该兜底存的是事务 id，下方统一用 orderedIds.indexOf 转回下标。
            if (idx == null && ref.current.lastOver) {
              idx = ref.current.lastOver.idx;
              half = ref.current.lastOver.half;
            }
            // 0.1.19 修复：data-drag-idx 绑定的是事务 id（非下标），
            // 必须把目标 id 转回 orderedIds 中的下标，才能正确做 splice 计算；
            // 之前直接用 id 当下标（远超数组长度），splice 越界插到末尾 → 等于没动。
            const cur = orderedIds.indexOf(did);
            const tIdx = idx != null ? orderedIds.indexOf(idx) : (half === "top" ? 0 : orderedIds.length);
            if (cur !== -1 && tIdx !== -1 && cur !== tIdx) {
              const next = [...orderedIds];
              const [m] = next.splice(cur, 1);
              let insertAt = tIdx;
              if (cur < tIdx) insertAt = tIdx - 1; // 移除被拖项后目标行下标前移一位
              if (half === "bottom") insertAt += 1;
              next.splice(insertAt, 0, m);
              onReorder(next);
            }
          }
        }
        cleanup();
      };

      function cleanup() {
        if (timer != null) {
          clearTimeout(timer);
          timer = null;
        }
        if (rafId != null) {
          cancelAnimationFrame(rafId);
          rafId = null;
        }
        started = false;
        clearHover();
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        ref.current.dragId = null;
        ref.current.listRoot = null;
        ref.current.scroller = null;
        ref.current.lastOver = null;
        setDragId(null);
        setOverIdx(null);
        setOverHalf(null);
        setDragPos(null);
        exitDragVisuals();
        // 1.1.3：复位拖拽 UI 态 → 垃圾桶悬浮窗隐藏
        useTxStore.getState().setDragUI({ active: false, onTrash: false });
      }

      timer = window.setTimeout(begin, LONG_PRESS_MS);
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
    },
    [],
  );

  return { dragId, overIdx, overHalf, dragPos, startDrag };
}
