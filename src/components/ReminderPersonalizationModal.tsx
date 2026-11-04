// 1.1.5：弹窗个性化（设置 → 弹窗个性化）。
//
// 可配置：是否允许弹窗通知 / 屏幕四角位置 / 宽度 / 是否显示每日摘要 / 「稍后」时长。
// 改动保存到 localStorage（utils/reminderPrefs.ts）；位置与宽度在下一次弹窗投递时生效。
import { useState } from "react";
import Modal from "./common/Modal";
import { pushReminderCards, reminderPreviewCard } from "../services/reminders";
import { showToast } from "../toast";
import {
  CORNER_LABELS,
  CORNER_OPTIONS,
  REMINDER_WIDTH_OPTIONS,
  SNOOZE_OPTIONS,
  getReminderPrefs,
  resetReminderPrefs,
  setReminderPrefs,
  type ReminderPrefs,
} from "../utils/reminderPrefs";

interface ReminderPersonalizationModalProps {
  onClose: () => void;
  // 保存后通知设置窗口刷新入口行摘要
  onSaved: () => void;
}

function widthLabel(w: number): string {
  if (w <= 340) return "窄";
  if (w >= 420) return "宽";
  return "标准";
}

export default function ReminderPersonalizationModal({
  onClose,
  onSaved,
}: ReminderPersonalizationModalProps) {
  const [draft, setDraft] = useState<ReminderPrefs>(getReminderPrefs());

  function save() {
    setReminderPrefs(draft);
    onSaved();
    onClose();
  }

  function restore() {
    resetReminderPrefs();
    onSaved();
    onClose();
  }

  // 用当前草稿（而不是已保存值）预览位置 / 宽度：弹出一张「测试事务」实验卡，
  // 卡上只有「关闭」，不会写入任何事务。方便立刻确认样式、四角位置与宽度。
  function preview() {
    void pushReminderCards([reminderPreviewCard()], draft).then(
      (delivered) =>
        showToast(
          delivered
            ? "已按当前设置弹出实验卡"
            : "预览被跳过：弹窗通知已关闭",
        ),
      (e) => showToast("弹窗创建失败：" + ((e as Error)?.message ?? String(e))),
    );
  }

  return (
    <Modal title="弹窗个性化" onClose={onClose}>
      <p className="muted shortcut-tip">
        控制提醒弹窗的开关、位置、宽度与「稍后」时长；改完保存后，下一次弹窗生效。
        点「预览」会按当前草稿弹出一张「测试事务」实验卡（只有关闭按钮）。
      </p>

      <div className="settings-list">
        <button
          type="button"
          className="settings-row"
          onClick={() => setDraft((d) => ({ ...d, enabled: !d.enabled }))}
        >
          <span className="settings-row-text">
            <span className="settings-row-label">允许弹窗通知</span>
            <span className="settings-row-hint muted">
              关闭后事务提醒 / 每周回顾 / 每日摘要都不弹窗（事务提醒仍按时间正常消费）
            </span>
          </span>
          <span className={"switch" + (draft.enabled ? " on" : "")} aria-hidden="true" />
        </button>

        <button
          type="button"
          className="settings-row"
          onClick={() => setDraft((d) => ({ ...d, showDailyDigest: !d.showDailyDigest }))}
        >
          <span className="settings-row-text">
            <span className="settings-row-label">显示每日摘要卡</span>
            <span className="settings-row-hint muted">
              启动与跨时段时推送「今日」摘要；关闭后仍可在设置里手动预览
            </span>
          </span>
          <span
            className={"switch" + (draft.showDailyDigest ? " on" : "")}
            aria-hidden="true"
          />
        </button>
      </div>

      <p className="review-weekday-label">弹出位置</p>
      <div className="corner-picker">
        {CORNER_OPTIONS.map((corner) => (
          <button
            key={corner}
            type="button"
            className={"corner-btn" + (draft.corner === corner ? " active" : "")}
            onClick={() => setDraft((d) => ({ ...d, corner }))}
          >
            <span className={`corner-dot corner-dot--${corner}`} aria-hidden="true" />
            {CORNER_LABELS[corner]}
          </button>
        ))}
      </div>

      <p className="review-weekday-label">弹窗宽度</p>
      <div className="seg-group">
        {REMINDER_WIDTH_OPTIONS.map((w) => (
          <button
            key={w}
            type="button"
            className={"seg-btn" + (draft.width === w ? " active" : "")}
            onClick={() => setDraft((d) => ({ ...d, width: w }))}
          >
            {widthLabel(w)}（{w}px）
          </button>
        ))}
      </div>

      <p className="review-weekday-label">「稍后」时长</p>
      <div className="seg-group">
        {SNOOZE_OPTIONS.map((m) => (
          <button
            key={m}
            type="button"
            className={"seg-btn" + (draft.snoozeMinutes === m ? " active" : "")}
            onClick={() => setDraft((d) => ({ ...d, snoozeMinutes: m }))}
          >
            {m} 分钟
          </button>
        ))}
      </div>

      <div className="modal-actions">
        <button type="button" className="btn-secondary" onClick={restore}>
          恢复默认
        </button>
        <div className="modal-actions-right">
          <button type="button" className="btn-ghost" onClick={preview}>
            预览
          </button>
          <button type="button" className="btn-ghost" onClick={onClose}>
            取消
          </button>
          <button type="button" className="btn-primary" onClick={save}>
            保存
          </button>
        </div>
      </div>
    </Modal>
  );
}
