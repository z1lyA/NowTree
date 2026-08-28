import { useTxStore } from "../store/useTxStore";
import type { Transaction } from "../types/transaction";

// 复用于 GenericListView(Waiting/Someday) / ProjectListView(子项) / NextView(外来项)：
// 切换「是否展示在 Next」(show_in_next)。标签随状态切换（在 Next ✓ / 加入 Next），
// 激活态 .on 见 index.css「加入 Next」按钮激活态。三处共用同一组件，避免写法漂移。
export default function NextToggleButton({
  t,
  onBeforeToggle,
}: {
  t: Transaction;
  // 切换前的副作用钩子（如 GenericListView 需先关掉行内删除确认）
  onBeforeToggle?: () => void;
}) {
  const updateTx = useTxStore((s) => s.updateTx);
  // 关键：从 store 取实时值，而非依赖父组件传入的 t。
  // EditModal 场景里 t 是「打开弹窗时的快照」，不会随 updateTx 自动刷新，
  // 若直接读 t.show_in_next，按钮会一直显示旧状态、点了没反应（且复点无效）。
  // 按 id 取 live 值后，点击立即两态切换，与 Waiting/Someday 视图同款。
  const live = useTxStore((s) => s.active.find((x) => x.id === t.id)?.show_in_next);
  const showInNext = live ?? t.show_in_next;
  return (
    <button
      className={`btn-ghost ${showInNext ? "on" : ""}`}
      onClick={() => {
        onBeforeToggle?.();
        updateTx(t.id, { show_in_next: !showInNext });
      }}
    >
      {showInNext ? "在 Next ✓" : "加入 Next"}
    </button>
  );
}
