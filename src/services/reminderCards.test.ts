import { describe, it, expect } from "vitest";
import { mergeCards, removeCard, type ReminderCard } from "./reminderCards";

function card(p: Partial<ReminderCard> & { key: string }): ReminderCard {
  return { kind: "task", title: "t", ...p };
}

describe("mergeCards", () => {
  it("按 key 去重（同一事务重复投递只留一张）", () => {
    const a = card({ key: "task:1", id: 1, title: "A" });
    const b = card({ key: "task:2", id: 2, title: "B" });
    const merged = mergeCards([a], [a, b]);
    expect(merged.map((c) => c.key)).toEqual(["task:1", "task:2"]);
  });

  it("保留既有顺序，新卡追加在后", () => {
    const a = card({ key: "task:1" });
    const b = card({ key: "task:2" });
    const c = card({ key: "task:3" });
    expect(mergeCards([a, b], [c]).map((x) => x.key)).toEqual([
      "task:1",
      "task:2",
      "task:3",
    ]);
  });

  it("新的 daily 卡会替换旧 daily 卡（同一窗口只挂一张每日摘要）", () => {
    const morning = card({ key: "daily:2026-11-03:morning", kind: "daily", title: "早上好" });
    const noon = card({ key: "daily:2026-11-03:noon", kind: "daily", title: "下午好" });
    const task = card({ key: "task:9" });
    const merged = mergeCards([morning, task], [noon]);
    expect(merged.map((c) => c.title)).toEqual(["t", "下午好"]);
  });

  it("空入参不改变队列", () => {
    const a = card({ key: "task:1" });
    expect(mergeCards([a], [])).toEqual([a]);
  });
});

describe("removeCard", () => {
  it("只移除命中的 key", () => {
    const a = card({ key: "task:1" });
    const b = card({ key: "review:2026-11-03", kind: "review" });
    expect(removeCard([a, b], "task:1")).toEqual([b]);
  });

  it("key 不存在时原样返回", () => {
    const a = card({ key: "task:1" });
    expect(removeCard([a], "task:2")).toEqual([a]);
  });
});
