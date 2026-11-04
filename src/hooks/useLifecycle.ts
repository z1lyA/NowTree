// App 挂载期的副作用集群（0.1.19 从 App 抽离）：
//  - useReminderScan：每 30 秒扫描到期提醒。
//  - useDeadlineNormalize：启动时立即归一 deadline，并每天 0 点再扫一次。
//  - useToastSubscription：订阅全局 toast 事件。
import { useEffect } from "react";
import { onToast } from "../toast";
import type { ToastAction } from "./useToast";
import { invoke } from "@tauri-apps/api/core";
import type { Transaction } from "../types/transaction";

// 提醒扫描周期（毫秒）：每 30 秒检查一次到期且未弹过的提醒。
export const REMINDER_SCAN_MS = 30000;

export function useReminderScan(checkReminders: () => void) {
  useEffect(() => {
    const timer = setInterval(() => {
      checkReminders();
    }, REMINDER_SCAN_MS);
    return () => clearInterval(timer);
  }, [checkReminders]);
}

// 1.1.5：到点**精确**触发提醒（不再依赖 30 秒轮询的粒度）。
//  - 前端按 active 里最早的一条 reminder_time 设一个兜底 setTimeout；
//  - 同时交给 Rust 精确等待（schedule_reminder_fire），到点后 emit nowtree:reminder-due，
//    由主窗口监听并调用 checkReminders——窗口在托盘 / 被系统节流时也比纯前端定时更可靠。
//  - 30 秒轮询仍保留（useReminderScan），作为系统休眠 / 事件丢失时的兜底。
export function useReminderScheduler(
  checkReminders: () => void,
  active: Transaction[],
) {
  useEffect(() => {
    const now = Date.now();
    let next: number | null = null;
    for (const t of active) {
      if (t.status === "completed" || t.reminder_done === 1 || !t.reminder_time) continue;
      const ts = new Date(t.reminder_time).getTime();
      if (!Number.isFinite(ts)) continue;
      if (ts <= now) {
        next = now; // 已到期：立刻补一次
        break;
      }
      if (next === null || ts < next) next = ts;
    }

    // null = 没有待触发的提醒，顺手取消 Rust 侧的旧定时器
    void invoke("schedule_reminder_fire", { atMs: next }).catch(() => {});
    if (next === null) return;

    const timer = window.setTimeout(
      () => void checkReminders(),
      Math.max(0, next - Date.now()) + 60,
    );
    return () => window.clearTimeout(timer);
  }, [active, checkReminders]);
}

export function useDeadlineNormalize(normalize: () => void) {
  useEffect(() => {
    let timeoutId: number;
    // 1.0.2：不再挂载瞬间立即扫描——此时本地数据尚未加载（loadActive 异步），
    // 扫了也是空扫。改为仅安排「每日 0 点」定时扫描；启动后的那一次归一，
    // 由 store.loadActive 在写入数据后补调 normalizeDeadlines() 触发。
    const scheduleNextMidnight = () => {
      const now = new Date();
      const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0, 0);
      const ms = next.getTime() - now.getTime();
      timeoutId = window.setTimeout(() => {
        normalize();
        scheduleNextMidnight(); // 递归安排下一天
      }, ms);
    };
    scheduleNextMidnight();
    return () => clearTimeout(timeoutId);
  }, [normalize]);
}

// 订阅全局 toast 事件；showToast 需透传 action（如撤销按钮）到本地渲染。
export function useToastSubscription(
  showToast: (m: string, action?: ToastAction) => void,
) {
  useEffect(() => onToast(showToast), [showToast]);
}
