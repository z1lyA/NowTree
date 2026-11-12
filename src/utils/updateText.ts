// 1.1.7：检查更新的纯文本工具。
// 独立成文件的原因：services/updateCheck.ts 会静态 import updater 插件，
// 那些模块需要 Tauri 运行时；而这里的函数是纯字符串处理，可以在 node 环境的 vitest 里直接测。

// 发布说明最多显示几行。弹窗里塞整篇 CHANGELOG 反而没人读，剩下的引导去发布页看。
export const NOTES_MAX_LINES = 8;

// 发布说明截断：最多显示 maxLines 行，被截断时最后一行是省略号。
// 「最多 maxLines 行」是总行数——省略号也占一行。把省略号追加在 maxLines 行正文之后
// 会渲染出 maxLines+1 行，弹窗高度跟着抖一下，和常量名也对不上。
export function clampNotes(notes: string, maxLines = NOTES_MAX_LINES): string {
  const lines = notes.replace(/\r\n/g, "\n").trimEnd().split("\n");
  if (lines.length <= maxLines) return lines.join("\n");
  return lines.slice(0, maxLines - 1).join("\n") + "\n…";
}

// RFC 3339（如 2026-11-10T12:34:56Z）→ 2026-11-10。
// 直接截字符串而不走 Date，是为了不引入时区换算：发版日期差一天比格式花哨更难解释。
export function formatReleaseDate(iso?: string): string {
  if (!iso) return "";
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : "";
}

// 统一把 catch 到的 unknown 变成可展示文本。放在这里是因为检查更新（service）
// 与下载安装（原本在组件里）两处都要用，各写一份必然会有一处漏掉非 Error 的分支。
export function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// 把插件 / 网络层抛出的英文错误翻成「用户看完知道下一步做什么」的中文。
// 判断顺序有讲究：证书类必须排在签名之前。代理 / 中间人导致的
// "certificate verification failed" 也含 verification，若先命中签名分支，
// 就会把「网络被拦」说成「安装包被篡改」，比原错误更吓人、还会误导用户去怀疑官方包。
export function describeUpdateError(raw: string): string {
  const s = raw.toLowerCase();

  if (/certificate|tls|ssl/.test(s)) {
    return "连不上 GitHub（TLS 证书校验没通过）。检查网络，或确认代理对 NowTree 生效——浏览器能打开 GitHub，不代表它也走同一条代理。";
  }
  if (/signature|pubkey|public key|verify|verification/.test(s)) {
    return "更新包签名校验没通过，已拒绝安装。通常是 latest.json 里的 signature 和实际安装包对不上。";
  }
  if (/timed? ?out|timeout|deadline/.test(s)) {
    return "连接 GitHub 超时了。检查网络，或确认代理对 NowTree 生效——浏览器能打开 GitHub，不代表它也走同一条代理。";
  }
  if (/404|not found|could not fetch|failed to fetch|no release/.test(s)) {
    return "没拿到更新信息（找不到 latest.json）。如果刚发版，可能是附件还没上传完。";
  }
  if (/dns|connect|network|unreachable|request|tls|ssl|certificate/.test(s)) {
    return "连不上 GitHub。检查网络，或确认代理对 NowTree 生效——浏览器能打开 GitHub，不代表它也走同一条代理。";
  }
  return `检查更新失败：${raw}`;
}
