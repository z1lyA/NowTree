// 0.2.0 / C9：把 App 的「外壳操作」收口到独立 hook（候选 C 的 ShellPort 落地）。
// 涵盖：导入导出、清空数据、开机自启动、勾选提示音、窗口关闭（最小化到托盘/退出）及其监听。
// App 只负责视图编排与渲染，不再散落 invoke / localStorage / 窗口事件。
// 纯移动 + 依赖透传，行为零改动。
import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { isCheckSoundOn, setCheckSoundOn as persistCheckSound } from "../utils/checkSound";

export interface BackupMeta {
  path: string;
  exported_at: string | null;
  count: number;
  latest_updated: string | null;
}

export interface UseShellDeps {
  showToast: (msg: string) => void;
  loadActive: () => void | Promise<void>;
  loadInbox: () => void | Promise<void>;
  loadTrash: () => void | Promise<void>;
  isDev: boolean;
  setDataOpen: (v: boolean) => void;
  /** 关闭确认弹出前，先收起其他覆盖层（如每日启动弹窗），保证关闭确认框始终置顶 */
  dismissOverlays: () => void;
}

export interface UseShellReturn {
  autostart: boolean;
  checkSoundOn: boolean;
  importMeta: BackupMeta | null;
  resetConfirmOpen: boolean;
  closeConfirm: boolean;
  dontAskAgain: boolean;
  setResetConfirmOpen: (v: boolean) => void;
  setCloseConfirm: (v: boolean) => void;
  setDontAskAgain: (v: boolean) => void;
  dismissImport: () => void;
  handleExport: () => Promise<void>;
  handleImport: () => Promise<void>;
  confirmImport: () => Promise<void>;
  confirmReset: () => Promise<void>;
  toggleAutostart: () => Promise<void>;
  toggleCheckSound: () => void;
  chooseClose: (action: "tray" | "exit") => void;
}

export function useShell(deps: UseShellDeps): UseShellReturn {
  const { showToast, loadActive, loadInbox, loadTrash, isDev, setDataOpen, dismissOverlays } = deps;
  const [autostart, setAutostart] = useState(false);
  const [checkSoundOn, setCheckSoundOn] = useState(true);
  const [importMeta, setImportMeta] = useState<BackupMeta | null>(null);
  const [resetConfirmOpen, setResetConfirmOpen] = useState(false);
  const [closeConfirm, setCloseConfirm] = useState(false);
  const [dontAskAgain, setDontAskAgain] = useState(false);

  // 0.2.0：后端拦截 X 关闭后 emit "window-close-requested"（窗口仍可见）；
  // 「不再提示」→ 按记住的默认执行；否则弹模态确认框。
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    (async () => {
      try {
        unlisten = await listen("window-close-requested", () => {
          let dismissed = false;
          let choice = "tray";
          try {
            dismissed = localStorage.getItem("nowtree_tray_hint_dismissed") === "1";
            choice = localStorage.getItem("nowtree_tray_choice") || "tray";
          } catch {
            /* ignore */
          }
          if (dismissed) {
            if (choice === "exit") invoke("quit_app");
            else invoke("minimize_to_tray");
            return;
          }
          dismissOverlays();
          // 1.1.0：同时收起数据弹窗内的应用内二级确认，避免关闭确认框与之叠层
          setResetConfirmOpen(false);
          setImportMeta(null);
          setCloseConfirm(true);
        });
      } catch {
        /* 非 Tauri 环境忽略 */
      }
    })();
    return () => {
      unlisten?.();
    };
  }, []);

  const chooseClose = (action: "tray" | "exit") => {
    if (dontAskAgain) {
      try {
        localStorage.setItem("nowtree_tray_hint_dismissed", "1");
        localStorage.setItem("nowtree_tray_choice", action);
      } catch {
        /* ignore */
      }
    }
    setCloseConfirm(false);
    setDontAskAgain(false);
    invoke(action === "exit" ? "quit_app" : "minimize_to_tray");
  };

  // 进入时读取开机自启动状态
  useEffect(() => {
    (async () => {
      try {
        const ok = await invoke<boolean>("get_autostart");
        setAutostart(ok);
      } catch {
        /* 浏览器 / 插件未就绪：保持 false */
      }
    })();
  }, []);

  // 进入时读取勾选提示音开关
  useEffect(() => {
    setCheckSoundOn(isCheckSoundOn());
  }, []);

  async function handleExport() {
    try {
      const res = await invoke<string>("export_data");
      showToast(res === "cancelled" ? "已取消导出" : "数据已导出");
    } catch (e) {
      showToast("导出失败：" + (e as Error).message);
      return;
    }
    setDataOpen(false);
  }
  async function handleImport() {
    try {
      const meta = await invoke<BackupMeta | null>("read_backup_meta");
      if (!meta) {
        showToast("已取消导入");
        setDataOpen(false);
        return;
      }
      setDataOpen(false);
      setImportMeta(meta);
    } catch (e) {
      showToast("读取备份失败：" + (e as Error).message);
    }
  }
  async function confirmImport() {
    if (!importMeta) return;
    try {
      const res = await invoke<{ count: number }>("import_data", { path: importMeta.path });
      await Promise.all([loadActive(), loadInbox(), loadTrash()]);
      showToast(`成功导入 ${res.count} 条事务`);
    } catch (e) {
      showToast("导入失败：" + (e as Error).message);
    } finally {
      setImportMeta(null);
    }
  }
  async function confirmReset() {
    try {
      await invoke("reset_all_data");
      await Promise.all([loadActive(), loadInbox(), loadTrash()]);
      showToast("已清空所有数据");
    } catch (e) {
      showToast("清空失败：" + (e as Error).message);
    } finally {
      setResetConfirmOpen(false);
      setDataOpen(false);
    }
  }
  async function toggleAutostart() {
    if (isDev) {
      showToast("开发模式不能修改自启动，请在 release 版本（nowtree.exe）中设置");
      return;
    }
    try {
      const next = !autostart;
      const ok = await invoke<boolean>("set_autostart", { enable: next });
      setAutostart(ok);
      showToast(ok ? "已开启开机自启动" : "已关闭开机自启动");
    } catch (e) {
      showToast("自启动设置失败：" + (e as Error).message);
    }
  }
  function toggleCheckSound() {
    const next = !checkSoundOn;
    setCheckSoundOn(next);
    persistCheckSound(next);
  }

  return {
    autostart,
    checkSoundOn,
    importMeta,
    resetConfirmOpen,
    closeConfirm,
    dontAskAgain,
    setResetConfirmOpen,
    setCloseConfirm,
    setDontAskAgain,
    dismissImport: () => setImportMeta(null),
    handleExport,
    handleImport,
    confirmImport,
    confirmReset,
    toggleAutostart,
    toggleCheckSound,
    chooseClose,
  };
}
