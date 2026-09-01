import { describe, it, expect } from "vitest";
import { buildCategoryPatch, canShowInNext, sourceText, collectReleaseIds, canRestoreChild } from "./transactionService";
import type { Transaction } from "../types/transaction";

function mk(p: Partial<Transaction>): Transaction {
  return {
    id: 1,
    title: "t",
    note: null,
    category: "next_action",
    status: "active",
    deadline_type: "none",
    deadline_date: null,
    priority: null,
    created_time: "2026-01-01T00:00:00.000Z",
    completed_time: null,
    updated_time: null,
    parent_id: null,
    show_in_next: false,
    deleted: false,
    order_index: null,
    reminder_time: null,
    reminder_done: 0,
    time_slot: "none",
    sync_id: null,
    deleted_at: null,
    wait_auto_next: false,
    ...p,
  };
}

describe("buildCategoryPatch", () => {
  it("next_action 离开 Next：清 parent_id / time_slot / show_in_next", () => {
    const tx = mk({ category: "next_action", parent_id: 5, time_slot: "morning", show_in_next: true });
    const patch = buildCategoryPatch(tx, "waiting");
    expect(patch).toEqual({
      category: "waiting",
      clear_parent: true,
      time_slot: "none",
      show_in_next: false,
    });
  });
  it("waiting/someday 改类别：仅改 category，保留 show_in_next", () => {
    const tx = mk({ category: "someday", show_in_next: true });
    const patch = buildCategoryPatch(tx, "waiting");
    expect(patch).toEqual({ category: "waiting" });
  });
});

describe("canShowInNext", () => {
  it("waiting / someday → true", () => {
    expect(canShowInNext("waiting")).toBe(true);
    expect(canShowInNext("someday")).toBe(true);
  });
  it("next_action / project → false", () => {
    expect(canShowInNext("next_action")).toBe(false);
    expect(canShowInNext("project")).toBe(false);
  });
});

describe("sourceText", () => {
  it("有父事务 → Project 来源", () => {
    expect(sourceText(mk({ parent_id: 3 }))).toBe("来源：Project");
  });
  it("waiting 透出 → Waiting 来源", () => {
    expect(sourceText(mk({ category: "waiting" }))).toBe("来源：Waiting");
  });
  it("someday 透出 → Someday 来源", () => {
    expect(sourceText(mk({ category: "someday" }))).toBe("来源：Someday");
  });
  it("普通 next_action 无父 → null", () => {
    expect(sourceText(mk({ category: "next_action", parent_id: null }))).toBeNull();
  });
});

describe("collectReleaseIds (A/1.1.3)", () => {
  // 树：P(1) → C1(2)→G1(3)、C2(4)
  const items: Transaction[] = [
    mk({ id: 1, category: "project", parent_id: null }),
    mk({ id: 2, category: "next_action", parent_id: 1 }),
    mk({ id: 3, category: "next_action", parent_id: 2 }),
    mk({ id: 4, category: "next_action", parent_id: 1 }),
  ];
  it("收集整棵后代子树（不含父自身，含任意层级）", () => {
    const ids = collectReleaseIds(items, 1).sort((a, b) => a - b);
    expect(ids).toStrictEqual([2, 3, 4]);
  });
  it("排除 excludeIds 中的后代（批量移动时同样被选中的子项）", () => {
    const ids = collectReleaseIds(items, 1, [2, 4]).sort((a, b) => a - b);
    expect(ids).toStrictEqual([3]);
  });
  it("父自身永不在释放列表", () => {
    expect(collectReleaseIds(items, 1)).not.toContain(1);
  });
});

describe("canRestoreChild (A/1.1.3 回收站恢复护栏)", () => {
  const parent = mk({ id: 1, category: "project", parent_id: null });
  const child = mk({ id: 2, category: "next_action", parent_id: 1 });
  it("顶层事务（无父）→ 允许恢复", () => {
    expect(canRestoreChild(mk({ id: 9, parent_id: null }), [parent])).toBe(true);
  });
  it("子事务的父仍在 active 且为 Project → 允许单独恢复", () => {
    expect(canRestoreChild(child, [parent])).toBe(true);
  });
  it("子事务的父已软删（不在 active）→ 拦截", () => {
    const deletedParent = { ...parent, deleted: true };
    expect(canRestoreChild(child, [deletedParent])).toBe(false);
  });
  it("子事务的父已不再是 Project（被改去其它类别）→ 拦截", () => {
    const exProject = { ...parent, category: "next_action" as const };
    expect(canRestoreChild(child, [exProject])).toBe(false);
  });
  it("子事务的父根本不在 active（已彻底删除）→ 拦截", () => {
    expect(canRestoreChild(child, [])).toBe(false);
  });
});
