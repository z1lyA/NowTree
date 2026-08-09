// Zustand 状态管理：作为 UI 与数据访问层之间的薄状态层。
// 第一、二步覆盖 Inbox；第三、四步覆盖 Inbox 录入与转换；第五、六步扩展四类视图与 Project 树。
import { create } from "zustand";
import { transactionRepo } from "../data";
import type { Transaction, Status, Category, TxFields } from "../types/transaction";
import { normalizeDeadline, resolveDeadline } from "../types/transaction";
import type { ConvertInput } from "../data/repository";
import { collectSubtreeIds } from "../services/transactionService";
import { notify } from "../services/notification";

// 生成当前 ISO 时间；用于完成时间等字段
const nowISO = () => new Date().toISOString();

// 0.1.20：新建事务的「缺省填充」助手——把三处 create 里重复的
// note/priority/deadline_type/deadline_date/reminder_time 默认值规则收敛到一处。
// 调用方用 ...applyTxDefaults({...}) 展开，再补上 status/category/parent_id 等差异字段。
// 新建事务的「缺省填充」输入类型（C3：复用 transaction.ts 的 TxFields，避免 6 字段 Data Clumps）。
type TxDraft = TxFields;
function applyTxDefaults(d: TxDraft) {
  return {
    title: d.title,
    note: d.note || null,
    priority: d.priority ?? 1,
    deadline_type: d.deadline_type ?? "none",
    deadline_date: d.deadline_date || null,
    reminder_time: d.reminder_time || null,
  };
}

interface TxStore {
  inbox: Transaction[];
  // 所有未删除事务（含 completed）。completed 也保留在数组里，
  // 由视图渲染「划线 + 虚化」样式，不再从列表消失。
  active: Transaction[];
  // 回收站：已软删除（deleted=1）的事务，供恢复 / 彻底删除
  trash: Transaction[];
  loading: boolean;
  error: string | null;
  loadInbox: () => Promise<void>;
  loadActive: () => Promise<void>;
  addInbox: (title: string, note?: string) => Promise<void>;
  removeInbox: (id: number) => Promise<void>;
  convertInbox: (id: number, input: ConvertInput) => Promise<void>;
  // 第六步：在某个项目下新增子事务（可带完整字段）。字段形状复用 TxFields（C3）。
  addChild: (
    parentId: number,
    input: TxFields,
  ) => Promise<void>;
  // 通用就地更新（切换 show_in_next、编辑、设提醒等复用）
  updateTx: (id: number, patch: Partial<Transaction> & { clear_parent?: boolean; clear_reminder?: boolean; clear_note?: boolean }) => Promise<void>;
  // 列表/树的勾选框：在 completed 与 active 之间切换
  toggleComplete: (id: number) => Promise<void>;
  // 第七步：软删除（移出 active）
  deleteTx: (id: number) => Promise<void>;
  // 0.1.6：悬浮加号按钮——在当前界面直接新增对应类别的事务（跳过 Inbox 收集）。
  // 业务字段复用 TxFields，仅补上 category/status（C3：统一类型，避免重复字段块）。
  createTx: (
    input: TxFields & { category: Category | null; status?: Status },
  ) => Promise<void>;
  // 0.1.7：手动拖拽排序。传入某视图内当前顺序的 id 列表，按位置写回 order_index。
  reorder: (ids: number[]) => Promise<void>;
  // 回收站：加载 / 恢复 / 彻底删除 / 清空
  loadTrash: () => Promise<void>;
  restoreTx: (id: number) => Promise<void>;
  purgeTx: (id: number) => Promise<void>;
  emptyTrash: () => Promise<void>;
  // 0.1.18：启动/跨天时扫描，把「具体日期=今天」的 deadline 自动归一为「今日」
  normalizeDeadlines: () => Promise<void>;
  // 1.0.2：Waiting for 设时间要求且已到/逾期的项，自动翻 show_in_next=1 进 Next
  autoPromoteWaiting: () => Promise<void>;
  // 1.1.0：Habits 视图——每日 6 点把「完成时间早于今日 6:00」的 habit 重置回 active
  resetHabits: () => Promise<void>;
  // 提醒：扫描到期且未弹过的 active 事务，弹系统通知并标记已弹。
  checkReminders: () => Promise<void>;
}

