// 1.1.3：拖拽删除专用「垃圾桶」悬浮窗。
// 仅当拖拽进行中（dragActive）才渲染并可被 elementFromPoint 命中；平时返回 null，
// 不参与布局、不拦截任何交互。位于应用底部正中，与 quick-add FAB 同款圆形，
// 主色取 --accent（主题绿）。拖拽钩子把事务拖到本元素上方时点亮 .trash-drop-over（高亮 + 外环）。
import { useTxStore } from "../store/useTxStore";

export default function TrashDrop() {
  const dragActive = useTxStore((s) => s.dragActive);
  const onTrash = useTxStore((s) => s.dragOnTrash);
  if (!dragActive) return null;
  return (
    <div
      className={"trash-drop" + (onTrash ? " trash-drop-over" : "")}
      data-trash
      aria-hidden="true"
    >
      <svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true">
        <path
          fill="currentColor"
          d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"
        />
      </svg>
    </div>
  );
}
