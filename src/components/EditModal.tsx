// 统一编辑弹窗（0.1.19 字段抽离到 TransactionForm）。
// 本文件仅保留：弹窗外壳 + 「保存 / 删除」的 store 写入逻辑（含日期归一、clear_reminder 标志）。
// 字段顺序与展示规则（标题→备注→[类型]→优先级→时间要求→提醒）由 TransactionForm 负责。
// Inbox 条目编辑：只改标题/备注，不改类别与状态（避免把灵感误转成正式事务）。
import { useMemo, useState } from "react";
import Modal from "./common/Modal";
import TransactionForm, { type TxFormValues } from "./TransactionForm";
import NextToggleButton from "./NextToggleButton";
import { useTxStore } from "../store/useTxStore";
import { normalizeDeadline, resolveDeadline, type Transaction } from "../types/transaction";
import {
  attachToParentPatch,
  buildCategoryPatch,
  isSameSnapshot,
  parentCandidates,
  txSnapshotOf,
  type TxSnapshot,
} from "../services/transactionService";
import { showToast } from "../toast";

interface EditModalProps {
  tx: Transaction;
  onClose: () => void;
  // Inbox 条目编辑：只改标题/备注，不改类别与状态（避免把灵感误转成正式事务）
  inbox?: boolean;
  // 自定义删除行为（Inbox 用 removeInbox 而非 deleteTx）
  onDelete?: () => void;
  // 0.1.16：隐藏「类型」分段选择（Project 子事务 / Next 展示项：子事务·waiting·someday 凭 show_in_next 透出）
  hideCategory?: boolean;
  // 1.1.3：是否从 Next 视图打开。仅从 Next 视图打开时，编辑弹窗内才显示「展示在 Next」开关，
  // 避免 Project 父项 / Waiting·Someday·Project 子项的编辑弹窗重复出现该开关（其 Next 状态由行内开关管理）。
  fromNext?: boolean;
}

