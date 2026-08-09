# Habits Feature Design

> 本文档是开发 Habits 视图前的设计前提，由历次讨论（grill-me）敲定。
> 当前状态：**设计已定，已于 2026-08-09 落地于 1.1.0（代码完成，待 build/发版）**。落地时照 `NowTree维护与演进手册.md` 上篇升版本号 + 打包 + 发 Release。
> 所有条目均为「讨论已立项待开发」状态，做哪个版本排期由你拍板。

---

## Why we need Habits?

我认为，一个人的成长除了长远的规划，短期的机械性坚持同样不可或缺。如果把机械重复的事务如每天的课程学习、论文阅读、背单词等活动强行地放置在 **Next 视图** 中，只会破坏原有 GTD 工作流的平衡——它们既不是"一次性 next action"，也不该占用 Next 的注意力。因此，我们需要一个新的视图，在原有的传统 GTD 视角上拓展。

### Habits 应运而生

Habits 视图专门收容「每天/定期重复、需要坚持」的事务，把它们从 Next 中剥离，让 GTD 主线保持干净，同时给自己一个专属的"每日坚持"空间。

---

## Task 和 Habit 的区别

| 维度 | 普通 Task（Transaction） | Habit |
|---|---|---|
| 语义 | 一次性完成即结束 | 每天/定期重复，完成次日重置 |
| 完成状态 | `status='completed'` 后永久保留（进回收站或置底） | `status='completed'` 后**次日重置回未完成** |
| 所在视图 | Next / Project / Waiting / Someday | 独立 **Habits 视图**（不自动进 Next） |
| 统计 | 无连续概念 | 未来可加连续天数 streak（本期不做） |
| 删除 | 软删除进回收站 | 软删除进回收站（同机制） |

> Habit 在底层**复用 Transaction 表**，仅靠 `category='habit'` 区分，因此上面"区别"是**行为与视图层**的区别，不是存储层的割裂。

---

## 数据模型决策（已定）

**结论：沿用现有 `Transaction` 单表，扩展 `category` 枚举加入 `'habit'`，不新建表。**

理由（来自讨论权衡）：
- 改动最小：后端几乎零新增 CRUD，复用现有仓储与命令。
- 互转零成本：Habit ↔ 普通 Task 互转只需改 `category` 一行，无需跨表移动。
- streak 将来要做时，再补一张 `habit_completions(habit_id, date)` 历史表挂上去即可，不影响现在。

**本期明确不加的**：
- 不加 `recurrence` 列（重复频率**暂只支持 daily**，重置逻辑写死"每天"）。未来要 weekly/monthly 时再加该列。
- 不加独立 `habits` 表（若早期选独立表方案，互转要做跨表移动且 recurrence 无处放；权衡后放弃）。
- 不建打卡历史表（streak 本期不做）。

---

## 第一版内容应该包含什么（MVP）

1. **第五个视图 Habits**
   - 侧边栏新增「习惯」入口，与普通四个视图并列，可 Tab / 拖拽切换查看。
   - Habit **默认只在 Habits 视图显示，不进 Next**（避免破坏 GTD 主线）。

2. **完成交互：复用「打勾 + 置底灰显」**
   - 在 Habits 视图里点打勾 = 与普通 Task 一样的视觉：打勾 → 置底灰显。
   - 视觉复用现有完成渲染，用户认知一致、代码可复用。
   - ⚠️ **底层逻辑不同**：普通 Task 打勾后永久 `completed`；Habit 打勾后会被每日重置（见下）。

3. **每日 6 点重置**
   - 当本地时间跨过 **06:00**，把所有 `category='habit'` 且 `status='completed'` 的项重置为 `status='active'`、清空 `completed_time`。
   - 重置粒度：以**本地日期 + 6:00 为界**。例如前一天 23:00 完成，到次日 6:00 重置，算"昨天完成过"；0:00–6:00 之间完成的，6:00 也会重置（属"今天"未完成态）。
   - 实现提示：复用现有的「每日定时扫描」机制（现有 `normalizeDeadlines` / `autoPromoteWaiting` 在每日 0 点跑），新增一个 6 点定时器或在现有定时里加一段 habit 重置逻辑。

4. **手动删除（软删除）**
   - Habits 视图支持手动删除某个 habit，采用 `deleted=1` 软删除，**进回收站可恢复**，与全局一致。
   - 物理删除（不可恢复）本期不做。

5. **视图内拖拽排序**
   - 多个 habit 之间可拖拽调序，顺序存 `order_index`，与现有 Next 视图拖拽排序一致。

6. **跨视图互转（可拖成普通事务）**
   - 把某个 habit 拖到 Next / Project 等视图 → 变成普通 Transaction（`category` 改为目标值，如 `next_action`）；反之把普通事务拖进 Habits → 变成 habit（`category='habit'`，重置频率默认 daily）。
   - 由于本期无 `recurrence` 列，互转时不涉及频率字段映射，直接改 `category` 即可。

7. **一键清理排除**
   - Habits 视图**不提供「一键清理」**（habit 每天重置、没有"已完成待清"的语义，一键清理无意义）。
   - 具体表现：Habits 视图的工具栏不显示「一键清理」按钮（或显示但仅作用于普通已完成事务，不影响 habit）。以"隐藏按钮"为首选。

---

## 不做什么（明确排除，避免误做）

- ❌ **连续打卡 streak 统计**：本期不做。将来做时补 `habit_completions` 历史表 + 视图顶部 🔥 展示。
- ❌ **weekly / monthly 频率**：本期只 daily。将来做时加 `recurrence` 列（none/daily/weekly/monthly）并按频率重置。
- ❌ **独立 habits 表**：已选定沿用 Transaction 单表方案。
- ❌ **Habit 自动进 Next**：默认不进，需用户显式拖拽转成普通事务才进。
- ❌ **物理删除 habit**：只软删除。

---

## 实现提示（给开发者，非代码）

- **状态枚举扩展点**：`Category` 类型加 `'habit'`；视图路由 `ViewKey` 加 `'habits'`；侧边栏 `navItems` 加一项。
- **重置机制挂载点**：现有每日定时扫描（0 点）所在处，新增 6 点判断或独立 6 点定时器；扫描逻辑只针对 `category='habit' && status==='completed'`。
- **完成交互复用**：Habits 视图的完成渲染直接调用现有 `completed` 样式/逻辑，不要另写一套。
- **软删除复用**：habit 删除走现有 `deleted=1` 通道，回收站视图天然支持恢复。
- **一键清理按钮**：在 Habits 视图的工具栏渲染时跳过「一键清理」项（条件判断 `currentView !== 'habits'`）。

---

## 未来演进（讨论未排期）

- **streak**：加 `habit_completions(habit_id, date)` 表，Habits 视图顶部显示「连续 N 天 🔥」；重置逻辑不变，历史表独立累计。
- **周/月频率**：加 `recurrence` 列；重置按频率（周日重置本周、月底重置本月）；互转时频率字段映射到普通事务的 `deadline_type` 或丢弃。
- **Habit 进 Next 开关**：若想让某些 habit 也出现在 Next，可加 `show_in_next` 标志（现有字段已存在，复用即可）。

---

*最后更新：2026-08-08 —— 经 grill-me 讨论敲定全部架构决策；2026-08-09 已实现（代码落，待 build/发版）。*
