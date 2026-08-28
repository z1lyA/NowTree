import type { TimeSlot } from "../types/transaction";
import { getSlotBounds } from "./slotBounds";

export type ClockSlot = "morning" | "noon" | "evening" | "rest";

// 按当前钟点映射时段（与启动弹窗的按时钟过滤一致）。
// 分界点由用户自定义（默认 早6 / 午13 / 晚18，见 slotBounds.ts），改完立即生效；
//   休息 rest   = 00:00 .. morningStart
//   早 morning  = morningStart .. noonStart
//   午 noon     = noonStart .. eveningStart
//   晚 evening  = eveningStart .. 24:00
// morningStart 之前的钟点视为「休息」，用于弹窗显示「早点休息」而非任务列表。
export function currentClockSlot(d: Date = new Date()): ClockSlot {
  const h = d.getHours();
  const { morningStart, noonStart, eveningStart } = getSlotBounds();
  if (h < morningStart) return "rest";
  if (h < noonStart) return "morning";
  if (h < eveningStart) return "noon";
  return "evening";
}

// 仅返回三个任务时段，供需要遍历时段的场景使用（不含 rest）。
export const TASK_SLOTS: TimeSlot[] = ["morning", "noon", "evening"];
