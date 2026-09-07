export const COPILOT_REASONING_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

export type CopilotReasoningEffort = typeof COPILOT_REASONING_EFFORTS[number];

export const COPILOT_REASONING_EFFORT_SET: ReadonlySet<CopilotReasoningEffort> = new Set(COPILOT_REASONING_EFFORTS);
