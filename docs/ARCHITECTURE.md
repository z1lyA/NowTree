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
│  commands.rs  ← 所有 Tauri 命令实现   │
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
| `src/components/` | 视图与弹窗（InboxView / NextView / ProjectListView / **HabitsView** / TrashModal / DataModal / SettingsModal …） |
| `src/store/useTxStore.ts` | Zustand 全局状态：持有 active / inbox / trash 三份列表，封装增删改查调用 |
| `src/services/transactionService.ts` | 纯业务逻辑（类别迁移规则、`canNext`、来源文案），UI 只调不写规则 |
| `src/hooks/` | 可复用交互原语：`useListDrag`（指针拖拽）、`useSelection`（多选）、`useLifecycle`（提醒轮询） |
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
| `category` | 类别：`next_action` / `project` / `waiting` / `someday` / **`habit`**（`inbox` 阶段可为空） |
| `deadline_type` / `deadline_date` | 时间要求：`none` / `today` / `week` / `month` / `date`（具体日期） |
| `priority` | 优先级 1–5（5 最急；默认 1，用户有意为之） |
| `parent_id` | 父事务 id；`NULL` 表示顶层。构成「Project → 子事务」的树 |
| `time_slot` | Next 视图的三时段：`none` / `morning` / `noon` / `evening` |
| `show_in_next` | 0/1：是否透出到全局 Next 列表（默认 0） |
| `deleted` | 软删除标志（0/1）；回收站即 `deleted=1` 的记录 |
| `deleted_at` | 软删时间戳 |
| `order_index` | 同层排序序号（拖拽持久化） |
| `reminder_time` / `reminder_done` | 提醒时间 / 是否已提醒 |
| `created_time` / `completed_time` / `updated_time` | 时间戳 |

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

### Habits 循环

`category='habit'` 的记录也走同一状态机，但 `Completed` 不是终点：

- 用户勾选 habit → `status='completed'`、`completed_time=现在`；视觉上置底灰显，但**不软删除**。
- 每日 **06:00**（本地时间），`resetHabits` 把所有昨天及更早完成的 habit 重置回 `status='active'`、`completed_time=null`，以便第二天重新打勾。
- 06:00 之前打开 app 不会提前清空：阈值取「最近的 06:00 边界」，避免凌晨误清。
- Habits **不自动进 Next**；需要时把 habit 拖到其它视图即可转回普通事务。

> 实现：`useHabitReset` 负责 06:00 定时器；`loadActive` 启动后补跑一次，保证 6 点后打开也能当天重置。

---

## 4. 关键流程

### Inbox → 正式事务（整理转换）

`convertInbox` 命令**原地改写**该记录的 `category` / `status` 等字段（同一条 id，不新建、不重复），保留 `created_time`。这是与"普通 Todo"的根本区别：NowTree 的核心对象是统一的 Transaction，收集与整理是同一记录的两种状态。

### 拖拽排序 / 改类 / 改父

- 基于 **Pointer Events**（非 HTML5 DnD，WebView2 内原生 DnD 会触发"禁止"手势）。封装在 `src/hooks/useListDrag.ts`，`NextView` 与 `useListDrag` 共用底层原语（`dragUtils.ts`）。
- 落点写入 `order_index` 持久化；跨视图拖到左侧导航栏即改 `category`；Project 内拖到父行即改 `parent_id`。
- 自动滚动：拖到列表上下边缘时，滚动容器取**光标当前所在列表**（而非拖拽起点），保证跨栏拖入时右栏能自滚。

### 提醒

`useLifecycle.ts` 每 30 秒轮询 `active` 中到期事务 → 调系统通知。窗口最小化到托盘时进程仍存活，提醒照常；**彻底退出后不再提醒**（OS 级定时为 1.0 之后方向）。

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

`src-tauri/capabilities/default.json` 按需开放：`core:window`、`dialog`、`autostart`、`notification`、`opener` 等。新增 Tauri 命令若前端报权限错，先来这里加对应 `allow-*`。

---

## 6. 测试

- **单元（vitest）**：`npm test`。覆盖拖拽几何（`dragUtils`）、业务逻辑（`transactionService`）、类型校验、内存仓库。这些验证**纯逻辑 + 内存仓库**，不覆盖真 SQLite 与 GUI。
- **数据层自检**：`scripts/regression_db.py`（只读连本机 DB，检查状态分布 / `completed_time` 写入率 / 孤儿 / 软删除）。
- **GUI 回归**：`回归清单.md` 提供逐项手动点检清单（本机运行验证）。
