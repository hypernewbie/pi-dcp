import { describe, it, expect } from "vitest";
import { normalizeSubagentResult } from "../src/compaction/subagent-result.ts";

describe("normalizeSubagentResult", () => {
  it("extracts conclusion and artifacts", () => {
    const content = "Research completed: auth uses JWT";
    const details = {
      status: "completed",
      outputPath: "/tmp/findings.md",
      artifactPaths: ["/tmp/a.json", "/tmp/b.json"],
    };
    const res = normalizeSubagentResult(content, details);
    expect(res.status).toBe("completed");
    expect(res.outputPath).toBe("/tmp/findings.md");
    expect(res.artifactPaths).toContain("/tmp/a.json");
    expect(res.conclusion).toContain("auth uses JWT");
  });

  it("bounds huge conclusions", () => {
    const huge = "x".repeat(10000);
    const res = normalizeSubagentResult(huge, {});
    expect(res.conclusion!.length).toBeLessThanOrEqual(4100);
  });

  it("deduplicates artifact paths", () => {
    const details = {
      artifactPaths: ["/tmp/a.json", "/tmp/a.json", "/tmp/b.json"],
    };
    const res = normalizeSubagentResult("done", details);
    expect(res.artifactPaths.length).toBe(2);
  });

  it("preserves failure status", () => {
    const res = normalizeSubagentResult("failed due to error", { status: "failed" });
    expect(res.status).toBe("failed");
  });
});
