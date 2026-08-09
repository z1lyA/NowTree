// 0.1.6 悬浮加号按钮的「直接新增」弹窗（0.1.19 字段抽离到 TransactionForm）。
// 类别由外部固定传入（即当前界面类别），弹窗标题写明「新增 XX 事务」，不再出现类别选择板块。
// - inbox：仅 标题 + 备注（与 Inbox 收集语义一致）。
// - 其他类别：标题 + 备注 + 优先级 + 时间要求 + 提醒（由 TransactionForm 渲染）。
import Modal from "./common/Modal";
import TransactionForm, { type TxFormValues } from "./TransactionForm";
import { useTxStore } from "../store/useTxStore";
import { normalizeDeadline, resolveDeadline, type Category } from "../types/transaction";

type AddCategory = Category | "inbox";

const TITLE_TEXT: Record<AddCategory, string> = {
  next_action: "新增 Next Action 事务",
  project: "新增 Project 事务",
  waiting: "新增 Waiting 事务",
  someday: "新增 Someday 事务",
  habit: "新增习惯",
  inbox: "新增 Inbox 记录",
};

export default function AddModal({
  category,
  onClose,
}: {
  category: AddCategory;
  onClose: () => void;
}) {
  const { createTx } = useTxStore();
  const isInbox = category === "inbox";

  function handleCreate(v: TxFormValues) {
    // 0.1.16 + 1.0.2：日期检测 + 相对类型把锚点日期写入 deadline_date
    const norm = normalizeDeadline(
      isInbox ? "none" : v.deadlineType,
      isInbox ? null : v.deadlineType === "date" ? (v.deadlineDate || null) : null,
    );
    const dl = resolveDeadline(norm.type, norm.date);
    createTx({
      title: v.title,
      note: v.note || undefined,
      category: isInbox ? null : (category as Category),
      status: isInbox ? "inbox" : "active",
      priority: v.priority,
      deadline_type: dl.type,
      deadline_date: dl.date,
      reminder_time: isInbox ? null : (v.reminderTime || null),
    });
    onClose();
  }

  return (
    <Modal title={TITLE_TEXT[category]} onClose={onClose}>
      <TransactionForm
        initial={{
          title: "",
          note: "",
          // inbox 时类型选择不显示，category 仅作占位（保存逻辑按 props 处理）
          category: isInbox ? "next_action" : (category as Category),
          priority: 1,
          deadlineType: "none",
          deadlineDate: "",
          reminderTime: "",
        }}
        inbox={isInbox}
        showCategory={false}
        habit={category === "habit"}
        submitLabel="新增"
        onCancel={onClose}
        onSubmit={handleCreate}
      />
    </Modal>
  );
}
