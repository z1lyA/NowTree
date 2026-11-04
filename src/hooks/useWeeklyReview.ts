// 1.1.5：Inbox「每周回顾」提醒的触发侧。
//
// 检查时机：应用启动后 3 秒首查 → 之后每 5 分钟 → 窗口重新获得焦点时。
// 命中后**投递成功才落**「今天已提醒」标记：投递失败（窗口异常等）下次检查还能重试，
// 不会出现「标记了、卡却没弹」；用 inFlight 防止并发检查重复弹出。Inbox 为空不弹。
// 判定与存储都在 utils/weeklyReview.ts，这里只负责节流与投递。
import { useEffect } from "react";
import {
  getLastShownDate,
  getWeeklyReview,
  markWeeklyReviewShown,
  shouldShowWeeklyReview,
} from "../utils/weeklyReview";
import { pushReminderCards, weeklyReviewCard } from "../services/reminders";
import { getReminderPrefs } from "../utils/reminderPrefs";

const FIRST_CHECK_DELAY_MS = 3000;
const CHECK_INTERVAL_MS = 5 * 60 * 1000;

export function useWeeklyReview(inboxCount: number) {
  useEffect(() => {
    let disposed = false;
    let inFlight = false;

    const check = async () => {
      if (disposed || inFlight) return;
      // 全局弹窗开关关闭时，不投递也不写标记（重新打开后仍能补上）。
      if (!getReminderPrefs().enabled) return;
      const now = new Date();
      const setting = getWeeklyReview();
      const lastShownDate = getLastShownDate();
      if (!shouldShowWeeklyReview({ now, setting, lastShownDate, inboxCount })) return;
      inFlight = true;
      try {
        const delivered = await pushReminderCards([weeklyReviewCard(inboxCount, now)]);
        if (!delivered) return;
        markWeeklyReviewShown(now);
      } catch (e) {
        console.error("[NowTree] 每周回顾卡弹出失败，稍后重试", e);
      } finally {
        inFlight = false;
      }
    };

    const first = window.setTimeout(() => void check(), FIRST_CHECK_DELAY_MS);
    const timer = window.setInterval(() => void check(), CHECK_INTERVAL_MS);
    const onFocus = () => void check();
    window.addEventListener("focus", onFocus);
    return () => {
      disposed = true;
      window.clearTimeout(first);
      window.clearInterval(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, [inboxCount]);
}