export const useTxStore = create<TxStore>((set, get) => ({
  inbox: [],
  active: [],
  trash: [],
  loading: false,
  error: null,

  loadInbox: async () => {
    set({ loading: true, error: null });
    try {
      const list = await transactionRepo.list({ status: "inbox" });
      set({ inbox: list, loading: false });
    } catch (e) {
      set({ error: (e as Error).message, loading: false });
    }
  },

  // 拉取所有未删除事务（active + completed 都包含，completed 用于划线虚化展示）
  loadActive: async () => {
    set({ loading: true, error: null });
    try {
      const list = await transactionRepo.list({});
      set({ active: list, loading: false });
      // 1.0.2：数据写入后再做一次 deadline 归一（具体日期=今天 → 今日）。
      // 修复此前「挂载瞬间扫描时本地数据尚未加载、扫空」导致该功能几乎不触发的问题。
      await get().normalizeDeadlines();
      // 1.1.0：Habits 每日重置（完成时间早于今日 6:00 的 habit 复位），启动即补一次——
      // 若 app 没在 6:00 开着，打开时仍能把昨天完成的 habit 拉回未完成。
      await get().resetHabits();
    } catch (e) {
      set({ error: (e as Error).message, loading: false });
    }
  },

  // A1 修复：写操作统一包裹 try/catch，失败时在 store 暴露 error，
  // 避免 invoke 静默失败导致「界面没反应却不知道出错」。
  addInbox: async (title, note) => {
    try {
      const created = await transactionRepo.create({
        ...applyTxDefaults({ title, note }),
        status: "inbox",
      });
      set({ inbox: [created, ...get().inbox] });
    } catch (e) {
      set({ error: (e as Error).message });
    }
  },

  removeInbox: async (id) => {
    try {
      await transactionRepo.softDelete(id);
      set({ inbox: get().inbox.filter((t) => t.id !== id) });
    } catch (e) {
      set({ error: (e as Error).message });
    }
  },

  // 整理转换：调用 Repository 原地改写该 Inbox 记录；成功后它不再是 inbox，
  // 从 inbox 列表移除，并替换/追加到 active 数组中（避免 loadActive 已加载全部时产生重复）。
  convertInbox: async (id, input) => {
    try {
      const converted = await transactionRepo.convertFromInbox(id, input);
      const existing = get().active.some((t) => t.id === id);
      set({
        inbox: get().inbox.filter((t) => t.id !== id),
        active: existing
          ? get().active.map((t) => (t.id === id ? converted : t))
          : [converted, ...get().active],
      });
    } catch (e) {
      set({ error: (e as Error).message });
    }
  },

  // 第六步：在某个项目下新增子事务。默认 category=next_action、status=active、parent_id=项目 id；
  // 默认 show_in_next=0（仅在该项目内显示），由用户手动「加入 Next」。
  addChild: async (parentId, input) => {
    try {
      const created = await transactionRepo.create({
        ...applyTxDefaults({
          title: input.title,
          note: input.note,
          priority: input.priority,
          deadline_type: input.deadline_type,
          deadline_date: input.deadline_date,
          reminder_time: input.reminder_time,
        }),
        category: "next_action",
        status: "active",
        parent_id: parentId,
      });
      set({ active: [created, ...get().active] });
    } catch (e) {
      set({ error: (e as Error).message });
    }
  },

  // 就地更新某条事务（调用 Repository.update 并同步到 active 数组）。
  updateTx: async (id, patch) => {
    const updated = await transactionRepo.update(id, patch);
    // 0.1.20：同时同步 active 与 inbox 两个数组。
    // 灵感（status=inbox）只存在于 inbox 数组，若只更新 active，编辑灵感后内存里仍是旧数据，
    // 弹窗关闭后 UI 回退成旧备注（DB 已写入但界面不刷新）——表现为「备注存不进去」。
    // 这里把两个数组都 map 一遍：id 命中的那个被替换，另一个 map 无变化。
    set((s) => ({
      active: s.active.map((t) => (t.id === id ? updated : t)),
      inbox: s.inbox.map((t) => (t.id === id ? updated : t)),
    }));
  },

  // 勾选框切换：已完成 ↔ 进行中。取消勾选回到 active。
  toggleComplete: async (id) => {
    const t = get().active.find((x) => x.id === id);
    if (!t) return;
    const patch =
      t.status === "completed"
        ? { status: "active" as const, completed_time: null }
        : { status: "completed" as const, completed_time: nowISO() };
    const updated = await transactionRepo.update(id, patch);
    set({ active: get().active.map((x) => (x.id === id ? updated : x)) });
  },

  // 第七步：软删除（deleted=1，数据仍在库，未来可恢复）。
  // 后端（Tauri）或内存库已级联删除整棵子树；这里只从本地缓存移除该根及其后代。
  // B5：子树收集逻辑收口到 transactionService.collectSubtreeIds，store 不再重写遍历算法。
  deleteTx: async (id) => {
    try {
      await transactionRepo.softDelete(id);
      const active = get().active;
      const remove = new Set<number>([id, ...collectSubtreeIds(active, id)]);
      set({ active: active.filter((t) => !remove.has(t.id)) });
    } catch (e) {
      set({ error: (e as Error).message });
    }
  },

  // 0.1.6：悬浮加号直接创建。inbox 写入 inbox 列表，其余写入 active。
  createTx: async (input) => {
    try {
      const created = await transactionRepo.create({
        ...applyTxDefaults({
          title: input.title,
          note: input.note,
          priority: input.priority,
          deadline_type: input.deadline_type,
          deadline_date: input.deadline_date,
          reminder_time: input.reminder_time,
        }),
        category: input.category,
        status: input.status ?? "active",
      });
      if (input.status === "inbox") {
        set({ inbox: [created, ...get().inbox] });
      } else {
        set({ active: [created, ...get().active] });
      }
    } catch (e) {
      set({ error: (e as Error).message });
    }
  },

  // 0.1.7：手动拖拽排序。A4 修复：改用顺序 await 而非 Promise.all，
  // 避免并发写中途某条失败导致 order_index「半套」索引（前 N 条已落库、后续未写）。
  reorder: async (ids) => {
    try {
      const map = new Map<number, number>();
      for (let idx = 0; idx < ids.length; idx++) {
        await transactionRepo.update(ids[idx], { order_index: idx });
        map.set(ids[idx], idx);
      }
      set((s) => ({
        active: s.active.map((t) =>
          map.has(t.id) ? { ...t, order_index: map.get(t.id)! } : t,
        ),
        inbox: s.inbox.map((t) =>
          map.has(t.id) ? { ...t, order_index: map.get(t.id)! } : t,
        ),
      }));
    } catch (e) {
      set({ error: (e as Error).message });
    }
  },

  // 回收站：拉取已软删除（deleted=1）的事务
  loadTrash: async () => {
    const list = await transactionRepo.listDeleted();
    set({ trash: list });
  },

  // 恢复：deleted 复位 0，重新进入正常列表（刷新 active / inbox / trash）。
  // 注意：必须刷新 loadInbox —— 灵感(status=inbox)不在 active 视图里，
  // 若不刷新 inbox，恢复后的灵感只会从回收站消失、却回不到 Inbox。
  restoreTx: async (id) => {
    await transactionRepo.restore(id);
    await Promise.all([get().loadActive(), get().loadInbox(), get().loadTrash()]);
  },

  // 彻底删除：从库物理移除（释放磁盘空间，不可恢复）。
  // 连同整棵子树从 trash 列表移除（与数据层 purge 级联保持一致）。B5：子树收集复用共享 helper。
  purgeTx: async (id) => {
    try {
      await transactionRepo.purge(id);
      const trash = get().trash;
      const remove = new Set<number>([id, ...collectSubtreeIds(trash, id)]);
      set({ trash: trash.filter((t) => !remove.has(t.id)) });
    } catch (e) {
      set({ error: (e as Error).message });
    }
  },

  // 清空回收站：删除全部已软删除记录
  emptyTrash: async () => {
    await transactionRepo.emptyTrash();
    set({ trash: [] });
  },

  // 0.1.18 + 1.0.2：启动或跨天时，把 deadline_type=date 且 deadline_date=今天的事务自动归一为 today，
  // 并借 resolveDeadline 把"今日"锚点日期写入 deadline_date（而非清空），避免失去锚点。
  normalizeDeadlines: async () => {
    const today = new Date();
    const jobs: Promise<void>[] = [];
    for (const t of get().active) {
      if (t.deadline_type === "date" && t.deadline_date) {
        const norm = normalizeDeadline(t.deadline_type, t.deadline_date, today);
        const dl = resolveDeadline(norm.type, norm.date, today);
        if (dl.type !== t.deadline_type || dl.date !== t.deadline_date) {
          jobs.push(get().updateTx(t.id, { deadline_type: dl.type, deadline_date: dl.date }));
        }
      }
    }
    await Promise.all(jobs);
    // 1.0.2：deadline 归一后紧接执行 Waiting 自动晋升（同一次启动/跨天扫描）；
    // 必须 RUN AFTER 归一，确保 deadline_date 已是最新锚点。
    await get().autoPromoteWaiting();
  },

  // 1.1.0：Habits 每日重置——把「已完成且完成时间早于今日 6:00」的 habit 复位为 active。
  // 逻辑：本地时间跨过 06:00 时，把此刻所有已完成 habit 清零（任何"昨日或今晨 0-6 点"完成的
  // 都早于今日 6:00，符合"昨天完成过 / 0-6 点完成 6 点重置"的界定）；完成时间 >= 今日 6:00 的
  // （即今天 6 点之后才完成的）不重置，留到次日。幂等：已 active 的不命中，重复触发无害。
  resetHabits: async () => {
    const now = new Date();
    // 阈值 = 最近的 06:00 边界：now < 今天 6 点（如凌晨 2 点打开）时回退到昨天 06:00，
    // 这样「昨晚完成的 habit」在 0-6 点仍显示已完成、到 6 点才重置，避免提前 4 小时清空（C1）。
    const todaySix = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 6, 0, 0, 0);
    const threshold =
      now.getTime() < todaySix.getTime()
        ? new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, 6, 0, 0, 0)
        : todaySix;
    const jobs: Promise<void>[] = [];
    for (const t of get().active) {
      if (t.category !== "habit") continue;
      const patch: Partial<Transaction> & { clear_reminder?: boolean } = {};
      // C2：completed_time 为空的已完成 habit（导入/历史数据）也重置——null 视为最旧、必命中。
      if (t.status === "completed") {
        const ct = t.completed_time ? new Date(t.completed_time).getTime() : 0;
        if (ct < threshold.getTime()) {
          patch.status = "active";
          patch.completed_time = null;
        }
      }
      // 1.1.0：habit 提醒是「一次性」。跨天（昨天及更早）的提醒在每日重置时清掉，
      // 避免次日打开 app 补弹「昨天的习惯」——第二天是新的习惯周期，不会去补昨天的。
      // 当天稍后的未来/迟到提醒保留（仍是今天的习惯，可正常响一次）。
      if (t.reminder_time) {
        const rd = new Date(t.reminder_time);
        const isPrevDay =
          rd.getFullYear() !== now.getFullYear() ||
          rd.getMonth() !== now.getMonth() ||
          rd.getDate() !== now.getDate();
        if (isPrevDay) {
          patch.reminder_time = null;
          patch.clear_reminder = true;
        }
      }
      if (Object.keys(patch).length > 0) {
        jobs.push(get().updateTx(t.id, patch));
      }
    }
    await Promise.all(jobs);
  },

  // 1.0.2：Waiting for 设了时间要求且已到/逾期的项，自动翻 show_in_next=1 进 Next，
  // 并置 wait_auto_next=1 标记已晋升，避免每日扫描反复骚扰。
  // 判定统一用 deadline_date（四种类型锚点日期均已写入该列，不依赖 deadline_type 分支），
  // 故本周/本月/今日/具体日期都不会漏；<= 今天 含逾期，到达后一直留。
  autoPromoteWaiting: async () => {
    const today = new Date();
    const y = today.getFullYear();
    const m = today.getMonth() + 1;
    const d = today.getDate();
    const todayStr = `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    const jobs: Promise<void>[] = [];
    for (const t of get().active) {
      const due = t.deadline_date;
      if (
        t.category === "waiting" &&
        t.deadline_type !== "none" &&
        due &&
        due <= todayStr &&
        !t.wait_auto_next
      ) {
        jobs.push(get().updateTx(t.id, { show_in_next: true, wait_auto_next: true }));
      }
    }
    await Promise.all(jobs);
  },

  // 提醒检查：遍历到期且未弹过的 active 事务，弹系统通知并标记已弹。
  // A2 修复 + 并发加固：
  //   - 原 bug：先发通知、后标记；通知一旦抛错则标记永不发生 → 每轮重弹死循环。
  //   - 加固点：在发起任何 await 之前，先「同步」把内存里这条置为已弹（乐观预标记），
  //     关闭并发扫描的竞态窗口——即便 App 因 StrictMode 双挂载等原因产生两轮扫描，
  //     第二轮一读内存就已经是 reminder_done=1，绝不会重复发送。
  //   - DB 标记保证跨重启去重；内存预标记保证同会话内不重发。
  checkReminders: async () => {
    const now = Date.now();
    const due = get().active.filter(
      (t) =>
        t.status !== "completed" &&
        t.reminder_time &&
        t.reminder_done !== 1 &&
        new Date(t.reminder_time).getTime() <= now,
    );
    for (const t of due) {
      // 乐观预标记：在任何异步之前先把内存置「已弹=1 + 清空 reminder_time」，
      // 杜绝并发扫描重复发送，并让铃铛图标立即消失（提醒已触发，无需再展示「有待办提醒」）。
      set((s) => ({
        active: s.active.map((x) =>
          x.id === t.id ? { ...x, reminder_done: 1, reminder_time: null } : x,
        ),
      }));
      try {
        // clear_reminder=true 让后端把 reminder_time 置 NULL（直接传 null 会被「有值才改」逻辑跳过）；
        // 这样提醒触发后即自数据层彻底清除，不会「已弹过却还挂着提醒」反复提示。
        await get().updateTx(t.id, { reminder_done: 1, clear_reminder: true });
        await notify("NowTree 提醒", t.title + (t.note ? "\n" + t.note : ""));
      } catch {
        // 写库或通知失败：内存已标记 + 已清，不会重弹；写库失败仅影响跨重启去重（下一轮会重试一次，无害）
      }
    }
  },
}));
