// 右下角提醒窗口的 React 实现。
//
// 1.1.9 起是「一卡一窗口」：每个提醒窗口（标签 reminder-N）只渲染一张卡，
// 多张卡由 Rust 分配槽位、各自开窗并纵向排列，窗口之间不共享 React 状态。
//
// 三种卡片共用一套外壳（kind 决定头部强调色）：
//   - task   事务提醒：完成 / 稍后（时长可配置）/ 关闭（一次只对应一条事务）
//   - review Inbox 每周回顾：去整理 / 知道了
//   - daily  每日摘要：强调头里放问候，正文是日期 / 励志语 / 该时段事务（原「今日」弹窗内容）
//   - preview 设置里的实验卡：只有关闭，用来预览样式
//
// 交互：
//   - 10 秒无操作自动收起（鼠标悬停暂停），收起即关闭本窗口的卡片；
//   - 卡片空白处按住可拖动本窗口；拖动只在本次显示有效，新提醒仍回到设置的位置。
//
// 与 Rust / 主窗口的协作：
//   - 主窗口先 invoke("show_reminder_cards") 投递卡片（附带四角 / 宽度布局），Rust 分槽开窗；
//   - 本窗口挂载时 invoke("take_reminder_card") 取走建窗前暂存的那张卡，之后靠事件更新；
//   - 内容高度变化 → invoke("fit_reminder_card")，Rust 重排所有窗口（纵向不重叠）；
//   - 关闭 / 完成 / 稍后 → invoke("close_reminder_card")，Rust 隐藏本窗口并重排；
//   - 完成 / 稍后 会写库并广播 nowtree:data-changed，主窗口收到后刷新列表；
//   - 「去整理」广播 nowtree:open-view → 主窗口切到 Inbox。
import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { ReminderCard } from "../services/reminderCards";
import { snoozeTargetValue } from "../services/reminders";
import { getReminderPrefs } from "../utils/reminderPrefs";
import { useTheme, refreshSystemTheme } from "../hooks/useTheme";
import { TIME_SLOT_LABELS } from "../types/transaction";

const KIND_LABELS: Record<string, string> = {
  task: "事务提醒",
  review: "Inbox 每周回顾",
  daily: "今日",
};

// 时段 → 口语化时段词（早时段 = 上午的事务，午 = 下午，晚 = 晚上）
const SLOT_PERIOD_WORD: Record<string, string> = {
  morning: "上午",
  noon: "下午",
  evening: "晚上",
};

// 无操作多久自动收起（鼠标悬停暂停）。
const AUTO_HIDE_MS = 10_000;

// 模块级缓存：本窗口挂载时只向 Rust 取一次待投递卡片（每个窗口各自一个 JS 上下文）。
let pendingLoaded = false;
let pendingCache: ReminderCard | null = null;
async function loadPendingCard(): Promise<ReminderCard | null> {
  if (!pendingLoaded) {
    pendingLoaded = true;
    pendingCache = await invoke<ReminderCard | null>("take_reminder_card");
  }
  return pendingCache;
}

function errText(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  return "操作失败";
}

