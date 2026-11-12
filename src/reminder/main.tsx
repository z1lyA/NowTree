// 1.1.5：右下角提醒窗口的入口。
// 刻意不套 StrictMode：提醒窗口的挂载副作用会「取走」Rust 里的待投递卡片，
// StrictMode 的二次挂载会让第一批卡片被取走后又丢弃（开发模式下表现为提醒偶尔不显示）。
import ReactDOM from "react-dom/client";
import ReminderApp from "./ReminderApp";
import "../styles/index.css";
import "../styles/reminder.css";
import { applyStoredTheme } from "../hooks/useTheme";

// 与主窗口同理：首帧之前先套用主题（原因见 applyStoredTheme）。
// 提醒窗口是无边框卡片，闪一下深色 / 浅色比主窗口更扎眼，尤其不能省。
applyStoredTheme();

ReactDOM.createRoot(document.getElementById("reminder-root") as HTMLElement).render(
  <ReminderApp />,
);
