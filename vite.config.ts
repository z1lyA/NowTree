import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Tauri 期望固定端口，并在 dev 时关闭清屏、忽略 src-tauri 变更
export default defineConfig({
  plugins: [react()],
  // 0.2.0：允许把 .wav 当静态资源 import（勾选提示音素材）
  assetsInclude: ["**/*.wav"],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: { ignored: ["**/src-tauri/**"] },
  },
  // Tauri 使用原生 webview，关闭来源映射以便生产构建
  build: {
    target: "es2021",
    minify: "esbuild",
    sourcemap: false,
    // 1.1.5：双入口——主窗口 index.html + 右下角提醒窗口 reminder.html。
    // 相对路径即相对 Vite root（项目根），ESM 配置里不依赖 __dirname。
    rollupOptions: {
      input: {
        main: "index.html",
        reminder: "reminder.html",
      },
    },
  },
});
