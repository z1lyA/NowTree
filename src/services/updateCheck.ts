// 1.1.7：检查更新（tauri-plugin-updater）。
// 分层约定：插件调用与错误翻译收口在这里，App / 组件只负责状态机与展示。
// 更新源是 GitHub Release 上的静态 latest.json（地址与 pubkey 见 src-tauri/tauri.conf.json）；
// 安装包由私钥签名、运行时用内置 pubkey 校验，校验不通过插件会直接抛错，前端拿不到"可以装"的假象。
import { check, type Update } from "@tauri-apps/plugin-updater";
import { getVersion } from "@tauri-apps/api/app";
import { openUrl } from "@tauri-apps/plugin-opener";
import { describeUpdateError } from "../utils/updateText";

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

export type CheckUpdateResult =
  // 浏览器预览 / vitest：没有 updater 后端，直接说不支持，别报错吓人
  | { kind: "unsupported" }
  | { kind: "latest"; currentVersion: string }
  | { kind: "available"; info: UpdateInfo; update: Update }
  | { kind: "failed"; message: string };

// 与 data/index.ts 同一个判据：只有真机（Tauri）才有 IPC 内部对象。
function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

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
      update,
      info: {
        version: update.version,
        currentVersion: update.currentVersion,
        notes: update.body ?? "",
        date: update.date,
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
