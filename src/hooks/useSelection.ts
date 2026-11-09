// 0.1.20：把三个列表视图里重复的选择状态逻辑收敛成共享 hook。
// 负责管理：多选模式开关、已选集合。
// 视图仍自己决定「全选范围」「批量删除/移动/清理」的具体行为，通过回调传回。
// 1.1.6：批量删除改为「点了就删 + toast 撤销」，二次确认态（confirmBatch）整体移除。
import { useState, useCallback } from "react";

export interface UseSelectionOptions<T> {
  items: T[];
  getId?: (item: T) => number;
}

export interface UseSelectionReturn {
  selMode: boolean;
  setSelMode: (v: boolean) => void;
  selected: Set<number>;
  setSelected: React.Dispatch<React.SetStateAction<Set<number>>>;
  toggleSelMode: () => void;
  toggleSel: (id: number) => void;
  selectAll: () => void;
  selectAllFiltered: (predicate: (item: unknown) => boolean) => void;
  clearSel: () => void;
}

export function useSelection<T>({
  items,
  getId = (x: unknown) => (x as { id: number }).id,
}: UseSelectionOptions<T>): UseSelectionReturn {
  const [selMode, setSelMode] = useState(false);
  const [selected, setSelected] = useState<Set<number>>(new Set());

  const reset = useCallback(() => {
    setSelected(new Set());
  }, []);

  const toggleSelMode = useCallback(() => {
    setSelMode((v) => {
      if (v) reset();
      return !v;
    });
  }, [reset]);

  const toggleSel = useCallback((id: number) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const selectAll = useCallback(() => {
    setSelected(new Set(items.map(getId)));
  }, [items, getId]);

  const selectAllFiltered = useCallback(
    (predicate: (item: unknown) => boolean) => {
      setSelected(new Set(items.filter(predicate as (item: T) => boolean).map(getId)));
    },
    [items, getId]
  );

  const clearSel = useCallback(() => {
    setSelected(new Set());
  }, []);

  return {
    selMode,
    setSelMode,
    selected,
    setSelected,
    toggleSelMode,
    toggleSel,
    selectAll,
    selectAllFiltered,
    clearSel,
  };
}
