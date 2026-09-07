

const SAFE_SESSION_ID = /^[A-Za-z0-9._:-]{1,256}$/;

export interface ExecutionSessionKeyInput {

  claudeSessionId?: string;
  provider: string;
  model: string;
}

export function resolveExecutionSessionKey(input: ExecutionSessionKeyInput): string {
  const provider = input.provider.trim() || 'unknown-provider';
  const model = input.model.trim() || 'unknown-model';
  const sessionId = input.claudeSessionId?.trim();
  if (sessionId && SAFE_SESSION_ID.test(sessionId)) {
    return `session:${sessionId}`;
  }
  return `anon:${provider}:${model}`;
}
