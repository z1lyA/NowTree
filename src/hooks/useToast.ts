// 轻量 toast：显示一段时间后自动消失（0.1.19 从 App 抽离）。
// 返回当前文案、可选动作按钮与 showToast 派发函数，供各视图 / 拖拽钩子调用。
// 0.2.0：showToast 支持第二个参数 action（带按钮，如「不再提示」），带动作时停留更久方便点击。
import { useRef, useState } from "react";

export interface ToastAction {
  label: string;
  onClick: () => void;
}

export function useToast() {
  const [toast, setToast] = useState<string | null>(null);
  const [toastAction, setToastAction] = useState<ToastAction | null>(null);
  const toastTimer = useRef<number | null>(null);

  function showToast(msg: string, action?: ToastAction) {
    setToast(msg);
    setToastAction(action ?? null);
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
    // 停留时长统一在 2-3s：带动作时给 3s 方便点击「撤销」；无动作 2s 自动消失。
    const delay = action ? 3000 : 2000;
    toastTimer.current = window.setTimeout(() => {
      setToast(null);
      setToastAction(null);
    }, delay);
  }

  return { toast, toastAction, showToast };
}
