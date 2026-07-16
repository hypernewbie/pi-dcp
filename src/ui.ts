import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { DcpConfig } from "./types.ts";

export function notify(ctx: ExtensionContext, config: DcpConfig, message: string, type: "info" | "warning" | "error"): void {
  if (config.notification === "off") return;
  if (config.notification === "minimal" && type === "info") return;

  if (ctx.hasUI) {
    ctx.ui.notify(`[dcp] ${message}`, type);
  } else if (config.debug || type === "error") {
    const stream = type === "error" ? console.error : console.log;
    stream(`[dcp] ${message}`);
  }
}

/**
 * A temporary, visible compacting card. The normal working spinner cannot be
 * shown at turn_end because Pi has already marked the agent non-streaming by
 * then. A widget renders independently of streaming and is removed on finish;
 * it is not a footer, statusline, or persisted transcript entry.
 */
export function setCompactingWorking(ctx: ExtensionContext, active: boolean): void {
  const ui = ctx.ui as ExtensionContext["ui"] & {
    setWidget?: (key: string, content: string[] | undefined, options?: { placement?: "aboveEditor" | "belowEditor" }) => void;
  };
  try {
    if (active) {
      ui.setWidget?.("dcp-compacting", [
        "▣ DCP COMPACT · summarizing completed work…",
        "│░░░░░░░░░░░░░░░░░░░░░░░░████████████████│",
      ], { placement: "aboveEditor" });
    } else {
      ui.setWidget?.("dcp-compacting", undefined);
    }
  } catch {
    // UI status must never affect compression.
  }
}

export function debug(ctx: ExtensionContext, config: DcpConfig, message: string): void {
  if (!config.debug) return;
  if (ctx.hasUI) {
    ctx.ui.notify(`[dcp:debug] ${message}`, "info");
  } else {
    console.log(`[dcp:debug] ${message}`);
  }
}
