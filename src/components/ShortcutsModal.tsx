// 0.1.13：快捷键说明弹窗（从左侧 ☰ 菜单进入）。
import Modal from "./common/Modal";

interface ShortcutsModalProps {
  onClose: () => void;
}

// 快捷键清单：key 显示名 + desc 说明
const SHORTCUTS: { key: string; desc: string }[] = [
  { key: "1", desc: "切换到 Inbox 视图" },
  { key: "2", desc: "切换到 Next Actions 视图" },
  { key: "3", desc: "切换到 Projects 视图" },
  { key: "4", desc: "切换到 Waiting for 视图" },
  { key: "5", desc: "切换到 Someday 视图" },
  { key: "6", desc: "切换到 Habits 视图" },
  { key: "Enter", desc: "快速新增 / 快速保存" },
  { key: "Esc", desc: "关闭当前窗口" },
];

export default function ShortcutsModal({ onClose }: ShortcutsModalProps) {
  return (
    <Modal title="快捷键" onClose={onClose}>
      <p className="muted shortcut-tip">
        以下快捷键在「未聚焦输入框 / 文本域」时生效；弹窗打开时数字切换会被屏蔽，仅 Esc 可用。
      </p>
      <table className="shortcut-table">
        <tbody>
          {SHORTCUTS.map((s) => (
            <tr key={s.key}>
              <td className="shortcut-key">
                <kbd className="kbd">{s.key}</kbd>
              </td>
              <td className="shortcut-desc muted">{s.desc}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Modal>
  );
}
