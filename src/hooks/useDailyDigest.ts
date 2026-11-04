// 1.1.5：每日摘要卡的触发侧（替代原「每次启动 / 跨时段自动弹窗」）。
//
// - 等 loadActive 完成（ready=true）后再查，避免数据未加载就显示「暂无安排」；
// - 每 30 秒查一次当前钟点所属时段（分界点来自「设置 → 时段分界线」）；
// - 同一「本地日期 + 时段」只推一次卡（localStorage nowtree_daily_digest_last）；
// - **卡片投递成功后才写去重标记**：投递失败（窗口创建异常等）下一轮会重试，不会「标记了却看不到」；
// - 卡片内容（问候 / 日期 / 励志语 / 该时段事务）由 services/dailyDigest 组装。
import { useEffect } from "react";
import { useTxStore } from "../store/useTxStore";
import { currentClockSlot } from "../utils/clock";
import { dailyCardOf } from "../services/dailyDigest";
import { pushReminderCards } from "../services/reminders";
import { localDateKey } from "../utils/weeklyReview";
import { readDailyDigestMark, writeDailyDigestMark } from "../utils/reminderMarks";
import { getReminderPrefs } from "../utils/reminderPrefs";

const CHECK_INTERVAL_MS = 30_000;
const FIRST_CHECK_DELAY_MS = 1500;

export function useDailyDigest(ready: boolean) {
  const active = useTxStore((s) => s.active);

  useEffect(() => {
    if (!ready) return;
    let disposed = false;
    // 防止「推送还在进行中，下一轮定时又触发」造成重复投递（投递成功后才写标记）。
    let inFlight = false;

    const check = async () => {
      if (disposed || inFlight) return;
      // 偏好：全局弹窗开关 / 每日摘要开关（关闭时不投递、不写标记，重新打开后仍能补上）。
      const prefs = getReminderPrefs();
      if (!prefs.enabled || !prefs.showDailyDigest) return;
      const now = new Date();
      const slot = currentClockSlot(now);
      const key = `${localDateKey(now)}:${slot}`;
      if (readDailyDigestMark() === key) return;
      inFlight = true;
      try {
        const delivered = await pushReminderCards([dailyCardOf({ now, slot, active })]);
        if (!delivered) return;
        writeDailyDigestMark(key);
      } catch (e) {
        // 弹窗没能创建 / 渲染时保留未推送状态，下一轮（30s 后）重试。
        console.error("[NowTree] 每日摘要卡弹出失败，稍后重试", e);
      } finally {
        inFlight = false;
      }
    };

    const first = window.setTimeout(() => void check(), FIRST_CHECK_DELAY_MS);
    const timer = window.setInterval(() => void check(), CHECK_INTERVAL_MS);
    return () => {
      disposed = true;
      window.clearTimeout(first);
      window.clearInterval(timer);
    };
  }, [ready, active]);
}
