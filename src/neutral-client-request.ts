const BILLING_LINE = /^[\t ]*x-anthropic-billing-header:[^\r\n]*(?:\r?\n|$)/gm;
const CLIENT_IDENTITY = /^[\t ]*You are Claude Code(?:, Anthropic['\u2019]s official CLI(?: for Claude)?)?\.?(?=\s|$)/gm;

export function neutralInstructionText(text: string): string {
  return text.replace(BILLING_LINE, '').replace(CLIENT_IDENTITY, 'You are a coding assistant.');
}

function instructionBlocks(content: unknown): unknown {
  if (typeof content === 'string') return neutralInstructionText(content);
  if (!Array.isArray(content)) return content;
  return content.flatMap(block => {
    if (typeof block === 'string') {
      const text = neutralInstructionText(block);
      return text.trim() ? [text] : [];
    }
    if (!block || typeof block !== 'object' || typeof block.text !== 'string') return [block];
    const text = neutralInstructionText(block.text);
    return text.trim() ? [{ ...block, text }] : [];
  });
}

export function neutralClientInstructions<T extends { system?: unknown; messages?: unknown }>(body: T): T {
  const result = { ...body };
  if (body.system !== undefined) result.system = instructionBlocks(body.system);
  if (Array.isArray(body.messages)) {
    result.messages = body.messages.map(message => {
      if (message?.role !== 'system' && message?.role !== 'developer') return message;
      return { ...message, content: instructionBlocks(message.content) };
    });
  }
  return result;
}

function isClaudeUserId(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  if (/^user_[a-f0-9]+_account_[\w-]*_session_[\w-]+$/i.test(value)) return true;
  try {
    const parsed = JSON.parse(value);
    return parsed !== null && typeof parsed === 'object'
      && typeof parsed.device_id === 'string' && typeof parsed.account_uuid === 'string'
      && typeof parsed.session_id === 'string';
  } catch {
    return false;
  }
}

export function neutralAnthropicApiRequest(body: Record<string, unknown>): Record<string, unknown> {
  const result = neutralClientInstructions(body);
  const metadata = body.metadata;
  if (metadata && typeof metadata === 'object' && !Array.isArray(metadata)
    && 'user_id' in metadata && isClaudeUserId(metadata.user_id)) {
    const { user_id: _userId, ...rest } = metadata;
    if (Object.keys(rest).length) result.metadata = rest;
    else delete result.metadata;
  }
  return result;
}

export function neutralClientHeaders(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(headers).filter(([name, value]) => {
    const key = name.toLowerCase();
    if (key === 'x-app' || key.startsWith('x-claude-code-') || key === 'x-anthropic-billing-header') return false;
    return key !== 'user-agent' || !/claude[- ](?:cli|code)/i.test(value);
  }));
}
