// 新增 / 编辑弹窗共用的字段表单（0.1.19 抽离，消除 AddModal / EditModal 的字段重复）。
// 本组件只负责：渲染字段 + 收集字段值 + 基本的「标题非空 / 防重复提交」校验，
// 并通过 onSubmit 回调把值交出去；store 的写入（createTx / updateTx）、日期归一、
// clear_reminder 标志等「保存时的业务逻辑」由外层弹窗处理。
import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import {
  PRIORITY_MAX,
  CATEGORIES,
  CATEGORY_LABELS,
  deadlineOptionLabel,
  normalizeDeadline,
  resolveDeadline,
  todayStr,
  type Category,
  type DeadlineType,
} from "../types/transaction";
import { showToast } from "../toast";

export interface TxFormValues {
  title: string;
  note: string;
  category: Category;
  priority: number;
  deadlineType: DeadlineType;
  deadlineDate: string;
  reminderTime: string;
  // 1.0.2 优化：用户是否动过「时间要求」那一栏。保存时据此决定
  // 原样回写还是重算，并据此把关「过期拦截」toast。表单内部用 state 管理，initial 不需传。
  deadlineInteracted?: boolean;
}

interface TransactionFormProps {
  initial: TxFormValues;
  // inbox：仅 标题 + 备注（与 Inbox 收集语义一致），隐藏类型/优先级/时间要求/提醒。
  inbox?: boolean;
  // 是否显示「类型」分段选择（编辑弹窗在非 inbox 且非 hideCategory 时为 true）。
  showCategory?: boolean;
  // 1.1.0：习惯（habit）模式——隐藏优先级 / 时间要求 / 提醒（习惯每天重置，不需要这些字段）。
  habit?: boolean;
  submitLabel: string;
  onCancel: () => void;
  onSubmit: (v: TxFormValues) => void | Promise<void>;
  // 额外操作按钮（如编辑弹窗的「删除」），渲染在 取消 与 主按钮 之间。
  extraActions?: ReactNode;
  // 额外字段插槽（如 ConvertModal 的「父事务」选择器），仅在 category==="project" 时渲染。
  parentSelect?: ReactNode;
  // 批量场景：值变化时把字段重置回 initial（如 AddChildModal 的「添加并继续」）。
  resetKey?: number;
}

const DEADLINES: DeadlineType[] = ["none", "today", "week", "month", "date"];

function formatReminder(iso: string) {
  return iso.replace("T", " ");
}

