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

export function debug(ctx: ExtensionContext, config: DcpConfig, message: string): void {
  if (!config.debug) return;
  if (ctx.hasUI) {
    ctx.ui.notify(`[dcp:debug] ${message}`, "info");
  } else {
    console.log(`[dcp:debug] ${message}`);
  }
}
