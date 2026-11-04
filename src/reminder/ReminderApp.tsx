// 1.1.5：右下角提醒窗口的 React 实现。
//
// 三种卡片共用一套外壳（kind 决定头部强调色）：
//   - task   事务提醒：完成 / 稍后（时长可配置）/ 关闭（一次只对应一条事务）
//   - review Inbox 每周回顾：去整理 / 知道了
//   - daily  每日摘要：强调头里放问候，正文是日期 / 励志语 / 该时段事务（原「今日」弹窗内容）
//   - preview 设置里的实验卡：只有关闭，用来预览样式
//
// 交互：
//   - 多卡时默认折叠成「最新 1 张 + N 条提醒」堆叠（背后画出 N-1 层卡片边缘，最多 3 层），
//     可展开 / 全部关闭；数字与堆叠层数随「完成 / 稍后 / 关闭」实时变化；
//   - 10 秒自动收起（鼠标悬停暂停），收起即清空本次卡片；
//   - 卡片空白处按住可拖动整个窗口；拖动只在本次显示有效，新提醒仍回到设置的位置。
//
// 与主窗口的协作：
//   - 主窗口先 invoke("show_reminder_cards") 投递卡片（附带四角 / 宽度布局）；
//   - 本窗口挂载时 invoke("take_reminder_cards") 取走建窗前暂存的卡片，之后靠事件追加；
//   - 完成 / 稍后 会写库并广播 nowtree:data-changed，主窗口收到后刷新列表；
//   - 「去整理」广播 nowtree:open-view → 主窗口切到 Inbox。
import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { ReminderCard } from "../services/reminderCards";
import { mergeCards, removeCard } from "../services/reminderCards";
import { snoozeTargetValue } from "../services/reminders";
import { getReminderPrefs } from "../utils/reminderPrefs";
import { useTheme, applyStoredTheme } from "../hooks/useTheme";
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
// 折叠时最多画几层「背后卡片」的边缘
const MAX_STACK_LAYERS = 3;
const STACK_LAYER_OFFSET = 12;
const STACK_LAYER_INSET = 22;

// 模块级缓存：挂载时只向 Rust 取一次待投递卡片。
// 取完缓存下来，HMR / 重挂载重复合并也只会因 key 去重而安全。
let pendingLoaded = false;
let pendingCache: ReminderCard[] = [];
async function loadPendingCards(): Promise<ReminderCard[]> {
  if (!pendingLoaded) {
    pendingLoaded = true;
    pendingCache = await invoke<ReminderCard[]>("take_reminder_cards");
  }
  return pendingCache;
}

function errText(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  return "操作失败";
}

