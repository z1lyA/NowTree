// 轻量全局 toast：任意组件 / 钩子可调用 showToast(msg)，
// 由 App 订阅 onToast 渲染（复用其底部 .toast 样式与自动消失逻辑）。
// 0.2.0：showToast 支持第二个参数 action（带按钮，如「撤销」），供拖拽删除后恢复等场景。
import type { ToastAction } from "./hooks/useToast";

const TOAST_EVENT = "nowtree:toast";

export function showToast(msg: string, action?: ToastAction) {
  window.dispatchEvent(new CustomEvent(TOAST_EVENT, { detail: { msg, action } }));
}

export function onToast(
  cb: (msg: string, action?: ToastAction) => void,
): () => void {
  const handler = (e: Event) => {
    const d = (e as CustomEvent<{ msg: string; action?: ToastAction }>).detail;
    cb(d.msg, d.action);
  };
  window.addEventListener(TOAST_EVENT, handler);
  return () => window.removeEventListener(TOAST_EVENT, handler);
}
