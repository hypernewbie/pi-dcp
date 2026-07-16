import type { ExtensionAPI, SessionEntry } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
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
  });
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