export default function ReminderApp() {
  useTheme(); // 跟随主窗口的深/浅色主题（同一 localStorage）
  const [cards, setCards] = useState<ReminderCard[]>([]);
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [expanded, setExpanded] = useState(false);
  const [paused, setPaused] = useState(false);
  // 首次挂载是否已完成「取走暂存卡片」。在此之前 cards 为空只是还没取到，不能当成「没卡了」去隐藏窗口。
  const [bootReady, setBootReady] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const lastHeightRef = useRef(0);
  const prefs = getReminderPrefs();

  // 窗口被隐藏再显示时（visibilitychange → visible）重新套用主题：
  // 提醒窗口是常驻复用的，主窗口期间改过主题它不会自动重渲染。
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === "visible") applyStoredTheme();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);

  // ===== 订阅新卡片 + 取走暂存卡片 =====
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    (async () => {
      try {
        unlisten = await listen<ReminderCard[]>("nowtree:reminder-push", (e) => {
          if (disposed) return;
          setCards((c) => mergeCards(c, e.payload));
        });
        const pending = await loadPendingCards();
        if (!disposed && pending.length > 0) {
          setCards((c) => mergeCards(c, pending));
        }
      } catch {
        /* 非 Tauri 环境（浏览器预览）没有事件/命令，忽略 */
      } finally {
        // 取件成功/失败都标记「首屏就绪」，之后 cards 为空才是真的没卡了。
        if (!disposed) setBootReady(true);
      }
    })();
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  // ===== 卡片清空 → 隐藏窗口（保留窗口复用） =====
  // 必须等首屏取件完成后才判断：建窗时窗口已显示，挂载瞬间 cards 恒为空，
  // 若这时就 hide，会把刚取到的第一批卡片连同窗口一起藏掉。
  // 再延迟 200ms：避免「事件正在路上、先渲染成空列表」时把窗口误藏。
  useEffect(() => {
    if (!bootReady || cards.length > 0) return;
    const timer = window.setTimeout(() => {
      void invoke("hide_reminder_window").catch(() => {});
    }, 200);
    return () => window.clearTimeout(timer);
  }, [bootReady, cards.length]);

  // ===== 10 秒自动收起（悬停 / 展开阅读时暂停） =====
  // 收起 = 清空本次卡片并隐藏窗口：新提醒到来会重新弹出并重新计时。
  useEffect(() => {
    if (cards.length === 0 || paused) return;
    const timer = window.setTimeout(() => {
      setCards([]);
      setErrors({});
      setExpanded(false);
    }, AUTO_HIDE_MS);
    return () => window.clearTimeout(timer);
  }, [cards.length, paused, expanded]);

  // 只剩一张（或清空）时不再需要展开态
  useEffect(() => {
    if (cards.length <= 1) setExpanded(false);
  }, [cards.length]);

  // ===== 内容高度变化 → 让 Rust 调整窗口高度并保持所选角落 =====
  useEffect(() => {
    const el = rootRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    let timer = 0;
    const measureAndFit = () => {
      const height = Math.ceil(el.getBoundingClientRect().height);
      if (Math.abs(height - lastHeightRef.current) < 1) return;
      lastHeightRef.current = height;
      void invoke("fit_reminder_window", { height }).catch(() => {});
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
  }, []);

  function dismiss(key: string) {
    setCards((c) => removeCard(c, key));
    setErrors((e) => {
      const next = { ...e };
      delete next[key];
      return next;
    });
  }

  function closeAll() {
    setCards([]);
    setErrors({});
    setExpanded(false);
  }

  // 卡片空白处按住 = 拖动窗口（方案 B：拖动只在本次显示有效，不记忆位置）。
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

  async function runCardAction(key: string, fn: () => Promise<void>) {
    setBusy((b) => ({ ...b, [key]: true }));
    setErrors((e) => ({ ...e, [key]: "" }));
    try {
      await fn();
    } catch (e) {
      setErrors((prev) => ({ ...prev, [key]: errText(e) }));
    } finally {
      setBusy((b) => {
        const next = { ...b };
        delete next[key];
        return next;
      });
    }
  }

  // 完成：写库（completed + 清提醒）→ 广播数据变更 → 移除卡片（剩余数量 / 堆叠自动更新）
  function completeTask(card: ReminderCard) {
    if (card.id == null) return;
    void runCardAction(card.key, async () => {
      await invoke("update_transaction", {
        id: card.id,
        patch: {
          status: "completed",
          completed_time: new Date().toISOString(),
          reminder_done: 1,
          clear_reminder: true,
        },
      });
      dismiss(card.key);
      await emit("nowtree:data-changed");
    });
  }

  // 稍后：按设置里的时长（默认 5 分钟，可 5/15/30）再提醒
  function snoozeTask(card: ReminderCard) {
    if (card.id == null) return;
    void runCardAction(card.key, async () => {
      await invoke("update_transaction", {
        id: card.id,
        patch: {
          reminder_time: snoozeTargetValue(new Date(), getReminderPrefs().snoozeMinutes),
          reminder_done: 0,
        },
      });
      dismiss(card.key);
      await emit("nowtree:data-changed");
    });
  }

  // 每周回顾「去整理」：切到主窗口 Inbox
  function openInbox(card: ReminderCard) {
    void runCardAction(card.key, async () => {
      await emit("nowtree:open-view", "inbox");
      await invoke("show_main_window");
      dismiss(card.key);
    });
  }

  // 每日摘要「开始今天」：打开主窗口
  function startToday(card: ReminderCard) {
    void runCardAction(card.key, async () => {
      await invoke("show_main_window");
      dismiss(card.key);
    });
  }

  // 多卡时默认只显示最新一张，并在背后画出「还有几张」的堆叠边缘；展开后全部列出。
  const ordered = [...cards].reverse(); // 新的在前
  const collapsed = cards.length > 1 && !expanded;
  const layerCount = collapsed ? Math.min(cards.length - 1, MAX_STACK_LAYERS) : 0;
  const visibleCards = collapsed ? ordered.slice(0, 1) : ordered;

  return (
    <div
      className="reminder-root"
      ref={rootRef}
      onPointerDown={handlePointerDown}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
    >
      {cards.length > 1 && (
        <div className="rcard-stackbar">
          <span className="rcard-stackbar-count">{cards.length} 条提醒</span>
          <button
            type="button"
            className="rcard-stackbar-btn"
            onClick={() => setExpanded((v) => !v)}
          >
            {expanded ? "收起" : "展开"}
          </button>
          <button
            type="button"
            className="rcard-stackbar-btn rcard-stackbar-danger"
            onClick={closeAll}
          >
            全部关闭
          </button>
        </div>
      )}

      {visibleCards.map((card) => (
        <div
          key={card.key}
          className="rcard-stackwrap"
          style={{ paddingTop: layerCount * STACK_LAYER_OFFSET }}
        >
          {layerCount > 0 && (
            <div className="rcard-layers" aria-hidden="true">
              {Array.from({ length: layerCount }).map((_, i) => (
                <span
                  key={i}
                  className="rcard-layer"
                  style={{
                    top: (layerCount - 1 - i) * STACK_LAYER_OFFSET,
                    width: `calc(100% - ${(i + 1) * STACK_LAYER_INSET}px)`,
                    opacity: Math.max(0.4, 0.95 - i * 0.2),
                    zIndex: layerCount - i,
                  }}
                />
              ))}
            </div>
          )}

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
                onClick={() => dismiss(card.key)}
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

              {errors[card.key] && <p className="rcard-error">{errors[card.key]}</p>}

              <div className="rcard-actions">
                {card.preview && (
                  <button
                    type="button"
                    className="btn-ghost"
                    onClick={() => dismiss(card.key)}
                  >
                    关闭
                  </button>
                )}

                {!card.preview && card.kind === "task" && (
                  <>
                    <button
                      type="button"
                      className="btn-ghost"
                      disabled={!!busy[card.key]}
                      onClick={() => snoozeTask(card)}
                      title={`${prefs.snoozeMinutes} 分钟后再提醒`}
                    >
                      稍后
                    </button>
                    <button
                      type="button"
                      className="btn-primary"
                      disabled={!!busy[card.key]}
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
                      disabled={!!busy[card.key]}
                      onClick={() => dismiss(card.key)}
                    >
                      知道了
                    </button>
                    <button
                      type="button"
                      className="btn-primary"
                      disabled={!!busy[card.key]}
                      onClick={() => openInbox(card)}
                    >
                      去整理
                    </button>
                  </>
                )}

                {!card.preview && card.kind === "daily" && (
                  <button
                    type="button"
                    className="btn-primary"
                    disabled={!!busy[card.key]}
                    onClick={() => startToday(card)}
                  >
                    {card.slot === "rest" ? "知道了" : "开始今天"}
                  </button>
                )}
              </div>
            </div>
          </article>
        </div>
      ))}
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
