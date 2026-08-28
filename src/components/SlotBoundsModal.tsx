// 时段分界线设置弹窗（1.1.2 新增）。
// 让用户自定义 早 / 午 / 晚 的起点小时（仅小时粒度），实时写入 localStorage，改完立即生效。
// 边界约束：0 < 早起点 < 午起点 < 晚起点 <= 24；休息段 = 00:00 至 早起点（自动跟随）。
import { useState } from "react";
import Modal from "./common/Modal";
import {
  DEFAULT_SLOT_BOUNDS,
  getSlotBounds,
  isValidBounds,
  resetSlotBounds,
  setSlotBounds,
  type SlotBounds,
} from "../utils/slotBounds";

interface SlotBoundsModalProps {
  onClose: () => void;
}

// 各起点可选小时范围：保证三者总能凑出合法组合（留足后续时段的余量）。
const MORNING_OPTIONS = range(1, 22);
const NOON_OPTIONS = range(2, 23);
const EVENING_OPTIONS = range(3, 24);

function range(a: number, b: number): number[] {
  const out: number[] = [];
  for (let i = a; i <= b; i++) out.push(i);
  return out;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

export default function SlotBoundsModal({ onClose }: SlotBoundsModalProps) {
  const initial = getSlotBounds();
  // 用 useState 持有草稿；保存时才落盘，支持临时修改与取消。
  const [draft, setDraft] = useState<SlotBounds>({ ...initial });

  const valid = isValidBounds(draft);
  const preview = valid
    ? `休息 00:00–${pad(draft.morningStart)} ｜ 早 ${pad(draft.morningStart)}–${pad(
        draft.noonStart,
      )} ｜ 午 ${pad(draft.noonStart)}–${pad(draft.eveningStart)} ｜ 晚 ${pad(
        draft.eveningStart,
      )}–24:00`
    : "请保证 早 < 午 < 晚（均在 1–24 之间）";

  function save() {
    if (!valid) return;
    setSlotBounds(draft);
    onClose();
  }

  function restore() {
    // 恢复默认：立即落盘并关闭（默认必合法）。
    resetSlotBounds();
    onClose();
  }

  return (
    <Modal title="时段分界线" onClose={onClose}>
      <p className="muted shortcut-tip">
        自定义「早 / 午 / 晚」各自的起点小时（仅小时粒度）。改动即时生效，无需重启。
        休息时段 = 00:00 至「早」起点，自动跟随。
      </p>

      <div className="slot-bounds-form">
        <Row
          label="早起点"
          value={draft.morningStart}
          options={MORNING_OPTIONS}
          onChange={(v) => setDraft((d) => ({ ...d, morningStart: v }))}
        />
        <Row
          label="午起点"
          value={draft.noonStart}
          options={NOON_OPTIONS}
          onChange={(v) => setDraft((d) => ({ ...d, noonStart: v }))}
        />
        <Row
          label="晚起点"
          value={draft.eveningStart}
          options={EVENING_OPTIONS}
          onChange={(v) => setDraft((d) => ({ ...d, eveningStart: v }))}
        />
      </div>

      <p className={"slot-bounds-preview" + (valid ? "" : " error-text")}>{preview}</p>

      <div className="modal-actions">
        <button type="button" className="btn-secondary" onClick={restore}>
          恢复默认（{DEFAULT_SLOT_BOUNDS.morningStart} / {DEFAULT_SLOT_BOUNDS.noonStart} /{" "}
          {DEFAULT_SLOT_BOUNDS.eveningStart}）
        </button>
        <div className="modal-actions-right">
          <button type="button" className="btn-ghost" onClick={onClose}>
            取消
          </button>
          <button type="button" className="btn-primary" onClick={save} disabled={!valid}>
            保存
          </button>
        </div>
      </div>
    </Modal>
  );
}

interface RowProps {
  label: string;
  value: number;
  options: number[];
  onChange: (v: number) => void;
}

function Row({ label, value, options, onChange }: RowProps) {
  return (
    <div className="slot-bounds-item">
      <span className="slot-bounds-item-label">{label}</span>
      <select
        className="slot-bounds-select"
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      >
        {options.map((o) => (
          <option key={o} value={o}>
            {pad(o)}:00
          </option>
        ))}
      </select>
    </div>
  );
}
