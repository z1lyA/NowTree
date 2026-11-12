import { describe, expect, it } from "vitest";
import { clampNotes, describeUpdateError, errorText, formatReleaseDate } from "./updateText";

describe("clampNotes", () => {
  it("行数不超限时原样返回", () => {
    expect(clampNotes("第一行\n第二行", 8)).toBe("第一行\n第二行");
  });

  it("行数超限时截断，且总行数正好等于上限（省略号也占一行）", () => {
    const notes = Array.from({ length: 12 }, (_, i) => `第 ${i + 1} 行`).join("\n");
    const out = clampNotes(notes, 3);
    expect(out.split("\n")).toEqual(["第 1 行", "第 2 行", "…"]);
  });

  it("正好等于上限时不动，也不加省略号", () => {
    expect(clampNotes("a\nb\nc", 3)).toBe("a\nb\nc");
  });

  it("把 CRLF 归一成 LF，避免 Windows 下换行算成两行", () => {
    expect(clampNotes("a\r\nb", 8)).toBe("a\nb");
  });

  it("空发布说明返回空串", () => {
    expect(clampNotes("", 8)).toBe("");
  });
});

describe("formatReleaseDate", () => {
  it("取 RFC 3339 的日期部分", () => {
    expect(formatReleaseDate("2026-11-10T12:34:56Z")).toBe("2026-11-10");
  });

  it("带时区偏移也照样取日期", () => {
    expect(formatReleaseDate("2026-11-10T20:34:56+08:00")).toBe("2026-11-10");
  });

  it("缺失或格式不对时返回空串（界面上就不显示这一句）", () => {
    expect(formatReleaseDate(undefined)).toBe("");
    expect(formatReleaseDate("昨天下班前")).toBe("");
  });
});

describe("describeUpdateError", () => {
  it("签名问题优先被判为校验失败，而不是网络问题", () => {
    const msg = describeUpdateError("invalid signature: verification failed");
    expect(msg).toContain("签名");
  });

  it("证书错误判成网络问题，不能误报成「签名不符」（它也含 verification 字样）", () => {
    const msg = describeUpdateError("certificate verification failed");
    expect(msg).toContain("证书");
    expect(msg).not.toContain("签名");
  });

  it("超时给超时文案", () => {
    expect(describeUpdateError("operation timed out")).toContain("超时");
  });

  it("404 提示 latest.json 可能还没上传", () => {
    expect(describeUpdateError("HTTP 404 not found")).toContain("latest.json");
  });

  it("连接类错误提示代理可能没生效", () => {
    expect(describeUpdateError("error sending request: dns error")).toContain("代理");
  });

  it("认不出的错误原样带出来，方便排查", () => {
    expect(describeUpdateError("something odd")).toContain("something odd");
  });
});

describe("errorText", () => {
  it("Error 取 message", () => {
    expect(errorText(new Error("boom"))).toBe("boom");
  });

  it("非 Error（字符串 / 数字）走 String()", () => {
    expect(errorText("raw")).toBe("raw");
    expect(errorText(404)).toBe("404");
  });
});