export default function ReminderApp() {
  useTheme(); // 跟随主窗口的深/浅色主题（同一份存储）
  // 本窗口只持有一张卡；null 表示当前没有卡（窗口随后会被 Rust 隐藏）
  const [card, setCard] = useState<ReminderCard | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [paused, setPaused] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const lastHeightRef = useRef(0);
  const prefs = getReminderPrefs();

  // 关闭本窗口的卡片：先本地清空（立即消失），再让 Rust 隐藏窗口并重排其余窗口。
  function closeCard() {
    setCard(null);
    setError("");
    void invoke("close_reminder_card").catch(() => {});
  }

  // 窗口被隐藏再显示时（visibilitychange → visible）重新套用主题：
  // 提醒窗口是常驻复用的，主窗口期间改过主题它不会自动重渲染。
  useEffect(() => {
    const onVisibility = () => {
      // 1.1.7：改成异步刷新系统色——隐藏期间用户可能改过系统主题，
      // 只套缓存会把旧颜色带出来。
      if (document.visibilityState === "visible") void refreshSystemTheme();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);

  // ===== 取走本窗口暂存的卡片 + 订阅后续更新 =====
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    (async () => {
      try {
        // ⚠️ 必须显式指定 target 为「当前窗口」。
        // 前端 listen() 不传 options 时默认注册成 EventTarget::Any（见 @tauri-apps/api/event.js），
        // 而 Tauri 的事件投递会拿「监听器自己的 target」去匹配——Any 对任何 emit_to 都成立，
        // 于是每个提醒窗口都会收到发给其它窗口的卡片，最后一张覆盖全部的卡（三张一样的弹窗）。
        const label = getCurrentWindow().label;
        unlisten = await listen<ReminderCard>("nowtree:reminder-push", (e) => {
          if (disposed) return;
          setCard(e.payload);
          setError("");
        }, { target: { kind: "WebviewWindow", label } });
        const pending = await loadPendingCard();
        if (!disposed && pending) setCard(pending);
      } catch {
        /* 非 Tauri 环境（浏览器预览）没有事件/命令，忽略 */
      }
    })();
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  // ===== 10 秒自动收起（悬停暂停） =====
  // 每个窗口各自计时：先到的卡片先收，符合「独立弹窗」的预期。
  useEffect(() => {
    if (!card || paused) return;
    const timer = window.setTimeout(() => closeCard(), AUTO_HIDE_MS);
    return () => window.clearTimeout(timer);
  }, [card, paused]);

  // ===== 内容高度变化 → 让 Rust 重排所有提醒窗口 =====
  // 只更新尺寸 / 位置，不会把已关闭的窗口重新显示出来。
  // 依赖 card：没有卡片时组件渲染 null（没有 .reminder-root 可测），
  // 必须等卡片到达、DOM 出现后重新建立观察者，否则窗口会停在占位高度。
  useEffect(() => {
    if (!card) return;
    const el = rootRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    // 换了卡片要重新上报，避免新卡高度恰好等于旧值而被判为「没变化」跳过
    lastHeightRef.current = 0;
    let timer = 0;
    const measureAndFit = () => {
      const height = Math.ceil(el.getBoundingClientRect().height);
      if (Math.abs(height - lastHeightRef.current) < 1) return;
      lastHeightRef.current = height;
      void invoke("fit_reminder_card", { height }).catch(() => {});
    };
    const ro = new ResizeObserver(() => {
      window.clearTimeout(timer);
      timer = window.setTimeout(measureAndFit, 60);
    });
    ro.observe(el);
    timer = window.setTimeout(measureAndFit, 30);
    return () => {
      ro.disconnect();
      window.clearTimeout(timer);
    };
  }, [card]);

  // 卡片空白处按住 = 拖动本窗口（拖动只在本次显示有效，不记忆位置）。
  // 新提醒投递时 Rust 会按「设置 → 弹窗个性化」里的四角位置重新贴边。
  function handlePointerDown(e: React.PointerEvent) {
    if (e.button !== 0) return;
    const target = e.target as HTMLElement;
    if (target.closest("button, input, select, textarea, a")) return;
    try {
      void getCurrentWindow().startDragging().catch(() => {});
    } catch {
      /* 非 Tauri 环境忽略 */
    }
  }

  async function runCardAction(fn: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  }

  // 完成：写库（completed + 清提醒）→ 广播数据变更 → 关闭本窗口
  function completeTask(c: ReminderCard) {
    if (c.id == null) return;
    void runCardAction(async () => {
      await invoke("update_transaction", {
        id: c.id,
        patch: {
          status: "completed",
          completed_time: new Date().toISOString(),
          reminder_done: 1,
          clear_reminder: true,
        },
      });
      closeCard();
      await emit("nowtree:data-changed");
    });
  }

  // 稍后：按设置里的时长（默认 5 分钟，可 5/15/30）再提醒
  function snoozeTask(c: ReminderCard) {
    if (c.id == null) return;
    void runCardAction(async () => {
      await invoke("update_transaction", {
        id: c.id,
        patch: {
          reminder_time: snoozeTargetValue(new Date(), getReminderPrefs().snoozeMinutes),
          reminder_done: 0,
        },
      });
      closeCard();
      await emit("nowtree:data-changed");
    });
  }

  // 每周回顾「去整理」：切到主窗口 Inbox
  function openInbox() {
    void runCardAction(async () => {
      await emit("nowtree:open-view", "inbox");
      await invoke("show_main_window");
      closeCard();
    });
  }

  // 每日摘要「开始今天」：打开主窗口
  function startToday() {
    void runCardAction(async () => {
      await invoke("show_main_window");
      closeCard();
    });
  }

  // 没有卡片时不渲染内容（窗口由 Rust 隐藏，这里只是避免闪空壳）。
  if (!card) return null;

  return (
    <div
      className="reminder-root"
      ref={rootRef}
      onPointerDown={handlePointerDown}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
    >
      <article className={`rcard rcard--${card.kind}`}>
        <div className="rcard-head">
          <div className="rcard-headtext">
            {card.kind !== "daily" && (
              <span className="rcard-kind">{KIND_LABELS[card.kind] ?? "提醒"}</span>
            )}
            <h3 className="rcard-title">{card.title}</h3>
          </div>
          <button
            type="button"
            className="rcard-close"
            onClick={closeCard}
            aria-label="关闭"
            title="关闭"
          >
            ×
          </button>
        </div>

        <div className="rcard-body">
          {(card.kind === "task" || card.kind === "review") && card.note && (
            <p className="rcard-note">{card.note}</p>
          )}

          {card.kind === "daily" && <DailyBody card={card} />}

          {error && <p className="rcard-error">{error}</p>}

          <div className="rcard-actions">
            {card.preview && (
              <button type="button" className="btn-ghost" onClick={closeCard}>
                关闭
              </button>
            )}

            {!card.preview && card.kind === "task" && (
              <>
                <button
                  type="button"
                  className="btn-ghost"
                  disabled={busy}
                  onClick={() => snoozeTask(card)}
                  title={`${prefs.snoozeMinutes} 分钟后再提醒`}
                >
                  稍后
                </button>
                <button
                  type="button"
                  className="btn-primary"
                  disabled={busy}
                  onClick={() => completeTask(card)}
                >
                  完成
                </button>
              </>
            )}

            {!card.preview && card.kind === "review" && (
              <>
                <button
                  type="button"
                  className="btn-ghost"
                  disabled={busy}
                  onClick={closeCard}
                >
                  知道了
                </button>
                <button
                  type="button"
                  className="btn-primary"
                  disabled={busy}
                  onClick={() => openInbox()}
                >
                  去整理
                </button>
              </>
            )}

            {!card.preview && card.kind === "daily" && (
              <button
                type="button"
                className="btn-primary"
                disabled={busy}
                onClick={() => startToday()}
              >
                {card.slot === "rest" ? "知道了" : "开始今天"}
              </button>
            )}
          </div>
        </div>
      </article>
    </div>
  );
}

// 每日摘要卡主体：日期 / 励志语 / 该时段事务清单（原启动弹窗内容）。
function DailyBody({ card }: { card: ReminderCard }) {
  const slot = card.slot ?? "morning";
  const tasks = card.tasks ?? [];
  const isRest = slot === "rest";
  const periodWord = SLOT_PERIOD_WORD[slot] ?? TIME_SLOT_LABELS[slot as keyof typeof TIME_SLOT_LABELS];
  return (
    <div className="rcard-daily">
      {card.dateText && <p className="rcard-date">{card.dateText}</p>}
      {card.quote && <p className="rcard-quote">「{card.quote}」</p>}
      {isRest ? (
        <p className="rcard-rest">夜深了，早点休息吧 🌙 明天再战。</p>
      ) : (
        <>
          <p className="rcard-sub muted">
            {periodWord}的事务（{tasks.length}）
          </p>
          {tasks.length > 0 ? (
            <ul className="rcard-tasks">
              {tasks.map((title, i) => (
                <li key={`${card.key}-${i}`} className="rcard-task">
                  {title}
                </li>
              ))}
            </ul>
          ) : (
            <p className="rcard-empty muted">暂无安排</p>
          )}
        </>
      )}
    </div>
  );
}
