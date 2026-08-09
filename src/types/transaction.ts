// 单一事实来源：Transaction 类型与业务常量
// 对应 docs/DESIGN.md 第 3 节

export type Status = "inbox" | "active" | "completed";
export type Category = "next_action" | "project" | "waiting" | "someday" | "habit";
export type DeadlineType = "none" | "today" | "week" | "month" | "date";
// 0.1.16：Next 三时段分配（早/午/晚），none 表示未分配时段
export type TimeSlot = "none" | "morning" | "noon" | "evening";

export interface Transaction {
  id: number;
  title: string;
  note: string | null;
  category: Category | null; // Inbox 阶段为 null
  status: Status;
  deadline_type: DeadlineType;
  deadline_date: string | null; // YYYY-MM-DD；date=所选日期，today/week/month=各自锚点日期（最后修改时间要求时由 resolveDeadline 写入）
  priority: number | null; // 1-5，5 最高（最紧急）；默认 1
  created_time: string; // ISO8601
  completed_time: string | null;
  updated_time: string | null;
  parent_id: number | null;
  show_in_next: boolean;
  wait_auto_next: boolean; // 1.0.2：waiting 到期自动进 Next 后标记，避免每日扫描重复触发
  deleted: boolean;
  order_index: number | null;
  // 提醒：到点触发桌面弹窗。reminder_time 为本地时间（datetime-local 的 YYYY-MM-DDTHH:MM）
  reminder_time: string | null;
  reminder_done: 0 | 1; // 是否已弹过，避免重复
  time_slot: TimeSlot; // 0.1.16：Next 三时段分配
  // 0.1.19：稳定全局唯一 ID（UUID），为将来多端同步铺路；本地自增 id 仅作内部索引。
  sync_id: string | null;
  // 0.1.19：软删除时间戳（ISO8601）；deleted=1 时记录何时删，便于将来同步「谁先删」。
  deleted_at: string | null;
}

// 新建/编辑事务时反复搬运的「可变业务字段」集合（C3：统一类型，避免 Data Clumps）。
// title 必填；其余可选，缺失时由调用方按各自默认值处理。
export interface TxFields {
  title: string;
  note?: string | null;
  priority?: number | null;
  deadline_type?: DeadlineType;
  deadline_date?: string | null;
  reminder_time?: string | null;
}