// 当前本地时间，供 datetime-local 的 min 属性用（YYYY-MM-DDTHH:MM），从 UI 层面阻止选过去时间。
function nowLocalDatetime(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

// 程序化打开原生日期/时间选择器（必须在用户手势内调用）
function openPicker(ref: React.RefObject<HTMLInputElement>) {
  const el = ref.current;
  if (!el) return;
  try {
    el.showPicker();
  } catch {
    try {
      el.focus();
      el.click();
    } catch {
      /* 不支持则忽略 */
    }
  }
}

export default function TransactionForm({
  initial,
  inbox,
  showCategory,
  habit,
  submitLabel,
  onCancel,
  onSubmit,
  extraActions,
  parentSelect,
  resetKey,
}: TransactionFormProps) {
  const [title, setTitle] = useState(initial.title);
  const [note, setNote] = useState(initial.note);
  const [category, setCategory] = useState<Category>(initial.category);
  const [priority, setPriority] = useState<number>(initial.priority);
  const [deadlineType, setDeadlineType] = useState<DeadlineType>(initial.deadlineType);
  const [deadlineDate, setDeadlineDate] = useState(initial.deadlineDate);
  const [reminderTime, setReminderTime] = useState(initial.reminderTime);
  const [deadlineInteracted, setDeadlineInteracted] = useState(false);
  const [reminderInteracted, setReminderInteracted] = useState(false);
  const savingRef = useRef(false);
  const dateRef = useRef<HTMLInputElement>(null);
  const reminderRef = useRef<HTMLInputElement>(null);

  // 1.0.2 优化：编辑已逾期项时，时间要求下拉「伪装」显示成「无」，但内部 deadlineType 仍保留真实值，
  // 不触碰数据 → 列表中的逾期红标照常保留；用户一旦操作该栏（deadlineInteracted）即解除伪装、走真实逻辑。
  // 新建场景 initial 无逾期项，isInitialOverdue 恒为 false，伪装不触发，行为不变。
  const isInitialOverdue =
    initial.deadlineType !== "none" && !!initial.deadlineDate && initial.deadlineDate < todayStr();
  const displayDeadlineType = !deadlineInteracted && isInitialOverdue ? "none" : deadlineType;

  // 批量添加场景：resetKey 递增时把字段重置回 initial（不清空父级状态，如 AddChildModal 的 batchId）。
  useEffect(() => {
    setTitle(initial.title);
    setNote(initial.note);
    setCategory(initial.category);
    setPriority(initial.priority);
    setDeadlineType(initial.deadlineType);
    setDeadlineDate(initial.deadlineDate);
    setReminderTime(initial.reminderTime);
    setDeadlineInteracted(false);
    setReminderInteracted(false);
    savingRef.current = false;
  }, [resetKey]); // eslint-disable-line react-hooks/exhaustive-deps

  async function submit() {
    if (savingRef.current) return;
    const t = title.trim();
    if (!t) return;
    // 1.0.2 优化：非 inbox 项若设了早于今天的"时间要求"则拦截保存，弹 toast 轻提示并引导重选，
    // 避免存入过去日期导致 waiting 瞬间误进 Next。**仅当用户动过时间要求那栏才校验**
    // ——否则打开一个有过去日期的逾期项（如昨天选的本日）只改个备注保存，会被误拦，违背"打开看一眼不改动数据"。
    if (!inbox && deadlineInteracted) {
      const norm = normalizeDeadline(
        deadlineType,
        deadlineType === "date" ? (deadlineDate || null) : null,
      );
      const dl = resolveDeadline(norm.type, norm.date);
      if (dl.date && dl.date < todayStr()) {
        showToast("你设置的时间已过期，请重新设置");
        return;
      }
    }
    // 1.1.0：提醒时间同样禁止设成过去（照搬时间要求的「过期拦截」；仅当用户动过提醒栏才校验，
    //     避免打开一个已有过去提醒的项只改备注就被误拦）。
    if (!inbox && reminderInteracted && reminderTime) {
      if (new Date(reminderTime).getTime() <= Date.now()) {
        showToast("你设置的提醒时间已过期，请重新设置");
        return;
      }
    }
    savingRef.current = true;
    try {
      await onSubmit({
        title: t,
        note: note.trim(),
        category,
        priority,
        deadlineType,
        deadlineDate,
        reminderTime,
        deadlineInteracted,
      });
    } finally {
      savingRef.current = false;
    }
  }

  function handleNoteKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && (e.ctrlKey || e.shiftKey)) {
      e.preventDefault();
      const el = e.currentTarget;
      const start = el.selectionStart ?? note.length;
      const end = el.selectionEnd ?? note.length;
      const v = note.slice(0, start) + "\n" + note.slice(end);
      setNote(v);
      requestAnimationFrame(() => {
        el.selectionStart = el.selectionEnd = start + 1;
      });
    } else if (e.key === "Enter" && !e.ctrlKey && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  }

  function handleDeadlineChange(e: React.ChangeEvent<HTMLSelectElement>) {
    const val = e.target.value as DeadlineType;
    setDeadlineType(val);
    setDeadlineInteracted(true);
    if (val === "date") openPicker(dateRef);
  }

  function clearDeadline() {
    setDeadlineType("none");
    setDeadlineDate("");
    setDeadlineInteracted(true);
  }

  function onReminderChange(e: React.ChangeEvent<HTMLInputElement>) {
    setReminderTime(e.target.value);
    setReminderInteracted(true);
  }

  return (
    <>
      <label className="field">
        <span>标题</span>
        <input
          value={title}
          autoFocus
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              submit();
            }
          }}
        />
      </label>

      <label className="field">
        <span>备注</span>
        <textarea
          rows={3}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          onKeyDown={handleNoteKeyDown}
        />
      </label>

      {/* inbox 编辑、或 Next 展示项（子事务 / waiting / someday 凭 show_in_next 透出）由 hideCategory 统一隐藏类型模块 */}
      {!inbox && showCategory && (
        <div className="field">
          <span>类型</span>
          <div className="seg">
            {CATEGORIES.map((c) => (
              <button
                key={c}
                type="button"
                className={`seg-item ${category === c ? "on" : ""}`}
                onClick={() => setCategory(c)}
              >
                {CATEGORY_LABELS[c]}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* parentSelect 插槽：如 ConvertModal 的「父事务」选择器，仅 project 类型时渲染 */}
      {!inbox && showCategory && category === "project" && parentSelect}

      {!inbox && !habit && (
        <>
          <div className="field">
            <span>优先级</span>
            <div className="seg">
              {Array.from({ length: PRIORITY_MAX }, (_, i) => i + 1).map((p) => (
                <button
                  key={p}
                  type="button"
                  className={`seg-item pri-${p} ${priority === p ? "on" : ""}`}
                  onClick={() => setPriority(p)}
                  title={`优先级 ${p}`}
                />
              ))}
            </div>
          </div>

          <div className="field inline-row">
            <span>时间要求</span>
            <div className="reminder-picker">
              <select
                className="deadline-select"
                value={displayDeadlineType}
                onChange={handleDeadlineChange}
              >
                {DEADLINES.map((d) => (
                  <option key={d} value={d}>
                    {deadlineOptionLabel(d)}
                  </option>
                ))}
              </select>
              <input
                ref={dateRef}
                type="date"
                className="reminder-input-hidden"
                value={deadlineDate}
                onChange={(e) => {
                  setDeadlineDate(e.target.value);
                  setDeadlineInteracted(true);
                }}
              />
              {displayDeadlineType === "date" && deadlineDate && (
                <>
                  <span className="reminder-value" onClick={() => openPicker(dateRef)}>
                    {deadlineDate}
                  </span>
                  <button type="button" className="btn-ghost" onClick={clearDeadline}>
                    清除
                  </button>
                </>
              )}
            </div>
          </div>
        </>
      )}

      {/* 1.1.0：提醒对 habit 也开放（一次性提醒，与全局一致）；inbox 仍隐藏。
          注：habit 的「一次性提醒」弹过即焚、6 点重置不恢复，故对 habit 只响一次。 */}
      {!inbox && (
        <div className="field inline-row">
          <span>提醒</span>
          <div className="reminder-picker">
            <button
              type="button"
              className="reminder-icon-btn"
              title="选择提醒时间"
              onClick={() => openPicker(reminderRef)}
            >
              📅
            </button>
            <input
              ref={reminderRef}
              type="datetime-local"
              className="reminder-input-hidden"
              value={reminderTime}
              min={nowLocalDatetime()}
              onChange={onReminderChange}
            />
            {reminderTime && (
              <span className="reminder-value">{formatReminder(reminderTime)}</span>
            )}
            {reminderTime && (
              <button
                type="button"
                className="btn-ghost"
                onClick={() => setReminderTime("")}
              >
                清除
              </button>
            )}
          </div>
        </div>
      )}

      <div className="modal-actions">
        <button className="btn-ghost" onClick={onCancel}>
          取消
        </button>
        {extraActions}
        <button
          className="btn-primary"
          onClick={submit}
          disabled={!title.trim()}
          onKeyDown={(e) => {
            // 0.1.20：显式支持「回车保存」——焦点落在保存按钮上时，回车直接保存。
            // preventDefault 阻止浏览器默认的「回车=点击」，避免重复提交（submit 内部有 savingRef 兜底）。
            if (e.key === "Enter" && !e.ctrlKey && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
        >
          {submitLabel}
        </button>
      </div>
    </>
  );
}
