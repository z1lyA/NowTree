// 1.1.7：发现新版本弹窗。
// 只做三件事：说清「旧版本 → 新版本」、可选「下载并安装」（带进度）、随时能退到「打开发布页」。
// 安装走 tauri-plugin-updater：下载完会校验签名，再交给 Windows 安装器；
// 安装器默认 restartAfterInstall=true，会先退出本应用、装完自动重启，所以这里不需要 relaunch()。
// 1.1.8：下载 / 安装的插件调用挪到 services/updateCheck.ts#installUpdate——本组件只留「怎么显示」，
// 插件的事件形状（Started / Progress / Finished）不再泄漏到这一层。
import { useState } from "react";
import Modal from "./common/Modal";
import type { AvailableUpdate } from "../services/updateCheck";
import { installUpdate, openReleasesPage } from "../services/updateCheck";
import { clampNotes, errorText, formatReleaseDate } from "../utils/updateText";

type Phase = "idle" | "downloading" | "installing" | "failed";

interface UpdateModalProps {
  available: AvailableUpdate;
  onClose: () => void;
}

export default function UpdateModal({ available, onClose }: UpdateModalProps) {
  const { update, info } = available;
  const [phase, setPhase] = useState<Phase>("idle");
  // 下载进度用「已下载 / 总字节」两份数字存，百分比由它派生——
  // 避免「字节数」和「百分比」两份状态互相追不上。
  const [progress, setProgress] = useState({ got: 0, total: 0 });
  const [err, setErr] = useState("");

  const released = formatReleaseDate(info.date);
  const busy = phase === "downloading" || phase === "installing";
  const percent =
    progress.total > 0
      ? Math.min(100, Math.round((progress.got / progress.total) * 100))
      : 0;

  // 关闭即放弃安装。必须显式 close()，否则 Rust 侧持有的 Update 资源不会释放。
  function close() {
    if (busy) return; // 安装过程不可中断，避免装到一半
    void update.close().catch(() => {});
    onClose();
  }

  async function startInstall() {
    setPhase("downloading");
    setProgress({ got: 0, total: 0 });
    setErr("");
    try {
      await installUpdate(update, {
        onProgress: (got, total) => setProgress({ got, total }),
        onInstalling: () => setPhase("installing"),
      });
      // Windows 下应用会在安装器启动时被退出，正常走不到这里；
      // 真走到了说明安装器已跑起来，保持「正在安装」，别让用户以为卡住。
      setPhase("installing");
    } catch (e) {
      setPhase("failed");
      setErr(errorText(e)); // installUpdate 抛出的已经是中文文案，不再二次翻译
    }
  }

  return (
    <Modal title="发现新版本" onClose={close} closeOnEsc={!busy}>
      <p className="muted" style={{ marginTop: 0 }}>
        NowTree 有新版本可用：
        <strong> v{info.currentVersion}</strong> → <strong>v{info.version}</strong>
        {released ? `（发布于 ${released}）` : ""}
      </p>

      {info.notes.trim() !== "" && (
        <div className="modal-panel sub-panel">
          <pre className="update-notes">{clampNotes(info.notes)}</pre>
        </div>
      )}

      {phase === "downloading" && (
        <div className="update-progress">
          <div className="update-progress-bar">
            <i style={{ width: `${percent}%` }} />
          </div>
          <span className="muted">{progress.total > 0 ? `${percent}%` : "下载中…"}</span>
        </div>
      )}

      {phase === "installing" && (
        <p className="muted">
          正在安装。NowTree 会先自动关闭、装完再自己启动——请不要手动关窗口。
        </p>
      )}

      {phase === "failed" && <p className="error">{err}</p>}

      <div className="modal-actions">
        <button
          className="btn-ghost"
          type="button"
          onClick={() => void openReleasesPage()}
        >
          打开发布页
        </button>
        <button className="btn-ghost" type="button" onClick={close} disabled={busy}>
          以后再说
        </button>
        <button
          className="btn-primary"
          type="button"
          onClick={startInstall}
          disabled={busy}
          title="下载安装包，校验签名后自动安装"
        >
          {busy ? "处理中…" : "下载并安装"}
        </button>
      </div>
    </Modal>
  );
}
