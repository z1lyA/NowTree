// 0.1.20：把 GenericListView / NextView / ProjectListView 里重复的工具栏收敛成共享组件。
// 负责渲染：一键清理、排序下拉、多选开关、批量操作条（全选/取消/移动到/删除）。
// 视图通过 props 传入当前状态与回调；视图专属按钮（如 Inbox 批量转换）通过 extra 插槽注入。
// 1.1.6：一键清理 / 批量删除都不再有「二次确认」态，按钮不再变形，直接执行 + toast 撤销。
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { Category } from "../types/transaction";
import { CATEGORIES, CATEGORY_LABELS } from "../types/transaction";

type SortKey = "priority" | "time" | "completion";

export interface ListToolbarProps {
  // 选择状态
  selMode: boolean;
  selectedCount: number;
  onToggleSelMode: () => void;

  // 一键清理
  showClean?: boolean;
  cleanDisabled?: boolean;
  onClean?: () => void;

  // 排序
  showSort?: boolean;
  onSort?: (key: SortKey) => void;

  // 移动到…
  showMove?: boolean;
  onMove?: (cat: Category) => void;
  moveExtra?: ReactNode; // 如 Project 的 moveHint

  // 全选
  selectAllTitle?: string;
  onSelectAll?: () => void;
  onClearSel?: () => void;

  // 批量删除
  onBatchDelete?: () => void;

  // 视图专属区域（如 Inbox 的「批量转换」按钮）
  extra?: ReactNode;
}

export default function ListToolbar({
  selMode,
  selectedCount,
  onToggleSelMode,
  showClean = true,
  cleanDisabled = false,
  onClean,
  showSort = true,
  onSort,
  showMove = true,
  onMove,
  moveExtra,
  selectAllTitle,
  onSelectAll,
  onClearSel,
  onBatchDelete,
  extra,
}: ListToolbarProps) {
  const sortRef = useRef<HTMLDivElement>(null);
  const moveRef = useRef<HTMLDivElement>(null);
  const [sortOpen, setSortOpen] = useState(false);
  const [moveOpen, setMoveOpen] = useState(false);

  // 点外部关闭排序/移动下拉
  useEffect(() => {
    if (!sortOpen && !moveOpen) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as Node;
      if (sortOpen && sortRef.current && !sortRef.current.contains(target)) {
        setSortOpen(false);
      }
      if (moveOpen && moveRef.current && !moveRef.current.contains(target)) {
        setMoveOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [sortOpen, moveOpen]);

  // 退出多选时关闭下拉
  useEffect(() => {
    if (!selMode) {
      setSortOpen(false);
      setMoveOpen(false);
    }
  }, [selMode]);

  return (
    <div className="list-toolbar">
      {showClean && (
        <button
          className="btn-ghost tb-btn"
          onClick={onClean}
          disabled={cleanDisabled}
          title={cleanDisabled ? "没有已完成的事务，无需清理" : "清理所有已完成事务，可在提示条里撤销"}
        >
          一键清理
        </button>
      )}

      {showSort && (
        <div className="dropdown" ref={sortRef}>
          <button
            className="btn-ghost tb-btn dropdown-toggle"
            onClick={() => setSortOpen((v) => !v)}
          >
            排序
          </button>
          {sortOpen && (
            <div className="dropdown-menu">
              <button className="dropdown-item" onClick={() => { setSortOpen(false); onSort?.("priority"); }}>
                按优先度
              </button>
              <button className="dropdown-item" onClick={() => { setSortOpen(false); onSort?.("time"); }}>
                按时间
              </button>
              <button className="dropdown-item" onClick={() => { setSortOpen(false); onSort?.("completion"); }}>
                按完成情况
              </button>
            </div>
          )}
        </div>
      )}

      <button className="btn-ghost tb-btn" onClick={onToggleSelMode}>
        {selMode ? "退出多选" : "多选"}
      </button>

      {selMode && (
        <div className="batch-bar">
          <button className="btn-ghost" onClick={onSelectAll} title={selectAllTitle}>
            全选
          </button>
          <button className="btn-ghost" onClick={onClearSel}>
            取消
          </button>
          {showMove && (
            <div className="dropdown" ref={moveRef}>
              <button
                className="btn-ghost dropdown-toggle"
                onClick={() => setMoveOpen((v) => !v)}
              >
                移动到…
              </button>
              {moveOpen && (
                <div className="dropdown-menu">
                  {CATEGORIES.map((c) => (
                    <button
                      key={c}
                      className="dropdown-item"
                      onClick={() => { setMoveOpen(false); onMove?.(c); }}
                    >
                      → {CATEGORY_LABELS[c]}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
          {moveExtra}
          <button
            className="btn-danger"
            onClick={onBatchDelete}
            disabled={selectedCount === 0}
            title="删除所选事务，可在提示条里撤销"
          >
            删除（{selectedCount}）
          </button>
        </div>
      )}

      {extra}
    </div>
  );
}
