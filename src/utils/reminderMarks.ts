// 1.1.5：提醒相关的一次性标记（localStorage）。
//
// 背景：早期开发构建里，「每日摘要卡」是先写「今天这个时段已推送」再创建提醒窗口的，
// 而窗口创建当时会死锁（同步命令建窗）——于是标记写了、卡却没弹出来。
// 这里做一次性清理：升级到修复版后的第一次启动，把「今日摘要 / 每周回顾」的已推送日期清掉一次，
// 让当天能重新触发；清理完成后写一个迁移标记，之后恢复正常去重。
// 只动这两个提醒去重键，主题 / 时段分界线 / 音效 / 托盘偏好等本地设置一概不碰。

import { WEEKLY_REVIEW_LAST_KEY } from "./weeklyReview";

export const DAILY_DIGEST_LAST_KEY = "nowtree_daily_digest_last";
const MIGRATION_KEY = "nowtree_reminder_marks_reset_1_1_5";

// 读取「上次推送每日摘要」的键（<本地日期>:<slot>）。
export function readDailyDigestMark(): string | null {
  try {
    return localStorage.getItem(DAILY_DIGEST_LAST_KEY);
  } catch {
    return null;
  }
}

// 记录「某日的某个时段已推送」；只在卡片成功投递之后调用，避免「标记了却没弹」。
export function writeDailyDigestMark(value: string): void {
  try {
    localStorage.setItem(DAILY_DIGEST_LAST_KEY, value);
  } catch {
    /* 存储异常忽略 */
  }
}

// 一次性清理早期构建写入的「已推送」标记（只执行一次）。
export function resetStaleReminderMarksOnce(): void {
  try {
    if (localStorage.getItem(MIGRATION_KEY) === "1") return;
    localStorage.removeItem(DAILY_DIGEST_LAST_KEY);
    localStorage.removeItem(WEEKLY_REVIEW_LAST_KEY);
    localStorage.setItem(MIGRATION_KEY, "1");
  } catch {
    /* 存储异常忽略 */
  }
}
