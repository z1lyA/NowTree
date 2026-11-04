# NowTree 架构说明

本文面向想读懂代码 / 参与开发的人，描述 NowTree 的整体结构、数据模型与关键流程。面向用户的入门请看根目录 [README.md](../README.md)。

---

## 1. 总体架构

NowTree 是一个 **Tauri v2 桌面应用**：Rust 负责系统能力与本地数据库，前端（React）跑在 WebView2 里负责界面，两者通过 Tauri 命令（IPC）通信。

```
┌────────────────────────────────────────────┐
│  React 前端（WebView2）                    │
│  src/components/*  src/store/*  src/hooks/*│
│  src/data/TauriTransactionRepository       │
│           │  invoke("command", args)       │
└────────────┬───────────────────────────────┘
            │ Tauri IPC
┌────────────▼─────────────────────────┐
│  Rust 后端（src-tauri）               │
│  commands.rs  ← 数据 / 托盘 / 窗口命令  │
│  reminder.rs  ← 右下角提醒窗口（1.1.5） │
│  db.rs        ← SQLite 连接 / 建表    │
│  lib.rs       ← 入口、托盘、插件注册   │
│           ▼                          │
│  SQLite（本机 AppData/nowtree.sqlite）│
└──────────────────────────────────────┘
```

**关键不变量**：前端不直接碰 SQLite，所有读写都经 `commands.rs` 暴露的 Tauri 命令；命令里统一持有 `Mutex<Connection>`，打开即设 `PRAGMA busy_timeout = 3000`，避免 dev 与 release 指向同一 DB 时的并发写锁。

---

## 2. 分层（前端）

| 目录 | 职责 |
|---|---|
| `src/components/` | 视图与弹窗（InboxView / NextView / ProjectListView / TrashModal / DataModal / SettingsModal …） |
| `src/store/useTxStore.ts` | Zustand 全局状态：持有 active / inbox / trash 三份列表，封装增删改查调用 |
| `src/services/transactionService.ts` | 纯业务逻辑（类别迁移规则、`canNext`、来源文案），UI 只调不写规则 |
| `src/services/reminders.ts` · `reminderCards.ts` · `dailyDigest.ts` | 1.1.5：提醒投递 seam（卡片交给 Rust）、卡片队列去重 / 移除、每日摘要卡组装 |
| `src/hooks/` | 可复用交互原语：`useListDrag`（指针拖拽）、`useSelection`（多选）、`useLifecycle`（提醒轮询）、`useWeeklyReview`（每周回顾）、`useDailyDigest`（每日摘要） |
| `src/reminder/` | 1.1.5：右下角提醒窗口的 React 入口（`reminder.html` 加载），渲染 task / review / daily 三种卡片 |
| `src/data/` | **数据访问抽象**：`TransactionRepository` 接口 + `TauriTransactionRepository`（真机）与 `MemoryTransactionRepository`（浏览器 / 测试）。`isTauri()` 检测运行环境决定用哪个 |
| `src/types/transaction.ts` | `Transaction` 类型与 `Category` / `Status` / `DeadlineType` 等枚举 |

**为什么要 Repository 抽象**：把"数据从哪来"与 UI 解耦。将来做云同步 / 手机端，只需新增一个实现 `TransactionRepository` 的"云仓库"，UI 与业务逻辑零改动。

---

## 3. 数据模型（核心）

所有事务是**统一的一张表 `transactions`**，通过字段区分状态与归属：

