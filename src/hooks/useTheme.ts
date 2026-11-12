// 应用主题：light / dark 直接生效；system 跟随系统深浅色。
//
// 1.1.7：系统色不再以 CSS 媒体查询为准。
// 实测（WebView2 + 本机深色模式）：Tauri 窗口里 window.matchMedia("(prefers-color-scheme: light)")
// 恒定返回 true，跟 Windows 的深色设置毫无关系 —— 于是「跟随系统」永远落在浅色，
// 这就是「系统是深色但启动却是浅色」的根因。
// 现在改为 invoke("get_system_theme")，由 Rust 读注册表 AppsUseLightTheme；
// 媒体查询只在浏览器预览（没有 IPC）时兜底。
import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

// 系统深浅色。单独给个类型名是因为它有两个来源（Rust 返回值与 localStorage 缓存），
// 两者都要过同一道校验；散写 "light" | "dark" 时难免有一处漏判。
export type SystemTheme = "light" | "dark";
export type ThemeMode = SystemTheme | "system";

const THEME_KEY = "nowtree.theme";
// 上一次读到的系统深浅色。只服务于「启动首帧」：让 system 模式不必等异步 IPC 就能上色，
// 否则每次启动都会先按兜底值画一帧再纠正（闪一下）。真正生效以 resolveSystemTheme() 为准。
const SYS_KEY = "nowtree.systemTheme";

// 复查系统色的间隔。WebView2 的 matchMedia change 事件在本项目里不可靠，
// 注册表又没有可订阅的变更事件，只能轮询——一次注册表读取，开销可忽略。
const SYSTEM_POLL_MS = 20_000;

// 把任意字符串（缓存值 / Rust 返回值）收成 SystemTheme，不合法返回 null。
function asSystemTheme(v: string | null): SystemTheme | null {
  return v === "dark" || v === "light" ? v : null;
}

function mediaTheme(): SystemTheme {
  return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

function storedMode(): ThemeMode {
  return (localStorage.getItem(THEME_KEY) as ThemeMode | null) ?? "system";
}

function cachedSystemTheme(): SystemTheme | null {
  return asSystemTheme(localStorage.getItem(SYS_KEY));
}

// 唯一真正碰 DOM 的地方：主题只由 data-theme 驱动（CSS 里没有任何 prefers-color-scheme 媒体查询）。
function paint(mode: ThemeMode, systemTheme: SystemTheme) {
  document.documentElement.dataset.theme = mode === "system" ? systemTheme : mode;
}

/** 读系统深浅色：优先问 Rust（注册表）；浏览器预览 / 命令失败时退回媒体查询。 */
export async function resolveSystemTheme(): Promise<SystemTheme> {
  let theme: SystemTheme | null = null;
  try {
    theme = asSystemTheme(await invoke<string>("get_system_theme"));
  } catch {
    // 浏览器预览没有 IPC，或是旧后端：交给下面的兜底
  }
  const resolved = theme ?? mediaTheme();
  localStorage.setItem(SYS_KEY, resolved);
  return resolved;
}

/**
 * 按「本地偏好 → 缓存/兜底系统色」同步上色。
 *
 * 为什么必须在 render() 之前调用：styles/index.css 里 :root 的主题变量默认就是深色，
 * 浅色靠 :root[data-theme="light"] 覆盖；而 useTheme 原本要到 useEffect 里才写 data-theme，
 * 那时首帧已经画完——于是系统设为浅色的用户每次启动都会先闪一下深色再变白。
 * 主窗口与提醒窗口的入口（main.tsx / reminder/main.tsx）都在 render() 前各调一次。
 * 它是幂等的：useTheme 挂载后还会再应用一次，结果相同。
 */
export function applyStoredTheme() {
  paint(storedMode(), cachedSystemTheme() ?? mediaTheme());
}

/** 读真实系统色并套用，返回读到的值。用于启动后的纠正与轮询复查。 */
export async function refreshSystemTheme(): Promise<SystemTheme> {
  const sys = await resolveSystemTheme();
  paint(storedMode(), sys);
  return sys;
}

export function useTheme() {
  const [theme, setTheme] = useState<ThemeMode>(storedMode);
  const [systemTheme, setSystemTheme] = useState<SystemTheme>(
    () => cachedSystemTheme() ?? mediaTheme(),
  );

  // 启动后纠正一次：缓存可能已经过期（比如用户刚在系统设置里换了主题）。
  useEffect(() => {
    void refreshSystemTheme().then(setSystemTheme);
  }, []);

  // 模式或系统色变了就重绘。
  useEffect(() => {
    paint(theme, systemTheme);
  }, [theme, systemTheme]);

  // 仅在 system 模式下轮询复查，避免 light / dark 用户白白多跑定时器。
  useEffect(() => {
    if (theme !== "system") return;
    const id = window.setInterval(() => {
      void refreshSystemTheme().then(setSystemTheme);
    }, SYSTEM_POLL_MS);
    return () => window.clearInterval(id);
  }, [theme]);

  function chooseTheme(mode: ThemeMode) {
    localStorage.setItem(THEME_KEY, mode);
    setTheme(mode);
    paint(mode, systemTheme);
  }

  return { theme, chooseTheme };
}
