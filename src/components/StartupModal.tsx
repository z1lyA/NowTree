// 启动弹窗（1.0.4 重构）：每次启动弹出，按当前钟点显示对应时段（早/午/晚）的任务；
// 深夜 0:00–5:59 显示「早点休息」、不列任务；任务按 order_index 排序；顶部展示每日励志语。
import { useEffect, useMemo, useState } from "react";
import Modal from "./common/Modal";
import { useTxStore } from "../store/useTxStore";
import type { Transaction } from "../types/transaction";
import { TIME_SLOT_LABELS, byOrder } from "../types/transaction";
import { currentClockSlot, type ClockSlot } from "../utils/clock";
import { dailyQuote } from "../data/quotes";

const WEEK = ["日", "一", "二", "三", "四", "五", "六"];

// 四个时段对应弹窗标题问候语（替代固定的「今天」）
const SLOT_GREETING: Record<ClockSlot, string> = {
  morning: "早上好",
  noon: "下午好",
  evening: "晚上好",
  rest: "晚安",
};

export default function StartupModal({ onClose }: { onClose: () => void }) {
  const { active } = useTxStore();
  // 每分钟刷新一次：弹窗保持打开时也能随时间（跨边界）自动切换时段内容
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 60000);
    return () => clearInterval(id);
  }, []);

  const now = new Date();
  const dateStr = `${now.getFullYear()}年${now.getMonth() + 1}月${now.getDate()}日`;
  const week = WEEK[now.getDay()];
  const slot = currentClockSlot(now);
  const quote = dailyQuote();

  // 当前时段（非休息）分配到该时段的未完成任务：Next 主线事务 + 同处该时段的 Habit。
  // habit 不进 Next（show_in_next 恒 false），但启动弹窗按时段展示时一并纳入该时段的习惯。
  // 1.1.1：拆分 regular（非 habit）与 habits，渲染时习惯列在常规事务下方。
  const tasks = useMemo<Transaction[]>(() => {
    if (slot === "rest") return [];
    return active
      .filter(
        (t) =>
          t.status !== "completed" &&
          ((t.category === "next_action" && t.parent_id === null) ||
            t.show_in_next ||
            t.category === "habit") &&
          t.time_slot === slot
      )
      .sort(byOrder);
  }, [active, slot]);

  const regular = useMemo(() => tasks.filter((t) => t.category !== "habit"), [tasks]);
  const habitTasks = useMemo(() => tasks.filter((t) => t.category === "habit"), [tasks]);

  return (
    <Modal title={SLOT_GREETING[slot]} onClose={onClose}>
      <p className="startup-quote">「{quote}」</p>
      <p className="startup-date">今天是 {dateStr} 星期{week}</p>

      {slot === "rest" ? (
        <p className="startup-rest">夜深了，早点休息吧 🌙 明天再战。</p>
      ) : (
        <>
          <p className="muted startup-sub">{TIME_SLOT_LABELS[slot]}的任务：</p>
          <div className="startup-slots">
            <div className="startup-slot">
              {regular.length > 0 && (
                <ul className="startup-task-list">
                  {regular.map((t) => (
                    <li key={t.id}>{t.title}</li>
                  ))}
                </ul>
              )}
              {habitTasks.length > 0 && (
                <>
                  <div className="muted startup-habit-label">习惯</div>
                  <ul className="startup-task-list startup-habit-list">
                    {habitTasks.map((t) => (
                      <li key={t.id}>{t.title}</li>
                    ))}
                  </ul>
                </>
              )}
              {regular.length === 0 && habitTasks.length === 0 && (
                <div className="muted startup-empty">暂无安排</div>
              )}
            </div>
          </div>
        </>
      )}

      <div className="modal-actions">
        <button className="btn-primary" onClick={onClose}>
          开始今天
        </button>
      </div>
    </Modal>
  );
}