| 字段 | 含义 |
|---|---|
| `id` / `sync_id` | 本地自增 id；`sync_id` 为 UUID，为将来云同步预留稳定全局标识 |
| `title` / `note` | 标题 / 备注 |
| `status` | 生命周期：`inbox`（未整理）/ `active`（已整理进行中）/ `completed`（已完成） |
| `category` | 类别：`next_action` / `project` / `waiting` / `someday`（`inbox` 阶段可为空） |
| `deadline_type` / `deadline_date` | 时间要求：`none` / `today` / `week` / `month` / `date`（具体日期） |
| `priority` | 优先级 1–5（5 最急；默认 1，用户有意为之） |
| `parent_id` | 父事务 id；`NULL` 表示顶层。构成「Project → 子事务」的树 |
| `time_slot` | Next 视图的三时段（`**任务级标签**`，手动指定）：`none` / `morning` / `noon` / `evening` |
| `show_in_next` | 0/1：是否透出到全局 Next 列表（默认 0） |
| `deleted` | 软删除标志（0/1）；回收站即 `deleted=1` 的记录 |
| `deleted_at` | 软删时间戳 |
| `order_index` | 同层排序序号（拖拽持久化） |
| `reminder_time` / `reminder_done` | 提醒时间 / 是否已提醒 |
| `created_time` / `completed_time` / `updated_time` | 时间戳 |

> **时段分界线（时钟→时段映射）与 `time_slot` 列是两回事**：`time_slot` 是任务上手动打的「计划归属时段」标签；而每日摘要卡按当前钟点过滤所用的 早 / 午 / 晚 / 休息 分界，由 `src/utils/slotBounds.ts` + `clock.ts` 计算，默认值 早6 / 午13 / 晚18，可在「设置 → 时段分界线」里自定义（仅小时粒度、立即生效、存于 localStorage），与数据库结构无关。

### 状态机

```
  ──├▶Inbox                   恢复(deleted=0)：从 Trash 回到 Inbox / Active
  │ │
  │ │         整理转换（原地改写 category/status）
  │ │
  │ ▼
  │ │ Active
  │ │
  │ │         勾选完成
  │ │
  │ ▼
  │ │ Completed
  │ │
  │ │         软删除 (deleted=1)
  │ │
  │ ▼
  ──├ Trash
    │
    │         彻底删除 / 清空（物理 DELETE，不可恢复）
    │
    ▼
      [已删除]
```

### 树与级联规则（回收站）

`parent_id` 构成任意深度的树。删除 / 恢复 / 彻底删除 / 清空都基于递归 CTE，统一「整棵子树」处理，防止孤儿：

- **删除**：从节点向下收集所有后代 → 全部 `deleted=1`。删父 = 整棵进回收站。
- **恢复**：`up` CTE 向上收集「自身 + 所有祖先」→ 全部 `deleted=0`。**恢复子事务会连带把父项目一起拉回**（绝不产生"子回来、父留回收站"的孤儿）。
- **选择性恢复**：恢复父项目时**只回父、不自动拉回子孙**，子孙继续留在回收站，由你自行逐个恢复。
- **彻底删除 / 清空**：向下收集所有后代 → 物理 `DELETE`，不可恢复。

> 结论：靠"恢复"这个动作永远不会造出"子 active、父在回收站"的状态；只有你主动"恢复父、留子在回收站"的选择性恢复会出现，且子是正常待恢复的。

---

## 4. 关键流程

### Inbox → 正式事务（整理转换）

`convertInbox` 命令**原地改写**该记录的 `category` / `status` 等字段（同一条 id，不新建、不重复），保留 `created_time`。这是与"普通 Todo"的根本区别：NowTree 的核心对象是统一的 Transaction，收集与整理是同一记录的两种状态。

### 拖拽排序 / 改类 / 改父

- 基于 **Pointer Events**（非 HTML5 DnD，WebView2 内原生 DnD 会触发"禁止"手势）。封装在 `src/hooks/useListDrag.ts`，`NextView` 与 `useListDrag` 共用底层原语（`dragUtils.ts`）。
- 落点写入 `order_index` 持久化；跨视图拖到左侧导航栏即改 `category`；Project 内拖到父行即改 `parent_id`。
- 自动滚动：拖到列表上下边缘时，滚动容器取**光标当前所在列表**（而非拖拽起点），保证跨栏拖入时右栏能自滚。

### 提醒与每日摘要（1.1.5 重构）

1.1.5 起不再调用 Windows 系统通知，改为 **应用自绘的右下角弹窗窗口**（label = `reminder`，页面 `reminder.html`）：

