// 时段分界线配置（1.1.2 新增）：用户可在「设置 → 时段分界线」里自定义
// 早 / 午 / 晚 各自的起点小时。仅小时粒度（无分钟），改完立即生效，无需重启。
//
// 时段按当前钟点划分（与启动弹窗的按时钟过滤一致）：
//   休息 rest   = 00:00 .. morningStart
//   早 morning  = morningStart .. noonStart
//   午 noon     = noonStart .. eveningStart
//   晚 evening  = eveningStart .. 24:00
// 即「休息」跟随 morningStart，morningStart 越大，休息段越长。
//
// 纯前端配置，存于 localStorage（零 Rust 改动）。默认沿用 1.1.1 的原值：6 / 13 / 18。

export interface SlotBounds {
  morningStart: number; // 休息结束 / 早 起点（含）
  noonStart: number; // 午 起点（含）
  eveningStart: number; // 晚 起点（含）
}

export const DEFAULT_SLOT_BOUNDS: SlotBounds = {
  morningStart: 6,
  noonStart: 13,
  eveningStart: 18,
};

const KEY = "nowtree_slot_bounds";

// 内存缓存：避免每次映射都读 localStorage。setSlotBounds 时同步刷新。
let cache: SlotBounds | null = null;

// 将任意值收敛为 0–24 的整数，非法则回退 fallback。
function clampBound(v: unknown, fallback: number): number {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return fallback;
  const i = Math.floor(n);
  return i >= 0 && i <= 24 ? i : fallback;
}

// 校验单调约束：0 < morning < noon < evening <= 24。
export function isValidBounds(b: SlotBounds): boolean {
  return (
    b.morningStart >= 1 &&
    b.morningStart < b.noonStart &&
    b.noonStart < b.eveningStart &&
    b.eveningStart <= 24
  );
}

// 读取当前分界线。非法 / 缺失时回退默认，保证永远有合法值。
export function getSlotBounds(): SlotBounds {
  if (cache) return cache;
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<SlotBounds>;
      const b: SlotBounds = {
        morningStart: clampBound(parsed.morningStart, DEFAULT_SLOT_BOUNDS.morningStart),
        noonStart: clampBound(parsed.noonStart, DEFAULT_SLOT_BOUNDS.noonStart),
        eveningStart: clampBound(parsed.eveningStart, DEFAULT_SLOT_BOUNDS.eveningStart),
      };
      if (isValidBounds(b)) {
        cache = b;
        return cache;
      }
    }
  } catch {
    /* 解析失败则回退默认 */
  }
  cache = { ...DEFAULT_SLOT_BOUNDS };
  return cache;
}

// 保存分界线并刷新缓存。校验交给调用方（SlotBoundsModal）保证合法，此处仍做兜底。
export function setSlotBounds(b: SlotBounds): void {
  const safe: SlotBounds = {
    morningStart: clampBound(b.morningStart, DEFAULT_SLOT_BOUNDS.morningStart),
    noonStart: clampBound(b.noonStart, DEFAULT_SLOT_BOUNDS.noonStart),
    eveningStart: clampBound(b.eveningStart, DEFAULT_SLOT_BOUNDS.eveningStart),
  };
  cache = isValidBounds(safe) ? safe : { ...DEFAULT_SLOT_BOUNDS };
  try {
    localStorage.setItem(KEY, JSON.stringify(cache));
  } catch {
    /* 存储异常忽略，内存缓存已更新 */
  }
}

// 恢复默认分界线。
export function resetSlotBounds(): void {
  setSlotBounds({ ...DEFAULT_SLOT_BOUNDS });
}
