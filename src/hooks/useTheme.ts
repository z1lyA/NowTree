// 应用主题（0.1.19 从 App 抽离）：light/dark 直接生效；system 跟随系统并监听变化。
// 返回当前 theme 与 chooseTheme 切换函数。
import { useEffect, useState } from "react";

export type ThemeMode = "light" | "dark" | "system";
const THEME_KEY = "nowtree.theme";

function applyTheme(mode: ThemeMode) {
  const root = document.documentElement;
  const mq = window.matchMedia("(prefers-color-scheme: light)");
  const eff: "light" | "dark" =
    mode === "system" ? (mq.matches ? "light" : "dark") : mode;
  root.dataset.theme = eff;
}

// 1.1.5：按 localStorage 的当前设置重新套用主题。
// 供「常驻但可能被隐藏」的提醒窗口在重新显示时同步主窗口刚改过的主题（弹窗单独一个窗口，不会随主窗口重渲染）。
export function applyStoredTheme() {
  const mode = (localStorage.getItem(THEME_KEY) as ThemeMode | null) ?? "system";
  applyTheme(mode);
}

export function useTheme() {
  const [theme, setTheme] = useState<ThemeMode>(
    () => (localStorage.getItem(THEME_KEY) as ThemeMode | null) ?? "system",
  );

  // 跟随 theme 变化应用；首次挂载也应用（读到的本地值 / 默认 system）。
  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  // system 模式下监听系统配色变化，自动重应用。
  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: light)");
    const onChange = () => {
      const cur = (localStorage.getItem(THEME_KEY) as ThemeMode | null) ?? "system";
      if (cur === "system") applyTheme("system");
    };
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  function chooseTheme(mode: ThemeMode) {
    localStorage.setItem(THEME_KEY, mode);
    setTheme(mode);
    applyTheme(mode);
  }

  return { theme, chooseTheme };
}
