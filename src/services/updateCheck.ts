// 1.1.7：检查更新（tauri-plugin-updater）。
// 分层约定：插件调用与错误翻译收口在这里，App / 组件只负责状态机与展示。
// 更新源是 GitHub Release 上的静态 latest.json（地址与 pubkey 见 src-tauri/tauri.conf.json）；
// 安装包由私钥签名、运行时用内置 pubkey 校验，校验不通过插件会直接抛错，前端拿不到"可以装"的假象。
import { check, type Update } from "@tauri-apps/plugin-updater";
import { getVersion } from "@tauri-apps/api/app";
import { openUrl } from "@tauri-apps/plugin-opener";
import { describeUpdateError, errorText } from "../utils/updateText";
import { isTauri } from "../utils/isTauri";

// 8 秒超时。不设上限的话，GitHub 在部分网络下会长时间无响应，用户会以为软件卡死。
export const UPDATE_TIMEOUT_MS = 8000;

// 兜底入口：检查更新失败时，让用户自己去发布页看。
export const RELEASES_PAGE = "https://github.com/z1lyA/NowTree/releases/latest";

export type UpdateInfo = {
  version: string;
  currentVersion: string;
  notes: string;
  date?: string;
};

// 「可以装的新版本」= 插件句柄 + 展示用信息。两者永远成对出现（拿到句柄才有 info），
// 所以收成一个类型：App 的状态与 UpdateModal 的 props 都用它，不必到处写两个字段。
export type AvailableUpdate = {
  update: Update;
  info: UpdateInfo;
};

export type CheckUpdateResult =
  // 浏览器预览 / vitest：没有 updater 后端，直接说不支持，别报错吓人
  | { kind: "unsupported" }
  | { kind: "latest"; currentVersion: string }
  | { kind: "available"; available: AvailableUpdate }
  | { kind: "failed"; message: string };

/** 当前运行版本；非 Tauri 环境返回 null。 */
export async function getCurrentVersion(): Promise<string | null> {
  if (!isTauri()) return null;
  try {
    return await getVersion();
  } catch {
    return null;
  }
}

/**
 * 检查是否有新版本。
 * 注意：返回 available 时，调用方要么 install、要么调 update.close()，否则 Rust 侧资源会一直挂着。
 */
export async function checkForUpdate(): Promise<CheckUpdateResult> {
  if (!isTauri()) return { kind: "unsupported" };

  try {
    const update = await check({ timeout: UPDATE_TIMEOUT_MS });
    // 插件用 SemVer 比较：当前版本 >= 远端版本时返回 null。
    if (!update) {
      return { kind: "latest", currentVersion: (await getCurrentVersion()) ?? "当前版本" };
    }
    return {
      kind: "available",
      available: {
        update,
        info: {
          version: update.version,
          currentVersion: update.currentVersion,
          notes: update.body ?? "",
          date: update.date,
        },
      },
    };
  } catch (e) {
    return { kind: "failed", message: describeUpdateError(errorText(e)) };
  }
}

/** 用系统默认浏览器打开发布页。opener:default 权限已包含 https 外链。 */
export async function openReleasesPage(): Promise<void> {
  await openUrl(RELEASES_PAGE);
}

// 安装过程的两个观察点：进度（已下载 / 总字节）与「进入安装阶段」。
// 组件只关心这两件事，不该知道 DownloadEvent 的形状。
export type InstallHooks = {
  onProgress?: (got: number, total: number) => void;
  onInstalling?: () => void;
};

/**
 * 下载并安装：把插件的 DownloadEvent 归一成两个回调，失败时抛已经翻成中文的错误。
 * 为什么放在 service 而不是组件里：它属于「插件调用」，与「怎么画进度条」是两件事；
 * 组件只该决定显示方式，插件 API 变了也只改这里。
 *
 * 注意：Windows 下安装器启动时本应用会被退出，正常走不到函数末尾。
 */
export async function installUpdate(update: Update, hooks: InstallHooks = {}): Promise<void> {
  let got = 0;
  let total = 0;
  try {
    await update.downloadAndInstall((event) => {
      if (event.event === "Started") {
        total = event.data.contentLength ?? 0;
        hooks.onProgress?.(0, total);
      } else if (event.event === "Progress") {
        // 回调是高频的：累计字节数在闭包里加，别每帧从头算。
        got += event.data.chunkLength;
        hooks.onProgress?.(got, total);
      } else {
        hooks.onInstalling?.(); // Finished：下载结束，接下来交给安装器
      }
    });
    hooks.onInstalling?.();
  } catch (e) {
    // 这里翻译掉，调用方拿到的 message 已经可以直接展示，避免二次翻译口径漂移。
    throw new Error(describeUpdateError(errorText(e)));
  }
}
