import { describe, expect, it } from "vitest";
import { parseJsonLoose } from "../llm.server";

describe("parseJsonLoose", () => {
  it("parses plain JSON", () => {
    expect(parseJsonLoose('{"a": 1}')).toEqual({ a: 1 });
  });

  it("parses JSON inside markdown fences", () => {
    expect(parseJsonLoose('```json\n{"messages": ["hi"]}\n```')).toEqual({ messages: ["hi"] });
    expect(parseJsonLoose('```\n{"b": 2}\n```')).toEqual({ b: 2 });
  });

  it("recovers an object embedded in prose", () => {
    expect(parseJsonLoose('Here is the result: {"verdict": "approve"} hope it helps')).toEqual({
      verdict: "approve",
    });
  });

  it("handles Hebrew content and nested objects", () => {
    expect(parseJsonLoose('{"intent": "שאלת מחיר", "data": {"x": [1, 2]}}')).toEqual({
      intent: "שאלת מחיר",
      data: { x: [1, 2] },
    });
  });

  it("throws on garbage", () => {
    expect(() => parseJsonLoose("definitely not json")).toThrow();
  });
});
