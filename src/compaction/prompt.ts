import type { SummaryPrompt } from "../types.ts";

const SYSTEM_PROMPT = `You are a context summarization assistant for a coding agent session.
Your task is to read a conversation between a user and an AI assistant, then produce a structured summary following the exact format specified.

Do NOT continue the conversation. Do NOT respond to any questions in the conversation. ONLY output the structured summary.`;

export interface RenderSummaryPromptInput {
  conversationText: string;
  previousSummary?: string;
  customInstructions?: string;
  protectedAppendix?: string;
  readFiles?: string[];
  modifiedFiles?: string[];
  subagentArtifacts?: string[];
}

export function renderSummaryPrompt(input: RenderSummaryPromptInput): SummaryPrompt {
  const parts: string[] = [];

  if (input.previousSummary) {
    parts.push(`## Previous Summary\n\n${input.previousSummary}`);
  }

  parts.push(`## Conversation to Summarize\n\n<conversation>\n${input.conversationText}\n</conversation>`);

  if (input.customInstructions) {
    parts.push(`## Focus Instructions\n\n${input.customInstructions}`);
  }

  const fileOpsLines: string[] = [];
  if (input.modifiedFiles && input.modifiedFiles.length > 0) {
    fileOpsLines.push(`### Relevant Files\n${input.modifiedFiles.map((f) => `- modified: ${f}`).join("\n")}`);
  }
  if (input.readFiles && input.readFiles.length > 0) {
    if (fileOpsLines.length === 0) {
      fileOpsLines.push(`### Relevant Files\n${input.readFiles.map((f) => `- read: ${f}`).join("\n")}`);
    } else {
      fileOpsLines.push(`${input.readFiles.map((f) => `- read: ${f}`).join("\n")}`);
    }
  }
  // Legacy XML tags still included for tooling that expects them
  const legacyFileOps: string[] = [];
  if (input.readFiles && input.readFiles.length > 0) {
    legacyFileOps.push(`<read-files>\n${input.readFiles.join("\n")}\n</read-files>`);
  }
  if (input.modifiedFiles && input.modifiedFiles.length > 0) {
    legacyFileOps.push(`<modified-files>\n${input.modifiedFiles.join("\n")}\n</modified-files>`);
  }

  if (fileOpsLines.length > 0) {
    parts.push(`${fileOpsLines.join("\n")}`);
  }
  if (legacyFileOps.length > 0) {
    parts.push(`## File Operations (legacy)\n\n${legacyFileOps.join("\n\n")}`);
  }

  if (input.subagentArtifacts && input.subagentArtifacts.length > 0) {
    parts.push(`## Artifacts\n\n${input.subagentArtifacts.map((a) => `- ${a}`).join("\n")}`);
  }

  if (input.protectedAppendix) {
    parts.push(`## Protected Content\n\n${input.protectedAppendix}`);
  }

  const userPrompt = `Create a comprehensive but concise summary that captures everything needed to continue the work.

## Summary Format

### Goal
[What the user is trying to accomplish]

### Constraints & Preferences
- [Requirements mentioned by user]

### Progress
#### Done
- [x] [Completed tasks]

#### In Progress
- [ ] [Current work]

#### Blocked
- [Issues, if any]

### Key Decisions
- **[Decision]**: [Rationale]

### Next Steps
1. [What should happen next]

### Critical Context
- [Data needed to continue]

${parts.join("\n\n")}`;

  return {
    systemPrompt: SYSTEM_PROMPT,
    userPrompt,
  };
}
