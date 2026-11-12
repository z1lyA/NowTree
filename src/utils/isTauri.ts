// 环境检测：是否跑在 Tauri 真机（WebView2 + IPC）里，而不是浏览器预览 / vitest。
//
// 独立成文件的原因：data 与 services 里原本各自抄了一份同样的判据，而它们必须一致——
// 判断错的表现分别是「真机退化成内存仓库（列表看起来是空的）」和「提醒窗口静默不投递」，
// 两种症状都离「环境判断写错了」很远，排查时很难联想过去。收成一处，只可能错一次。
export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}
