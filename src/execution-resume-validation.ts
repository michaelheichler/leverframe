import { boundedDigest, verifyConversationResend, type DigestableMessage, type ExecutionCheckpoint } from './execution-checkpoint.js';
import type { ToolCallLedger } from './tool-call-ledger.js';

export function resumeValidationError(
  checkpoint: ExecutionCheckpoint,
  ledger: ToolCallLedger,
  messages: DigestableMessage[],
  toolResults: { toolUseId: string; content: string }[],
): string | undefined {
  const prefix = messages.slice(0, checkpoint.messageDigests.length);
  if (!verifyConversationResend(checkpoint, prefix)) {
    return 'Resent conversation does not match the preserved checkpoint.';
  }
  for (const entry of ledger.entries) {
    if (entry.status !== 'confirmed_executed' && entry.status !== 'result_received') continue;
    const results = toolResults.filter(result => result.toolUseId === entry.toolCallId);
    if (results.length === 0) return `Resent conversation is missing the required result for ${entry.toolCallId}.`;
    if (entry.resultDigest && results.some(result => {
      const actual = boundedDigest(result.content);
      return actual.digest !== entry.resultDigest?.digest || actual.byteCount !== entry.resultDigest?.byteCount;
    })) {
      return `Resent conversation has a different result for ${entry.toolCallId}.`;
    }
  }
  return undefined;
}
