// 回收站弹窗：列出已软删除的事务，可「恢复」回到原列表，或「彻底删除」从库物理移除。
// 「清空回收站」一次性彻底删除全部软删记录，释放磁盘空间（不可恢复）。
// 0.1.11：列表改为内部子面板滚动，标题与操作按钮始终固定可见。
import { useEffect, useState } from "react";
import Modal from "./common/Modal";
import { useTxStore } from "../store/useTxStore";
import { CATEGORY_LABELS, STATUS_LABELS } from "../types/transaction";
import { canRestoreChild } from "../services/transactionService";
import { showToast } from "../toast";

interface TrashModalProps {
  onClose: () => void;
}

export default function TrashModal({ onClose }: TrashModalProps) {
  const { trash, loadTrash, restoreTx, purgeTx, emptyTrash, active } = useTxStore();
  const [confirmEmpty, setConfirmEmpty] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    loadTrash();
  }, [loadTrash]);

  async function onRestore(id: number) {
    try {
      setErr(null);
      const t = trash.find((x) => x.id === id);
      // A（1.1.3）：Project 子事务若所属父事务不在当前列表（已删 / 已不再是 Project），
      // 单独恢复会变成孤儿（子事务只在 Project 视图渲染），先拦截。
      if (t && !canRestoreChild(t, active)) {
        showToast("子事务无法单独恢复：其所属的 Project 父事务不在当前列表（可能已删除或已不再是 Project）");
        return;
      }
      await restoreTx(id);
    } catch (e) {
      setErr("恢复失败：" + ((e as any)?.message ?? String(e)));
    }
  }
  async function onPurge(id: number) {
    try {
      setErr(null);
      await purgeTx(id);
    } catch (e) {
      setErr("删除失败：" + ((e as any)?.message ?? String(e)));
    }
  }
  async function onEmpty() {
    if (!confirmEmpty) {
      setConfirmEmpty(true);
      return;
    }
    setErr(null);
    try {
      await emptyTrash();
      setConfirmEmpty(false);
    } catch (e) {
      // 把后端真实报错暴露出来，便于定位（如仍失败可看到原因）
      setErr("清空失败：" + ((e as any)?.message ?? String(e)));
    }
  }

  return (
    <Modal title="回收站" onClose={onClose}>
      <p className="muted" style={{ marginTop: 0 }}>
        这里是被删除的事务。可「恢复」回到原列表；「彻底删除」将从本地数据库永久移除、不可恢复。
      </p>

      {trash.length === 0 && (
        <div className="empty">回收站是空的。</div>
      )}

      {trash.length > 0 && (
        <div className="modal-panel sub-panel">
          <ul className="tx-list trash-list">
            {trash.map((t) => (
              <li key={t.id} className="tx-item">
                <div className="tx-main">
                  <div className="tx-line">
                    <span className="tx-title">{t.title}</span>
                  </div>
                  <div className="trash-meta muted">
                    {t.parent_id != null
                      ? "Project 子事务"
                      : t.category
                        ? CATEGORY_LABELS[t.category]
                        : "未整理(Inbox)"}
                    {" · "}
                    {STATUS_LABELS[t.status]}
                    {t.note ? ` · ${t.note}` : ""}
                  </div>
                </div>
                <div className="tx-actions">
                  <button className="btn-ghost" onClick={() => onRestore(t.id)}>
                    恢复
                  </button>
                  <button className="btn-danger" onClick={() => onPurge(t.id)}>
                    彻底删除
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="modal-actions">
        {err && (
          <div className="error-text" style={{ marginRight: "auto", color: "#e5484d" }}>
            {err}
          </div>
        )}
        <button className="btn-ghost" onClick={onClose}>
          关闭
        </button>
        <button
          className={`btn-danger ${confirmEmpty ? "on" : ""}`}
          onClick={onEmpty}
          disabled={trash.length === 0}
          title={trash.length === 0 ? "回收站为空，无需清空" : undefined}
        >
          {confirmEmpty ? "确认清空？" : "清空回收站"}
        </button>
      </div>
    </Modal>
  );
}
