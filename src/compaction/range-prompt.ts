import type { SummaryPrompt } from "../types.ts";

export interface RenderRangeSummaryPromptInput {
  kind: "historical" | "active-prefix";
  conversationText: string;
  retainedContext?: string;
  exactEvidence?: string;
  focus?: string;
}

const SYSTEM_PROMPT = `You are a context summarization assistant for a coding-agent session.
Produce an authoritative technical record of ONLY the supplied conversation facts.
Do not continue the task. Do not answer the user. Do not invent details, outcomes,
files, commands, tests, or decisions. Omit repetitive logs and dead ends, but retain
all facts needed for a later coding agent to continue correctly.`;

export function renderRangeSummaryPrompt(input: RenderRangeSummaryPromptInput): SummaryPrompt {
  const prefixInstructions = input.kind === "active-prefix"
    ? `This is an EARLY PREFIX of an active task. The current user request and newer
raw work remain in context after this summary. Explain precisely what that retained
work depends on. Do not describe the prefix as a finished task.`
    : `This is a completed historical phase. Preserve the technical record so the
original messages add no material value for later work.`;

  const sections = [
    "## Range to summarize\n\n" + input.conversationText,
    input.retainedContext ? "## Raw context retained after this range\n\n" + input.retainedContext : "",
    input.exactEvidence ? "## Exact evidence to retain\n\n" + input.exactEvidence : "",
    input.focus ? "## Requested focus\n\n" + input.focus : "",
  ].filter(Boolean).join("\n\n");

  const userPrompt = `Create a detailed, factual technical summary of the selected range.

${prefixInstructions}

Use exactly this format. Write "None" when a section has no supported facts.

### Goal
[User objective for this range]

### Constraints & Preferences
- [Explicit user requirements, limits, or acceptance criteria]

### Progress
#### Done
- [Completed actions, including meaningful tool outcomes]

#### In Progress
- [Work still underway at the range boundary]

#### Blocked
- [Unresolved failures, test results, or missing information]

### Key Decisions
- **[Decision]**: [Why it was made, only if supported by the range]

### Technical Record
- Files/paths changed or read, with the relevant implementation detail
- APIs, commands, tests, errors, and exact values a later agent must know
- Dependencies between this range and retained raw context

### Next Steps
1. [Only concrete next actions already supported by the range]

${sections}`;

  return { systemPrompt: SYSTEM_PROMPT, userPrompt };
}
