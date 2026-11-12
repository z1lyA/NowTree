import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles/index.css";
import { applyStoredTheme } from "./hooks/useTheme";

// 首帧之前先套用主题，否则会闪一下深色（原因见 applyStoredTheme 的说明）。
applyStoredTheme();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
