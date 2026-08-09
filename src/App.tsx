import { useEffect, useState, useRef } from "react";
import { appDataDir, join } from "@tauri-apps/api/path";
import InboxView from "./components/InboxView";
import CategoryListView from "./components/CategoryListView";
import ProjectListView from "./components/ProjectListView";
import NextView from "./components/NextView";
import HabitsView from "./components/HabitsView";
import StartupModal from "./components/StartupModal";
import { currentClockSlot } from "./utils/clock";
import TrashModal from "./components/TrashModal";
import ShortcutsModal from "./components/ShortcutsModal";
import ThemeModal from "./components/ThemeModal";
import DataModal from "./components/DataModal";
import SettingsModal from "./components/SettingsModal";
import Modal from "./components/common/Modal";
import { useTxStore } from "./store/useTxStore";
import { isPermissionGranted, requestPermission } from "@tauri-apps/plugin-notification";
import type { TimeSlot } from "./types/transaction";
import { CATEGORIES, CATEGORY_META } from "./types/transaction";
import { useToast } from "./hooks/useToast";
import { useTheme } from "./hooks/useTheme";
import { useShell } from "./hooks/useShell";
import {
  useReminderScan,
  useDeadlineNormalize,
  useHabitReset,
  useToastSubscription,
} from "./hooks/useLifecycle";

// 侧边栏导航 key。
// inbox → InboxView；project → 专用 ProjectListView（树状）；next/waiting/someday → 通用 CategoryListView。
type ViewKey = "inbox" | "next" | "project" | "waiting" | "someday" | "habit";

// 侧边栏导航项：inbox 固定；四类从 CATEGORY_META 派生 navLabel（C4：单一来源，新增类别只改一处）。
const NAV: { key: ViewKey; label: string }[] = [
  { key: "inbox", label: "Inbox" },
  ...CATEGORIES.map((c) => ({
    key: (c === "next_action" ? "next" : c) as ViewKey,
    label: CATEGORY_META[c].navLabel,
  })),
];

