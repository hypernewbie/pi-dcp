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
 * Temporary working-row status for a range summary call. This is deliberately
 * not a footer/statusline or persisted entry: it exists only while the model
 * is producing the replacement summary.
 */
export function setCompactingWorking(ctx: ExtensionContext, active: boolean): void {
  const ui = ctx.ui as ExtensionContext["ui"] & {
    setWorkingMessage?: (message?: string) => void;
    setWorkingVisible?: (visible: boolean) => void;
  };
  try {
    if (active) {
      ui.setWorkingMessage?.("Compacting older completed work…");
      ui.setWorkingVisible?.(true);
    } else {
      ui.setWorkingMessage?.();
      ui.setWorkingVisible?.(false);
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