```
主窗口 React ──invoke("show_reminder_cards", cards, layout)──▶ Rust reminder.rs
                                                         │ 首次：建窗（无边框 / 透明 / 不占任务栏）
                                                         │ 每次：按 layout 贴到所选角落 / 应用宽度
                                                         │ 之后：emit_to("reminder", "nowtree:reminder-push", cards)
                                                         ▼
                                       reminder 窗口 React（src/reminder/）
                                         挂载时 take_reminder_cards() 取走建窗前暂存的卡片
                                         内容变化 → fit_reminder_window() 自适应高度
```

- **三种卡片**（`src/services/reminderCards.ts` 的 `ReminderCard.kind`）：
  - `task`：事务提醒，**一条事务一张卡**（key `task:<id>`），按钮「完成 / 稍后 / 关闭」；
  - `review`：Inbox 每周回顾（key `review:<本地日期>`），按钮「去整理 / 知道了」；
  - `daily`：每日摘要（key `daily:<本地日期>:<slot>`），内容 = 原「今日」启动弹窗的问候 / 日期 / 励志语 / 当前时段清单。
- **个性化与布局**：`src/utils/reminderPrefs.ts` 存 localStorage（是否允许弹窗通知、四角位置、宽度 340/380/420、是否显示每日摘要、稍后时长 5/15/30）。主窗口每次投递都把 `{ corner, width, margin }` 传给 Rust；`margin` 默认 40 逻辑像素（比 1.1.4 更往角落内侧）。Rust 用 `work_area()` 计算四角坐标，宽度在投递时同步到窗口。
- **扫描与状态**：`useTxStore.checkReminders` 每 30 秒（`useLifecycle`）扫描到期事务 → 乐观标记 + 写库 → 一次性把卡片交给 Rust。卡片动作通过既有 `update_transaction` 写库，再广播 `nowtree:data-changed` 让主窗口 `loadActive / loadInbox` 刷新。
- **每日摘要**：`useDailyDigest` 在 `loadActive` 完成后按 `currentClockSlot()`（分界点来自「设置 → 时段分界线」）每 30 秒检查，用 `nowtree_daily_digest_last = <本地日期>:<slot>` 去重（同一时段每天一次）；**标记在卡片投递成功后才写**（失败下一轮重试）。原 `StartupModal` 已删除，卡片即入口；`rest` 时段发「晚安」卡。1.1.5 首次启动会一次性清理早期构建遗留的「已推送」标记（`utils/reminderMarks.ts`）。
- **精确触发**：`useReminderScheduler` 按 `active` 里最早的 `reminder_time` 计算下一次触发时刻，同时 ① 设前端 `setTimeout` 兜底；② `invoke("schedule_reminder_fire", { atMs })` 交给 Rust 后台定时，到点 `emit("nowtree:reminder-due")` → 主窗口立即 `checkReminders`。30 秒 `useReminderScan` 保留为系统休眠 / 事件丢失的兜底；提醒时间变更时按代际号作废旧定时器。
- **每周回顾**：`useWeeklyReview` 按 `nowtree_weekly_review`（默认启用、周日）判定，条件 = 星期匹配 + 当天未提醒 + Inbox 非空 + 09:00–22:00；**投递成功后才写** `nowtree_weekly_review_last`。
- **窗口内交互（纯前端）**：10 秒无操作自动收起（鼠标悬停暂停，收起即清空本次卡片）；多卡默认折叠成「最新 1 张 + N 条提醒」，背后按剩余数量画有景深的堆叠层（逐层更窄 / 更暗 / 带投影，最多 3 层），可展开 / 全部关闭；卡片空白处 `startDragging()` 拖动整个窗口（需要 `core:window:allow-start-dragging`，拖拽不记忆位置）。
- **事件契约**：`nowtree:reminder-push`（Rust → 提醒窗口，卡片数组）、`nowtree:data-changed`（提醒窗口 → 主窗口，刷新数据）、`nowtree:open-view`（提醒窗口 → 主窗口，切到 Inbox）。
- **⚠️ 建窗命令必须是 async**：`show_reminder_cards` 声明为 `async`。Tauri 文档明确「Windows 下在同步命令 / 事件处理器里创建窗口会死锁」（WebView2 控制器不能在自身回调栈里重入创建）；同步写法会表现为整个应用冻住（界面停在加载中、点不动、关闭确认框也点不掉）。后续凡是新增「运行时建窗」的命令，都要遵循这一点。
- **全屏不打扰**：投递时用 `SHQueryUserNotificationState` 判断前台是否全屏（F11 / 视频 / 演示模式）。全屏时卡片**先进入排队队列**（不建窗 / 不显示 / 不抢焦点）；后台监测线程每 2 秒检查一次，退出全屏后把暂存卡片统一弹出。非全屏时正常置顶显示。
- **边界**：窗口最小化到托盘时进程仍存活、提醒照常（JS 定时器被系统节流时延迟最多约 1 分钟）；**彻底退出后不再提醒**（OS 级定时仍未做）。显示 / 隐藏走 Win32 `ShowWindow(SW_SHOWNOACTIVATE / SW_HIDE)`：tao 只在首次显示用不激活方式，之后再 `show()` 会走 `SW_SHOW` 可能抢焦点，故统一由 Rust 直接控制。

