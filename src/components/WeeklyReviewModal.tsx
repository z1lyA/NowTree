// 1.1.5：Inbox 每周回顾提醒的设置子弹窗（仿 SlotBoundsModal：草稿 + 保存才落盘）。
// 入口在「设置 → Inbox 每周回顾」；默认启用、每周日，可在周一–周日之间任选。
import { useState } from "react";
import Modal from "./common/Modal";
import {
  REVIEW_END_HOUR,
  REVIEW_START_HOUR,
  WEEKDAY_LABELS,
  getWeeklyReview,
  resetWeeklyReview,
  setWeeklyReview,
  weekdayLabel,
  type WeeklyReviewSetting,
} from "../utils/weeklyReview";
import { pushReminderCards, weeklyReviewCard } from "../services/reminders";
import { showToast } from "../toast";

interface WeeklyReviewModalProps {
  inboxCount: number;
  onClose: () => void;
  // 保存 / 恢复默认后通知外层刷新「当前设置」文案
  onSaved: () => void;
}

// 展示顺序：周一 → 周日（存储仍用 JS getDay()：0=周日）。
const WEEKDAY_ORDER = [1, 2, 3, 4, 5, 6, 0];

export default function WeeklyReviewModal({
  inboxCount,
  onClose,
  onSaved,
}: WeeklyReviewModalProps) {
  const [draft, setDraft] = useState<WeeklyReviewSetting>(getWeeklyReview());

  function save() {
    setWeeklyReview(draft);
    onSaved();
    onClose();
  }

  function restore() {
    resetWeeklyReview();
    onSaved();
    onClose();
  }

  function preview() {
    // 用真实 Inbox 数量弹一张卡，方便立刻确认卡片样式与内容。
    void pushReminderCards([weeklyReviewCard(inboxCount)]);
    showToast(
      inboxCount > 0
        ? `已弹出预览（Inbox ${inboxCount} 条）`
        : "已弹出预览（Inbox 目前为空）",
    );
  }

  return (
    <Modal title="Inbox 每周回顾" onClose={onClose}>
      <p className="muted shortcut-tip">
        每周挑一天提醒你：Inbox 里的灵感该整理成下一步了。只有 Inbox
        非空时才提醒，同一天最多一次。
      </p>

      <div className="settings-list">
        <button
          type="button"
          className="settings-row"
          onClick={() => setDraft((d) => ({ ...d, enabled: !d.enabled }))}
        >
          <span className="settings-row-text">
            <span className="settings-row-label">启用每周回顾提醒</span>
            <span className="settings-row-hint muted">
              关闭后不再自动提醒，仍可随时点「试一下」预览
            </span>
          </span>
          <span className={"switch" + (draft.enabled ? " on" : "")} aria-hidden="true" />
        </button>
      </div>

      <p className="review-weekday-label">提醒日（周一到周日任选）</p>
      <div className="weekday-picker">
        {WEEKDAY_ORDER.map((w) => (
          <button
            key={w}
            type="button"
            className={"weekday-btn" + (draft.weekday === w ? " active" : "")}
            onClick={() => setDraft((d) => ({ ...d, weekday: w }))}
          >
            {WEEKDAY_LABELS[w]}
          </button>
        ))}
      </div>

      <p className="muted review-hint">
        当前设置：每周{weekdayLabel(draft.weekday).slice(1)}，
        {REVIEW_START_HOUR}:00–{REVIEW_END_HOUR}:00 之间首次检测到时，
        在屏幕右下角弹出提醒卡。
      </p>

      <div className="modal-actions">
        <button type="button" className="btn-secondary" onClick={restore}>
          恢复默认（周日）
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