export default function App() {
  const [view, setView] = useState<ViewKey>("inbox");
  // 0.1.19：记住 Next 视图当前展开的时段，切走再切回时恢复（默认「早」，不重置）
  const [openSlot, setOpenSlot] = useState<TimeSlot | null>("morning");
  const [trashOpen, setTrashOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  // 0.1.13：快捷键弹窗 / 开机自启动开关 / 操作提示 toast
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  // 0.1.20：主题弹窗 / 数据管理弹窗
  const [themeOpen, setThemeOpen] = useState(false);
  const [dataOpen, setDataOpen] = useState(false);
  // 0.2.0：设置弹窗（聚合所有开关类设置：开机自启动 / 勾选提示音…）
  const [settingsOpen, setSettingsOpen] = useState(false);
  // 0.1.16：每次启动弹「今天」介绍弹窗（开发刷新也会弹）
  const [startupOpen, setStartupOpen] = useState(true);
  // 1.0.4：跨边界重弹——记录最近一次已提示的时段，定时对比当前钟点，越过边界则重新弹出
  const lastNotifiedSlotRef = useRef(currentClockSlot());
  const closeConfirmRef = useRef(false);
  useEffect(() => {
    if (startupOpen) lastNotifiedSlotRef.current = currentClockSlot();
  }, [startupOpen]);
  useEffect(() => {
    const id = setInterval(() => {
      if (!startupOpen && !closeConfirmRef.current && currentClockSlot() !== lastNotifiedSlotRef.current) {
        setStartupOpen(true);
      }
    }, 30000);
    return () => clearInterval(id);
  }, [startupOpen]);
  // C11 修复：运行时计算真实 SQLite 文件路径，替代原硬编码（含未替换占位符「你」）。
  // 适配不同用户名 / 系统，浏览器预览环境则提示数据仅存内存。
  const [dbPath, setDbPath] = useState<string>("");
  const menuRef = useRef<HTMLDivElement>(null);
  const menuBtnRef = useRef<HTMLButtonElement>(null);
  const loadActive = useTxStore((s) => s.loadActive);
  const loadInbox = useTxStore((s) => s.loadInbox);
  const loadTrash = useTxStore((s) => s.loadTrash);
  const checkReminders = useTxStore((s) => s.checkReminders);
  const normalizeDeadlines = useTxStore((s) => s.normalizeDeadlines);
  const resetHabits = useTxStore((s) => s.resetHabits);

  // 0.1.19：toast / 主题 / 提醒扫描 / deadline 归一 抽离为独立 hook，降低 App 体积。
  const { toast, toastAction, showToast } = useToast();
  const { theme, chooseTheme } = useTheme();
  useReminderScan(checkReminders);
  useDeadlineNormalize(normalizeDeadlines);
  useHabitReset(resetHabits);
  useToastSubscription(showToast);

  // 挂载：预拉取 active；请求通知权限。
  useEffect(() => {
    loadActive();
    (async () => {
      try {
        let granted = await isPermissionGranted();
        if (!granted) {
          const res = await requestPermission();
          granted = res === "granted";
        }
      } catch {
        /* 非 Tauri 环境（浏览器）忽略 */
      }
    })();
  }, [loadActive]);

  // C11 修复：挂载时解析真实数据文件绝对路径（依赖 Tauri 的 appDataDir，
  // 由 identifier 决定，不随用户名/系统写死）。浏览器预览环境给出内存提示。
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        if (typeof window !== "undefined" && "__TAURI_INTERNALS__" in window) {
          const dir = await appDataDir();
          const full = await join(dir, "nowtree.sqlite");
          if (!cancelled) setDbPath(full);
        } else {
          if (!cancelled)
            setDbPath("（浏览器预览模式：数据仅存于内存，不写入文件）");
        }
      } catch {
        if (!cancelled) setDbPath("（无法读取数据文件路径）");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // 0.2.0：后端拦截 X 关闭后 emit "window-close-requested" 的监听、关闭确认逻辑、
  // 自启动 / 提示音读取、以及导入导出 / 清空 / 自启动 / 提示音 / 窗口关闭等操作，
  // 已统一收口到 useShell（见下方 isDev 之后调用）。

  // 0.1.13：点击左下角菜单外部区域自动关闭菜单
  useEffect(() => {
    if (!menuOpen) return;
    const handle = (e: MouseEvent) => {
      const target = e.target as Node;
      if (
        menuRef.current && !menuRef.current.contains(target) &&
        menuBtnRef.current && !menuBtnRef.current.contains(target)
      ) {
        setMenuOpen(false);
      }
    };
    document.addEventListener("pointerdown", handle);
    return () => document.removeEventListener("pointerdown", handle);
  }, [menuOpen]);

  // 当前是否处于开发模式（tauri dev / Vite dev server）。
  // release 版本该值为 false，前端内嵌在 exe 中；dev 版本为 true，依赖 localhost:1420。
  const isDev = import.meta.env.DEV;

  // C9：外壳操作（导入导出 / 清空 / 自启动 / 提示音 / 窗口关闭）收口到 useShell，
  // 避免 App 直接散落 invoke / localStorage / 窗口事件监听。
  const shell = useShell({
    showToast,
    loadActive,
    loadInbox,
    loadTrash,
    isDev,
    setDataOpen,
    // 1.1.0：关闭确认弹出前先收起其他覆盖层，确保关闭确认始终置顶
    dismissOverlays: () => {
      setStartupOpen(false);
      setSettingsOpen(false);
      setDataOpen(false);
      setTrashOpen(false);
      setShortcutsOpen(false);
      setThemeOpen(false);
    },
  });

  // 1.1.0：镜像关闭确认状态到 ref，供跨边界重弹定时器判断（避免关闭确认展示期间被每日弹窗顶回）
  useEffect(() => {
    closeConfirmRef.current = shell.closeConfirm;
  }, [shell.closeConfirm]);

  // 快捷键：1-5 切换视图；Enter 打开当前视图的加号（nowtree:quick-add 由各视图监听）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = document.activeElement as HTMLElement | null;
      const typing =
        !!el &&
        (el.tagName === "INPUT" ||
          el.tagName === "TEXTAREA" ||
          el.tagName === "SELECT" ||
          el.tagName === "BUTTON" ||
          el.isContentEditable);
      const hasModal = !!document.querySelector(".modal-overlay");
      const blocked = typing || hasModal;
      if (blocked) {
        // 0.1.20：无弹窗且焦点落在按钮上（如保存后焦点回落到 FAB / 编辑按钮）时，
        // 回车既会触发全局「新增」，又会默认「点击该按钮」。这里拦截其默认点击行为，
        // 杜绝「保存后回车又弹出新增」的连锁反应；弹窗内（hasModal）则放行按钮默认点击，
        // 保证在弹窗里 Tab 到「保存」按钮按回车仍能正常保存。
        if (!hasModal && el?.tagName === "BUTTON" && e.key === "Enter") {
          e.preventDefault();
        }
        return;
      }

      const map: Record<string, ViewKey> = {
        "1": "inbox",
        "2": "next",
        "3": "project",
        "4": "waiting",
        "5": "someday",
        "6": "habit",
      };
      const v = map[e.key];
      if (v) {
        setView(v);
        // 0.2.0：数字键切换视图后，把当前焦点（鼠标点过的 nav-item）失焦，
        // 避免浏览器因键盘操作点亮 :focus-visible 环、残留绿框。
        if (el && el !== document.body) el.blur();
        return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        window.dispatchEvent(new CustomEvent("nowtree:quick-add"));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">NowTree</div>
        <nav className="nav">
          {NAV.map((n) => (
            <a
              key={n.key}
              data-cat={n.key}
              className={`nav-item ${view === n.key ? "active" : ""}`}
              href="#"
              onClick={(e) => {
                e.preventDefault();
                setView(n.key);
              }}
              onKeyDown={(e) => {
                if (e.key === " ") {
                  e.preventDefault();
                  setView(n.key);
                }
              }}
            >
              {n.label}
            </a>
          ))}
        </nav>

        {/* 左下角下拉：回收站 / 主题 / 版本信息 */}
        <div className="side-drop">
          <button
            ref={menuBtnRef}
            className="side-drop-btn"
            onClick={() => setMenuOpen((v) => !v)}
          >
            <span>☰ 菜单</span>
            <span className="side-drop-caret">{menuOpen ? "▴" : "▾"}</span>
          </button>
          {menuOpen && (
            <div ref={menuRef} className="side-menu">
              <button
                className="side-menu-item"
                onClick={() => {
                  setTrashOpen(true);
                  setMenuOpen(false);
                }}
              >
                🗑 回收站
              </button>
              <button
                className="side-menu-item"
                onClick={() => {
                  setShortcutsOpen(true);
                  setMenuOpen(false);
                }}
              >
                ⌨ 快捷键
              </button>
              <div className="side-menu-sep" />
              <button
                className="side-menu-item"
                onClick={() => {
                  setThemeOpen(true);
                  setMenuOpen(false);
                }}
              >
                🎨 主题
              </button>
              <button
                className="side-menu-item"
                onClick={() => {
                  setDataOpen(true);
                  setMenuOpen(false);
                }}
              >
                💾 数据管理
              </button>
              <button
                className="side-menu-item"
                onClick={() => {
                  setSettingsOpen(true);
                  setMenuOpen(false);
                }}
              >
                ⚙ 设置
              </button>
              <div className="side-menu-sep" />
              <div className="side-menu-motto">种一棵树最好的时间是十年前，其次是现在</div>
              <div className="side-menu-version">v1.1.0 · 本地 SQLite</div>
            </div>
          )}
        </div>
      </aside>
      <main className="content">
        {view === "inbox" && <InboxView />}
        {view === "next" && (
          <NextView openSlot={openSlot} setOpenSlot={setOpenSlot} />
        )}
        {view === "project" && <ProjectListView />}
        {view === "waiting" && <CategoryListView category="waiting" />}
        {view === "someday" && <CategoryListView category="someday" />}
        {view === "habit" && <HabitsView />}
      </main>

      {trashOpen && <TrashModal onClose={() => setTrashOpen(false)} />}
      {shortcutsOpen && <ShortcutsModal onClose={() => setShortcutsOpen(false)} />}
      {themeOpen && (
        <ThemeModal theme={theme} onChoose={chooseTheme} onClose={() => setThemeOpen(false)} />
      )}
      {dataOpen && (
        <DataModal
          onExport={shell.handleExport}
          onImport={shell.handleImport}
          onReset={() => shell.setResetConfirmOpen(true)}
          onClose={() => setDataOpen(false)}
        />
      )}
      {shell.resetConfirmOpen && (
        <Modal title="确认清空所有数据" onClose={() => shell.setResetConfirmOpen(false)}>
          <div className="close-confirm">
            <p className="close-confirm-tip">
              此操作将<strong>永久删除所有事务</strong>，包括 Inbox、Next Actions、Projects、Waiting、Someday 和回收站中的内容。
            </p>
            <p className="muted close-confirm-tip">
              删除后无法恢复；若还需要保留记录，请先导出备份。
            </p>
            <p className="muted close-confirm-tip" style={{ fontSize: 12 }}>
              数据文件位置：{dbPath || "…"}
            </p>
            <div className="close-confirm-actions">
              <button type="button" className="btn-ghost" onClick={() => shell.setResetConfirmOpen(false)}>
                取消
              </button>
              <button type="button" className="btn-danger" onClick={shell.confirmReset}>
                确认清空
              </button>
            </div>
          </div>
        </Modal>
      )}
      {shell.importMeta && (
        <Modal title="确认导入备份" onClose={shell.dismissImport}>
          <div className="close-confirm">
            <p className="close-confirm-tip">
              此备份{shell.importMeta.exported_at
                ? `生成于 ${new Date(shell.importMeta.exported_at).toLocaleString("zh-CN")}`
                : shell.importMeta.latest_updated
                  ? `最新记录时间为 ${new Date(shell.importMeta.latest_updated).toLocaleString("zh-CN")}（旧版无备份日期）`
                  : "日期未知"}
              ，含 <strong>{shell.importMeta.count}</strong> 条事务。
            </p>
            <p className="muted close-confirm-tip">
              导入将以备份内容<strong>覆盖当前全部数据</strong>，且不可撤销。
            </p>
            <div className="close-confirm-actions">
              <button type="button" className="btn-ghost" onClick={shell.dismissImport}>
                取消
              </button>
              <button type="button" className="btn-danger" onClick={shell.confirmImport}>
                确认导入
              </button>
            </div>
          </div>
        </Modal>
      )}
        {settingsOpen && (
        <SettingsModal
          autostart={shell.autostart}
          onToggleAutostart={shell.toggleAutostart}
          checkSoundOn={shell.checkSoundOn}
          onToggleCheckSound={shell.toggleCheckSound}
          isDev={isDev}
          onClose={() => setSettingsOpen(false)}
        />
        )}
      {shell.closeConfirm && (
        <Modal
          title="关闭 NowTree"
          onClose={() => { shell.setCloseConfirm(false); shell.setDontAskAgain(false); }}
        >
          <div className="close-confirm">
            <p className="close-confirm-tip">要最小化到托盘，还是退出程序？</p>
            <label className="close-confirm-ask">
              <input
                type="checkbox"
                checked={shell.dontAskAgain}
                onChange={(e) => shell.setDontAskAgain(e.target.checked)}
              />
              不再提示（按我选的默认执行）
            </label>
            <div className="close-confirm-actions">
              <button
                type="button"
                className="btn-ghost"
                onClick={() => shell.chooseClose("tray")}
              >
                最小化到托盘
              </button>
              <button
                type="button"
                className="btn-danger"
                onClick={() => shell.chooseClose("exit")}
              >
                退出
              </button>
            </div>
          </div>
        </Modal>
      )}
      {startupOpen && (
        <StartupModal
          onClose={() => {
            lastNotifiedSlotRef.current = currentClockSlot();
            setStartupOpen(false);
          }}
        />
      )}
      {toast && (
        <div className="toast">
          <span>{toast}</span>
          {toastAction && (
            <button
              className="toast-action"
              type="button"
              onClick={() => toastAction.onClick()}
            >
              {toastAction.label}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
