import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles/index.css";
import { applyStoredTheme } from "./hooks/useTheme";

// 1.1.7：首帧之前先套用主题，消除启动闪深色。
// 原因：styles/index.css 里 :root 的主题变量默认就是深色，浅色是靠 :root[data-theme="light"] 覆盖的；
// 而 useTheme 原本在 useEffect 里才写 data-theme——那时首帧已经画完了。
// 表现就是：系统设为浅色的用户每次启动先闪一下深色再变白。
// 这里在 render 之前同步套用一次（幂等：useTheme 挂载后还会再应用一次，结果相同）。
applyStoredTheme();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
