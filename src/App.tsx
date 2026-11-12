import { useEffect, useState, useRef } from "react";
import { appDataDir, join } from "@tauri-apps/api/path";
import { listen } from "@tauri-apps/api/event";
import InboxView from "./components/InboxView";
import CategoryListView from "./components/CategoryListView";
import ProjectListView from "./components/ProjectListView";
import NextView from "./components/NextView";
import TrashModal from "./components/TrashModal";
import TrashDrop from "./components/TrashDrop";
import ShortcutsModal from "./components/ShortcutsModal";
import ThemeModal from "./components/ThemeModal";
import DataModal from "./components/DataModal";
import SettingsModal from "./components/SettingsModal";
import UpdateModal from "./components/UpdateModal";
import Modal from "./components/common/Modal";
import { useTxStore } from "./store/useTxStore";
import type { TimeSlot } from "./types/transaction";
import { CATEGORIES, CATEGORY_META } from "./types/transaction";
import { useToast } from "./hooks/useToast";
import { useTheme } from "./hooks/useTheme";
import { useShell } from "./hooks/useShell";
import { useWeeklyReview } from "./hooks/useWeeklyReview";
import { useDailyDigest } from "./hooks/useDailyDigest";
import { resetStaleReminderMarksOnce } from "./utils/reminderMarks";
import { checkForUpdate, openReleasesPage } from "./services/updateCheck";
import type { AvailableUpdate } from "./services/updateCheck";
import {
  useReminderScan,
  useReminderScheduler,
  useDeadlineNormalize,
  useToastSubscription,
} from "./hooks/useLifecycle";

// 侧边栏导航 key。
// inbox → InboxView；project → 专用 ProjectListView（树状）；next/waiting/someday → 通用 CategoryListView。
type ViewKey = "inbox" | "next" | "project" | "waiting" | "someday";

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
  // 1.1.7：检查更新。只有真发现新版本才挂弹窗；checkingUpdate 用来挡重复点击。
  const [updateFound, setUpdateFound] = useState<AvailableUpdate | null>(null);
  const [checkingUpdate, setCheckingUpdate] = useState(false);
  // 1.1.5：数据就绪标记——每日摘要卡要等 active 读完再判断，避免误显示「暂无安排」。
  // 原「今日」启动弹窗已由右下角每日摘要卡接管（见 useDailyDigest），不再有自动弹窗。
  const [dataReady, setDataReady] = useState(false);
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
  const inbox = useTxStore((s) => s.inbox);
  const active = useTxStore((s) => s.active);

  // 0.1.19：toast / 主题 / 提醒扫描 / deadline 归一 抽离为独立 hook，降低 App 体积。
  const { toast, toastAction, showToast } = useToast();
  const { theme, chooseTheme } = useTheme();
  useReminderScan(checkReminders);
  // 1.1.5：精确到点的提醒调度（Rust 定时 + 前端兜底），不再等 30 秒轮询。
  useReminderScheduler(checkReminders, active);
  useDeadlineNormalize(normalizeDeadlines);
  useToastSubscription(showToast);
  // 1.1.5：Inbox 每周回顾 + 每日摘要卡（两者都走右下角自定义提醒窗口）
  useWeeklyReview(inbox.length);
  useDailyDigest(dataReady);

  // 挂载：预拉取 active 与 inbox（每周回顾需要条数、每日摘要需要清单），完成后再标记就绪。
  // 1.1.5：先做一次性的提醒标记清理——早期开发构建在「建窗死锁」前就写了「今天已推送」，
  // 若不清掉，修复版当天会看不到每日摘要卡（详见 utils/reminderMarks.ts）。
  useEffect(() => {
    resetStaleReminderMarksOnce();
    let cancelled = false;
    (async () => {
      await loadActive();
      await loadInbox();
      if (!cancelled) setDataReady(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [loadActive, loadInbox]);

  // 1.1.5：右下角提醒窗口的回写 / 跳转（两窗口通过事件协作）。
  //   nowtree:data-changed   —— 弹窗里「完成 / 稍后」已写库，主窗口刷新列表；
  //   nowtree:open-view      —— 每周回顾「去整理」→ 切到 Inbox；
  //   nowtree:reminder-due   —— Rust 精确定时到点，触发一次提醒扫描。
  useEffect(() => {
    let unDataChanged: (() => void) | undefined;
    let unOpenView: (() => void) | undefined;
    let unReminderDue: (() => void) | undefined;
    (async () => {
      try {
        unDataChanged = await listen("nowtree:data-changed", () => {
          void loadActive();
          void loadInbox();
        });
        unOpenView = await listen<string>("nowtree:open-view", (e) => {
          if (e.payload === "inbox") setView("inbox");
        });
        unReminderDue = await listen("nowtree:reminder-due", () => {
          void checkReminders();
        });
      } catch {
        /* 非 Tauri 环境（浏览器预览）忽略 */
      }
    })();
    return () => {
      unDataChanged?.();
      unOpenView?.();
      unReminderDue?.();
    };
  }, [loadActive, loadInbox, checkReminders]);

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
      setSettingsOpen(false);
      setDataOpen(false);
      setTrashOpen(false);
      setShortcutsOpen(false);
      setThemeOpen(false);
    },
  });

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

  // 1.1.7：菜单「检查更新」。结果用 toast 报——「已是最新」弹个窗属于打扰，
  // 只有真发现新版本才挂 UpdateModal。
  async function handleCheckUpdate() {
    setMenuOpen(false);
    if (checkingUpdate) return;
    setCheckingUpdate(true);
    showToast("正在检查更新…");
    const res = await checkForUpdate();
    setCheckingUpdate(false);

    if (res.kind === "unsupported") {
      showToast("浏览器预览环境没有更新后端，请在安装版里检查");
    } else if (res.kind === "latest") {
      showToast(`已是最新版本 v${res.currentVersion}`);
    } else if (res.kind === "failed") {
      // 失败时把「打开发布页」直接挂在 toast 上：软件连不上、浏览器却能打开是最常见的失败形态，
      // 不给出口的话用户只能自己去搜发布页。useToast 带动作会停留 5 秒，够点。
      showToast(res.message, {
        label: "打开发布页",
        onClick: () => void openReleasesPage(),
      });
    } else {
      setUpdateFound(res.available);
    }
  }

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
              {/* 1.1.7：检查更新。放在「设置」下面——同属「维护类」动作，
                  与上面「回收站 / 快捷键 / 主题 / 数据管理」的操作类目分开。 */}
              <button
                className="side-menu-item"
                onClick={() => void handleCheckUpdate()}
                disabled={checkingUpdate}
                title="从 GitHub 检查是否有新版本"
              >
                🔄 检查更新
              </button>
              <div className="side-menu-sep" />
              <div className="side-menu-motto">种一棵树最好的时间是十年前，其次是现在</div>
              <div className="side-menu-version">v1.1.7 · 本地 SQLite</div>
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
          inboxCount={inbox.length}
          isDev={isDev}
          onClose={() => setSettingsOpen(false)}
        />
        )}
      {shell.closeConfirm && (
        <Modal
          title="关闭 NowTree"
          onClose={shell.dismissCloseConfirm}
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
      {updateFound && (
        <UpdateModal
          available={updateFound}
          onClose={() => setUpdateFound(null)}
        />
      )}
      {/* 1.1.3：拖拽删除垃圾桶——仅拖拽中显形，挂载于 App 顶层，五视图通用 */}
      <TrashDrop />
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