// 0.1.16：日期检测——若选了「具体日期」且日期正好是今天，自动归一成「今日」并清空日期。
// 这样列表/启动弹窗/排序都能统一按 today 处理，避免「今天」被当成未来的具体日期。
export function normalizeDeadline(
  type: DeadlineType,
  date: string | null,
  base: Date = new Date(),
): { type: DeadlineType; date: string | null } {
  if (type !== "date" || !date) return { type, date };
  const y = base.getFullYear();
  const m = base.getMonth() + 1;
  const d = base.getDate();
  const today = `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  if (date === today) return { type: "today", date: null };
  return { type, date };
}

// 1.0.2：把「时间要求」落地为 { type, date }。相对类型（today/week/month）额外把
// 锚点日期写入 deadline_date，使判定逻辑锚定「最后一次修改时间要求那一刻」而非创建时刻——
// 用户重新选择「今日/本周/本月」即刷新锚点；具体日期原样保留；无则清空。
// base 默认当前时间，即"修改时刻"。
export function resolveDeadline(
  type: DeadlineType,
  date: string | null,
  base: Date = new Date(),
): { type: DeadlineType; date: string | null } {
  if (type === "none") return { type, date: null };
  if (type === "date") return { type, date: date || null };
  if (type === "today") return { type, date: fmtDate(base) };
  if (type === "week") return { type, date: fmtDate(weekRange(base).sun) };
  // month：取 base 所在月的最后一天
  const last = new Date(base.getFullYear(), base.getMonth() + 1, 0);
  return { type, date: fmtDate(last) };
}

// 本地当前日期 YYYY-MM-DD（用于"截止日早于今天"等比较场景）
export function todayStr(): string {
  return fmtDate(new Date());
}

// YYYY-MM-DD（本地）格式化
function fmtDate(d: Date): string {
  const y = d.getFullYear();
  const m = d.getMonth() + 1;
  const day = d.getDate();
  return `${y}-${String(m).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

// YYYY-MM-DD → 本地 Date（仅日期部分，时间 00:00）
function parseDate(s: string): Date {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d);
}

// 0.1.16：时段中文标签
export const TIME_SLOT_LABELS: Record<TimeSlot, string> = {
  none: "未分配",
  morning: "早时段",
  noon: "午时段",
  evening: "晚时段",
};

// 业务常量（UI 与逻辑共用）
export const CATEGORIES: Category[] = ["next_action", "project", "waiting", "someday", "habit"];
// 导航栏 data-cat 值 → 实际 Category（"next" 对应 next_action）。
// 0.1.20：从各视图局部拷贝（GenericListView / ProjectListView / NextView.startSlotDrag）
// 收敛到此处单一来源，避免规则漂移。
export const CAT_MAP: Record<string, Category> = {
  next: "next_action",
  project: "project",
  waiting: "waiting",
  someday: "someday",
  habit: "habit",
};
export const CATEGORY_LABELS: Record<Category, string> = {
  next_action: "Next Action",
  project: "Project",
  waiting: "Waiting for",
  someday: "Someday",
  habit: "Habit",
};
export const STATUS_LABELS: Record<Status, string> = {
  inbox: "未整理",
  active: "进行中",
  completed: "已完成",
};

// 每个类别的展示元信息单一来源（C4：避免新增类别时散改多处）。
// label 用于列表/编辑；navLabel 用于侧边栏导航；addTitle 用于「新增」弹窗标题。
export const CATEGORY_META: Record<
  Category,
  { label: string; navLabel: string; addTitle: string }
> = {
  next_action: { label: "Next Action", navLabel: "Next Actions", addTitle: "新增 Next Action 事务" },
  project: { label: "Project", navLabel: "Projects", addTitle: "新增 Project 事务" },
  waiting: { label: "Waiting for", navLabel: "Waiting for", addTitle: "新增 Waiting 事务" },
  someday: { label: "Someday", navLabel: "Someday", addTitle: "新增 Someday 事务" },
  habit: { label: "Habit", navLabel: "Habits", addTitle: "新增习惯" },
};

// 基础标签（不含具体日期）；带日期的选项用 deadlineOptionLabel() 生成
export const DEADLINE_LABELS: Record<DeadlineType, string> = {
  none: "无",
  today: "今日",
  week: "本周",
  month: "本月",
  date: "具体日期",
};

// 本周（周一到周日）的起止日期：返回 base 所在周的周一与周日（含跨月/跨年）。
// 两个 deadline 函数都用到「本周范围」，集中在此一处，避免算法重复（B4）。
export function weekRange(base: Date): { mon: Date; sun: Date } {
  const day = base.getDay(); // 0=周日,1=周一...
  const mon = new Date(base);
  mon.setDate(base.getDate() - (day === 0 ? 6 : day - 1));
  const sun = new Date(mon);
  sun.setDate(mon.getDate() + 6);
  return { mon, sun };
}

// 每种 deadline 类型的「下拉标签」与「截止时刻（本地 23:59:59.999）」单一真相表
// （B4：表驱动，替代原先对 DeadlineType 写两套独立 switch）。end 对 none / 无日期返回 null。
interface DeadlineSpec {
  label: (base: Date) => string;
  end: (base: Date, date: string | null) => Date | null;
}
export const DEADLINE_SPEC: Record<DeadlineType, DeadlineSpec> = {
  none: { label: () => "无", end: () => null },
  today: {
    label: (b) => `今日（${b.getMonth() + 1}.${b.getDate()}）`,
    // 相对类型优先用 deadline_date（锚点），旧数据无锚点时回退 base（创建时刻）
    end: (b, date) => {
      const anchor = date ? parseDate(date) : b;
      return new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate(), 23, 59, 59, 999);
    },
  },
  week: {
    label: (b) => {
      const { mon, sun } = weekRange(b);
      return `本周（${mon.getMonth() + 1}.${mon.getDate()}-${sun.getMonth() + 1}.${sun.getDate()}）`;
    },
    end: (b, date) => {
      const anchor = date ? parseDate(date) : b;
      const { sun } = weekRange(anchor);
      return new Date(sun.getFullYear(), sun.getMonth(), sun.getDate(), 23, 59, 59, 999);
    },
  },
  month: {
    label: (b) => `本月（${b.getMonth() + 1}月）`,
    end: (b, date) => {
      const anchor = date ? parseDate(date) : b;
      const lastDay = new Date(anchor.getFullYear(), anchor.getMonth() + 1, 0);
      return new Date(anchor.getFullYear(), anchor.getMonth(), lastDay.getDate(), 23, 59, 59, 999);
    },
  },
  date: {
    label: () => "具体日期",
    end: (_b, date) => {
      if (!date) return null;
      const [y, m, day] = date.split("-").map(Number);
      return new Date(y, m - 1, day, 23, 59, 59, 999);
    },
  },
};