export default function EditModal({ tx, onClose, inbox, onDelete, hideCategory, fromNext }: EditModalProps) {
  const { updateTx, deleteTx, active, releaseDescendants } = useTxStore();
  const [confirmDel, setConfirmDel] = useState(false);
  // 1.1.4：改为 Project 时可直接挂到某个现有 Project 下（默认「无」= 独立 Project）。
  // 顶层 Project 的 parent_id 恒为 null，取 ?? null 是为将来多级结构留余地。
  const [parentId, setParentId] = useState<number | null>(tx.parent_id ?? null);
  const parentOptions = useMemo(() => parentCandidates(active, tx.id), [active, tx.id]);

  async function handleSave(v: TxFormValues) {
    const t = v.title.trim();
    if (!t) return;
    // 备注：空串视为清空。Rust 端 note 是 Option<String>，传 null 会被反序列化为
    // None 而「跳过该列不更新」，导致清不掉；故用 clear_note 标志显式置 NULL
    // （与 clear_reminder 同一范式）。非空则照常写入。
    const noteTrim = v.note.trim();
    const notePatch = noteTrim ? { note: noteTrim } : { clear_note: true };
    // B（1.1.4）：改为 Project 且选了父事务 → 保存后成为该父的子事务。
    // 拦截必须先于下面的「释放子事务」执行，否则会先释放再报错。
    const attachTo = v.category === "project" && parentId != null ? parentId : null;
    if (attachTo != null) {
      // ① 自身还有活跃子事务 → 挂父后它的子事务会变成任何视图都不渲染的孤儿
      if (active.some((c) => c.parent_id === tx.id)) {
        showToast("该项目下还有子事务，请先处理它们再挂到别的项目下");
        return;
      }
      // ② 目标父已失效（被删 / 已改类别 / 已完成 / 非顶层）
      const father = active.find((p) => p.id === attachTo);
      if (
        !father ||
        father.category !== "project" ||
        father.parent_id !== null ||
        father.status === "completed"
      ) {
        showToast("所选父事务已失效，请重新选择");
        return;
      }
    }
    // A（1.1.3）：父事务（project）改类别离开 Project，且仍有活跃子事务 →
    // 整棵子树释放进回收站（父自身随改类别保留），避免子事务从所有视图凭空消失。
    let releasedCount = 0;
    if (!inbox && tx.category === "project" && v.category !== "project") {
      const hasKids = active.some((c) => c.parent_id === tx.id);
      if (hasKids) {
        const released = await releaseDescendants(tx.id);
        releasedCount = released.length;
      }
    }
    // 类别/父级补丁：挂父 → next_action + parent_id（子事务的真实存储形态，见 store.addChild）；
    // 否则走 buildCategoryPatch 与拖拽改类别共用同一套规则（含「改成顶层 Project 时清
    // show_in_next + time_slot」，避免 Waiting/Someday 透出的项改 Project 后仍赖在 Next）。
    const catPatch: Partial<Transaction> =
      attachTo != null
        ? attachToParentPatch(tx, attachTo, active)
        : buildCategoryPatch(tx, v.category);

    // 1.1.4：改动检测——只有确实改过才提示「修改已保存」。
    // 时间要求仅在用户动过该栏时按真实值重算，与下面两个保存分支同一口径。
    const dl = v.deadlineInteracted
      ? (() => {
          const norm = normalizeDeadline(
            v.deadlineType,
            v.deadlineType === "date" ? (v.deadlineDate || null) : null,
          );
          const r = resolveDeadline(norm.type, norm.date);
          return { type: r.type, date: r.date };
        })()
      : { type: tx.deadline_type, date: tx.deadline_date };
    // inbox 灵感只写标题/备注，其余字段保持不变（category 为 null，不能拿表单兜底值参与比较）
    const nextSnap: TxSnapshot = inbox
      ? { ...txSnapshotOf(tx), title: t, note: noteTrim || null }
      : {
          title: t,
          note: noteTrim || null,
          category: attachTo != null ? "next_action" : v.category,
          priority: v.priority,
          deadline_type: dl.type,
          deadline_date: dl.date,
          reminder_time: v.reminderTime || null,
          parent_id: attachTo ?? tx.parent_id,
        };
    const changed = !isSameSnapshot(txSnapshotOf(tx), nextSnap);
    if (inbox) {
      // Inbox 灵感编辑：仅改标题与备注，保持 status=inbox、category=null
      updateTx(tx.id, { title: t, ...notePatch });
    } else if (!v.deadlineInteracted) {
      // 1.0.2 优化：用户没动过「时间要求」那栏 → 原样回写原始 deadline，
      // 跳过 resolveDeadline 重算。否则打开一个逾期项（如昨天选的本日）只改备注再保存，
      // 会被重算成"今天"从而救活逾期、红标消失。手动移出 Next 的 wait_auto_next 标记也一并保留。
      updateTx(tx.id, {
        title: t,
        ...notePatch,
        ...catPatch,
        deadline_type: tx.deadline_type,
        deadline_date: tx.deadline_date,
        priority: v.priority,
        reminder_time: v.reminderTime || null,
        clear_reminder: v.reminderTime === "" ? true : undefined,
        reminder_done: 0,
      });
    } else {
      // 0.1.16 + 1.0.2：日期检测 + 的分支——用户改动过时间要求，按真实值重算锚点写入 deadline_date
      const norm = normalizeDeadline(
        v.deadlineType,
        v.deadlineType === "date" ? (v.deadlineDate || null) : null,
      );
      const dres = resolveDeadline(norm.type, norm.date);
      // 1.0.2 优化：用户在「表单层」改动了时间要求（对 normalize 每日重锚免疫），
      // 且类别为 waiting 时，把 wait_auto_next 清回 0 重新"上膛"——新日期到了会再次自动进 Next；
      // 仅改标题/备注或切回同类型则不受影响，手动移出 Next 的护栏继续生效。
      const deadlineChanged =
        v.deadlineType !== tx.deadline_type ||
        (v.deadlineType === "date" && (v.deadlineDate || "") !== (tx.deadline_date ?? ""));
      updateTx(tx.id, {
        title: t,
        ...notePatch,
        ...catPatch,
        deadline_type: dres.type,
        deadline_date: dres.date,
        priority: v.priority,
        reminder_time: v.reminderTime || null,
        // 0.1.19：清空提醒（reminderTime 为空）时带 clear_reminder 标志，
        // 让 Rust 端把 reminder_time 真正置 NULL（否则传 null 会被后端「有值才改」逻辑跳过）。
        clear_reminder: v.reminderTime === "" ? true : undefined,
        reminder_done: 0,
        ...(deadlineChanged && tx.category === "waiting" ? { wait_auto_next: false } : {}),
      });
    }
    // 1.1.4：统一保存提示。toast 单槽（后弹覆盖先弹），故释放子事务的数量并进同一句。
    if (changed) {
      showToast(
        releasedCount > 0
          ? `修改已保存，${releasedCount} 个子事务已移入回收站`
          : "修改已保存",
      );
    }
    onClose();
  }

  async function remove() {
    if (!confirmDel) {
      setConfirmDel(true);
      return;
    }
    if (onDelete) {
      onDelete();
      onClose();
      return;
    }
    await deleteTx(tx.id);
    onClose();
  }

  const showCategory = !inbox && !hideCategory;

  // 1.1.3：编辑弹窗内的「展示在 Next」开关（复用 NextToggleButton，与 Waiting/Someday 同款）。
  // 仅当从 Next 视图打开（fromNext）且非原生 next_action 顶层项时显示；
  // 原生 next_action 靠 category 常驻 Next，开关无意义；其它视图（Project/Wating/Someday）的
  // Next 状态由行内开关管理，编辑弹窗内不再重复出现。即时翻转，不随保存。
  const showNextToggle =
    !!fromNext && !(tx.category === "next_action" && tx.parent_id === null);

  return (
    <Modal title={inbox ? "编辑灵感" : "编辑事务"} onClose={onClose}>
      <TransactionForm
        initial={{
          title: tx.title,
          note: tx.note ?? "",
          category: tx.category ?? "next_action",
          priority: tx.priority ?? 1,
          deadlineType: tx.deadline_type,
          deadlineDate: tx.deadline_date ?? "",
          reminderTime: tx.reminder_time ?? "",
        }}
        inbox={inbox}
        showCategory={showCategory}
        submitLabel="保存"
        onCancel={onClose}
        onSubmit={handleSave}
        parentSelect={
          // 1.1.4：类型为 Project 时出现在「类型」正下方（插槽位置与门控由 TransactionForm 负责）
          <div className="field">
            <span>父事务</span>
            <select
              className="deadline-select parent-select"
              value={parentId ?? ""}
              onChange={(e) => setParentId(e.target.value ? Number(e.target.value) : null)}
            >
              <option value="">无</option>
              {parentOptions.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.title}
                </option>
              ))}
            </select>
          </div>
        }
        extraActions={
          <button
            className={`btn-danger ${confirmDel ? "on" : ""}`}
            onClick={remove}
          >
            {confirmDel ? "确认删除？" : "删除"}
          </button>
        }
        extraBody={
          showNextToggle ? (
            <div className="field inline-row">
              <span>展示在 Next</span>
              <NextToggleButton t={tx} />
            </div>
          ) : undefined
        }
      />
    </Modal>
  );
}
