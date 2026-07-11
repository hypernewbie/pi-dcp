import { describe, it, expect } from "vitest";
import { renderAsciiBar } from "../src/ascii-bar.ts";

describe("renderAsciiBar", () => {
  it("renders a bar for known tokens", () => {
    const line = renderAsciiBar({
      tokens: 312_000,
      contextWindow: 1_000_000,
      threshold: 250_000,
      nudgeThreshold: 150_000,
    });
    expect(line).toContain("[");
    expect(line).toContain("]");
    expect(line).toContain("312k / 1.0M (31%)");
    expect(line).toContain("threshold: 250k");
  });

  it("renders a question mark when tokens are unknown", () => {
    const line = renderAsciiBar({
      tokens: null,
      contextWindow: 1_000_000,
      threshold: 250_000,
      nudgeThreshold: 150_000,
    });
    expect(line).toContain("? / 1.0M");
  });
});