// 返回当前日期对应的中文简短描述（用于下拉框和列表标签）
export function deadlineOptionLabel(
  type: DeadlineType,
  base: Date = new Date(),
): string {
  return DEADLINE_SPEC[type].label(base);
}

// 计算某个 deadline_type / deadline_date 的截止时间（本地时间 23:59:59.999）
export function deadlineEndTime(
  type: DeadlineType,
  date: string | null,
  base: Date = new Date(),
): Date | null {
  return DEADLINE_SPEC[type].end(base, date);
}

// 判断给定事务的 DDL 是否已经过期（当前时间 > 截止时间，且尚未完成）
// 相对截止日（today/week/month）优先锚定 deadline_date（最后一次修改时间要求时写入的日期）；
// 旧数据该列为空时回退「创建时刻」，保证跨月/周后正确逾期且向后兼容。
export function isDeadlineOverdue(t: Transaction, now: Date = new Date()): boolean {
  if (t.status === "completed" || t.deadline_type === "none") return false;
  const base = new Date(t.created_time); // 回退基准：创建时刻（新数据由 deadline_date 覆盖）
  const end = deadlineEndTime(t.deadline_type, t.deadline_date, base);
  if (!end) return false;
  return now.getTime() > end.getTime();
}

export const PRIORITY_MAX = 5;
// 注意：优先级默认 1，只有用户显式选择才改变；列表中用整行左侧色条 + 淡底色表示。
// 编辑弹窗中选中态用对应优先级颜色边框高亮，不使用主题色。

// 列表排序比较器（0.1.7 手动拖拽排序用）：
// 已设 order_index 的排前面并按其升序；未设的（null）按 created_time 升序兜底。
export function byOrder(a: Transaction, b: Transaction): number {
  const ao = a.order_index;
  const bo = b.order_index;
  if (ao != null && bo != null) return ao - bo;
  if (ao != null) return -1;
  if (bo != null) return 1;
  if (a.created_time < b.created_time) return -1;
  if (a.created_time > b.created_time) return 1;
  return 0;
}

// 工具栏排序：按优先级（高优先在前；null 视为最低 0），同优先级回退 byOrder。
export function byPriority(a: Transaction, b: Transaction): number {
  const ap = a.priority ?? 0;
  const bp = b.priority ?? 0;
  if (bp !== ap) return bp - ap;
  return byOrder(a, b);
}

// 工具栏排序：按完成情况（未完成在前，已完成在后；同状态回退 byOrder）。
export function byCompletion(a: Transaction, b: Transaction): number {
  const ac = a.status === "completed" ? 1 : 0;
  const bc = b.status === "completed" ? 1 : 0;
  if (ac !== bc) return ac - bc;
  return byOrder(a, b);
}

// 工具栏排序：按「时间要求」的最晚截止时刻升序（最靠近现在的排前面）。
// 规则：本周取周日、本月取月底、今日取当天、具体日期取当天，均取当日 23:59:59。
// 无时间要求（none / 未设日期）视为无限远，排到最后；截止相同则回退 byOrder。
// 注意：today/week/month 的截止日优先取 deadline_date（锚点），旧数据回退创建时刻，
// 保证跨月/跨周后正确排序与逾期。
export function byTime(a: Transaction, b: Transaction): number {
  const ea = deadlineEndTime(a.deadline_type, a.deadline_date, new Date(a.created_time));
  const eb = deadlineEndTime(b.deadline_type, b.deadline_date, new Date(b.created_time));
  const ta = ea ? ea.getTime() : Number.POSITIVE_INFINITY;
  const tb = eb ? eb.getTime() : Number.POSITIVE_INFINITY;
  if (ta !== tb) return ta - tb;
  return byOrder(a, b);
}
