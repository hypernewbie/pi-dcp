import { keyHint, type ExtensionAPI, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
  listSessionHistory,
  readSessionHistory,
  searchSessionHistory,
  type SessionHistoryResult,
} from "./session-reader.ts";

const PARAMETERS = Type.Object({
  action: StringEnum(["list", "search", "read"] as const, {
    description: "list available entries, search raw history, or read an entry-ID range",
  }),
  query: Type.Optional(Type.String({ description: "Literal text to search for; required for search" })),
  startEntryId: Type.Optional(Type.String({ description: "First entry ID to read; required for read" })),
  endEntryId: Type.Optional(Type.String({ description: "Last entry ID to read; required for read" })),
  maxTokens: Type.Optional(Type.Integer({ minimum: 500, maximum: 8000, description: "Maximum bounded output size" })),
});

type Params = {
  action: "list" | "search" | "read";
  query?: string;
  startEntryId?: string;
  endEntryId?: string;
  maxTokens?: number;
};

export function registerSessionReaderTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "dcp_read_session",
    label: "Read Session History",
    description: "Read a small, specific raw excerpt from earlier messages in the current session. Search or list first, then read a narrow range. This tool cannot read a whole session at once.",
    promptSnippet: "Read a narrow raw excerpt from earlier session history",
    promptGuidelines: [
      "Use dcp_read_session only for a specific missing fact from earlier raw session history. Search or list before reading and never request the whole session.",
    ],
    parameters: PARAMETERS,
    executionMode: "sequential",
    async execute(_toolCallId, params: Params, _signal, _onUpdate, ctx) {
      // getBranch is intentionally used here. buildContextEntries is Pi's
      // compacted model-facing projection and cannot recover hidden raw entries.
      const entries = ctx.sessionManager.getBranch();
      const result = dispatch(params, entries);
      return {
        content: [{ type: "text", text: result.text }],
        details: result.details,
      };
    },
    renderCall(args, theme) {
      return new Text(theme.fg("toolTitle", theme.bold(renderCallLabel(args))), 0, 0);
    },
    renderResult(result, { expanded, isPartial }, theme) {
      if (isPartial) return new Text(theme.fg("warning", "Reading session history…"), 0, 0);
      const details = result.details as SessionHistoryResult["details"] | undefined;
      if (expanded) {
        const raw = result.content.find((part) => part.type === "text");
        const text = raw?.type === "text" ? raw.text : "No text returned.";
        const styled = text.split("\n").map((line) => theme.fg("toolOutput", line)).join("\n");
        return new Text(styled, 0, 0);
      }
      if (details?.error) return new Text(theme.fg("error", `Error: ${details.error}`), 0, 0);
      const summary = renderCollapsedResult(details);
      return new Text(
        theme.fg("success", "✓ ") + theme.fg("muted", summary) + theme.fg("dim", ` (${keyHint("app.tools.expand", "to expand")})`),
        0,
        0,
      );
    },
  });
}

function renderCallLabel(params: Params): string {
  if (params.action === "search") return `session history search ${quoteInline(params.query ?? "")}`;
  if (params.action === "read") {
    const start = shortId(params.startEntryId);
    const end = shortId(params.endEntryId);
    return `session history read ${start}${start === end ? "" : `…${end}`}`;
  }
  return "session history list";
}

function renderCollapsedResult(details: SessionHistoryResult["details"] | undefined): string {
  if (!details) return "session history returned";
  const count = details.returnedIds.length;
  const itemLabel = details.action === "search"
    ? `${count} match${count === 1 ? "" : "es"}`
    : `${count} entr${count === 1 ? "y" : "ies"}`;
  const size = details.estimatedTokens > 0 ? ` · ~${formatTokens(details.estimatedTokens)} tokens` : "";
  const more = details.moreAvailable ? " · more available" : "";
  return `${itemLabel}${size}${more}`;
}

function quoteInline(text: string): string {
  const compact = text.replace(/\s+/g, " ").trim();
  const bounded = compact.length > 80 ? `${compact.slice(0, 77)}…` : compact;
  return JSON.stringify(bounded);
}

function shortId(value: string | undefined): string {
  if (!value) return "?";
  return value.length > 8 ? value.slice(0, 8) : value;
}

function formatTokens(tokens: number): string {
  if (tokens < 1_000) return String(tokens);
  if (tokens < 10_000) return `${(tokens / 1_000).toFixed(1).replace(/\.0$/, "")}K`;
  return `${Math.round(tokens / 1_000)}K`;
}

function dispatch(params: Params, entries: SessionEntry[]): SessionHistoryResult {
  switch (params.action) {
    case "list":
      return listSessionHistory(entries);
    case "search":
      return searchSessionHistory(entries, params.query);
    case "read":
      return readSessionHistory(entries, params.startEntryId, params.endEntryId, params.maxTokens);
  }
}
