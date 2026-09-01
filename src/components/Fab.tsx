// 右下角悬浮加号按钮。悬停久一点由原生 title 显示说明文字（不再显示「Enter」快捷键小气泡）。
// 1.1.3：拖拽进行中（dragActive）时隐藏自身，避免遮挡底部正中的垃圾桶悬浮窗。
import { useTxStore } from "../store/useTxStore";

export default function Fab({
  label,
  onClick,
}: {
  label: string;
  onClick: () => void;
}) {
  const dragging = useTxStore((s) => s.dragActive);
  if (dragging) return null;
  return (
    <div className="fab-wrap">
      <button className="fab" title={label} onClick={onClick}>
        ＋
      </button>
    </div>
  );
}