### 关闭确认与窗口置顶（1.1.5）

`lib.rs` 拦截 `CloseRequested` 后只 `prevent_close + emit`，前端 `useShell` 决定是否弹确认框。1.1.5 起，若确实要弹框，先 `invoke("bring_main_to_front")`：`show + unminimize + set_always_on_top(true) + set_focus`，保证窗口压在其它程序下面时确认框也立即可见（Windows 前台锁拒绝抢焦点时，置顶仍能保证可见）。用户取消或选择后调用 `release_main_topmost` 解除置顶；`minimize_to_tray` 内也会复位一次，避免主窗口长期置顶。

### 关闭窗口

`lib.rs` 拦截 `CloseRequested`：`prevent_close()` + 给前端发 `window-close-requested` 事件 → 前端弹模态确认框（最小化到托盘 / 退出 + 不再提示）。真正隐藏 / 退出由 `minimize_to_tray` / `quit_app` 命令执行。加 `tauri-plugin-single-instance` 防止双开抢同一 DB 锁。

---

## 5. 构建与打包

| 脚本 | 命令 | 作用 | 产出 |
|---|---|---|---|
| `run-dev.bat` | `npm run tauri dev` | 开发热重载 | 调试窗口 |
| `build-release.bat` | `npm run tauri icon -- src-tauri/icons/source.png` → `npm run tauri build` | 出成品 | `target/release/NowTree.exe`；同时出 `target/release/bundle/msi/*.msi` 与 `target/release/bundle/nsis/*-setup.exe` |
| `build_tauri.bat` | `cargo build` | **仅编译 Rust 侧** | 验证 Rust 能链接，**不打包、不出安装包、不弹窗口** |

> 本机已安装 **WiX Toolset v3.14.1** 与 **NSIS**，`tauri.conf.json` 中 `targets: "all"`，所以每次构建会同时产出 MSI 安装包与 NSIS `setup.exe`。WiX v4（.NET 工具 `wix`）Tauri v2 当前用不了。

### 权限（capabilities）

`src-tauri/capabilities/` 按窗口开放权限：`default.json` 给主窗口（`core:default`、`dialog`、`autostart`、`opener`），`reminder.json` 给右下角提醒窗口（`core:default`，供事件监听 / 发送）。新增 Tauri 命令若前端报权限错，先来这里加对应 `allow-*`。1.1.5 起已移除 `notification` 插件与权限。

---

## 6. 测试

- **单元（vitest）**：`npm test`。覆盖拖拽几何（`dragUtils`）、业务逻辑（`transactionService`）、类型校验、内存仓库。这些验证**纯逻辑 + 内存仓库**，不覆盖真 SQLite 与 GUI。
- **数据层自检**：`scripts/regression_db.py`（只读连本机 DB，检查状态分布 / `completed_time` 写入率 / 孤儿 / 软删除）。
- **GUI 回归**：`回归清单.md` 提供逐项手动点检清单（本机运行验证）。
