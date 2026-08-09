// App 挂载期的副作用集群（0.1.19 从 App 抽离）：
//  - useReminderScan：每 30 秒扫描到期提醒。
//  - useDeadlineNormalize：启动时立即归一 deadline，并每天 0 点再扫一次。
//  - useToastSubscription：订阅全局 toast 事件。
import { useEffect } from "react";
import { onToast } from "../toast";

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

export function useToastSubscription(showToast: (m: string) => void) {
  useEffect(() => onToast(showToast), [showToast]);
}

// 1.1.0：Habits 每日重置定时器。安排到「下一个 06:00」触发一次 resetHabits，
// 之后递归排下一天。若 app 在 6:00 未运行，启动时的 loadActive 已补做一次，不致漏重置。
export function useHabitReset(reset: () => void) {
  useEffect(() => {
    let timeoutId: number;
    const scheduleNextSix = () => {
      const now = new Date();
      const next = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 6, 0, 0, 0);
      if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1);
      const ms = next.getTime() - now.getTime();
      timeoutId = window.setTimeout(() => {
        reset();
        scheduleNextSix();
      }, ms);
    };
    scheduleNextSix();
    return () => clearTimeout(timeoutId);
  }, [reset]);
}
