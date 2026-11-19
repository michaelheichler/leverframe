import { createHmac, randomBytes } from 'node:crypto';

const MAX_SESSIONS = 32;
const MAX_INPUT_ITEMS = 4096;
const SESSION_KEY = /^relay-session-[0-9a-f]{32}$/;

type LocalTool = { name: string };
type Declaration = { position: number; names: string[] };
type ToolHistory = {
  inputHashes: string[];
  toolHashes: Map<string, string>;
  hostedHash: string;
  initialNames: string[];
  declarations: Declaration[];
};

function toolsForNames(tools: Map<string, LocalTool>, names: string[]): LocalTool[] {
  return names.map(name => tools.get(name)!);
}

function replayDeclarations(
  input: unknown[], declarations: Declaration[], tools: Map<string, LocalTool>, namespace: Record<string, unknown>,
): unknown[] {
  const items = [];
  let offset = 0;
  for (const { position, names } of declarations) {
    items.push(...input.slice(offset, position), {
      type: 'additional_tools',
      role: 'developer',
      tools: [{ ...namespace, tools: toolsForNames(tools, names) }],
    });
    offset = position;
  }
  items.push(...input.slice(offset));
  return items;
}

export function createAppendOnlyTools() {
  const sessions = new Map<string, ToolHistory>();
  const digestKey = randomBytes(32);
  const hash = (value: unknown) => createHmac('sha256', digestKey).update(JSON.stringify(value)).digest('hex');
  return (body: Record<string, unknown>, namespaceName: string): void => {
    const session = body.prompt_cache_key;
    if (typeof session !== 'string' || !SESSION_KEY.test(session)) return;
    const key = JSON.stringify([body.model, session]);
    const input = body.input;
    const [namespace, ...hosted] = Array.isArray(body.tools) ? body.tools : [];
    if (!Array.isArray(input) || input.length > MAX_INPUT_ITEMS || namespace?.type !== 'namespace'
      || namespace.name !== namespaceName || !Array.isArray(namespace.tools)
      || (body.tool_choice !== undefined && body.tool_choice !== 'auto')) {
      sessions.delete(key);
      return;
    }
    const tools = new Map<string, LocalTool>(namespace.tools.map((tool: LocalTool) => [tool.name, tool]));
    if (tools.size !== namespace.tools.length) {
      sessions.delete(key);
      return;
    }
    const inputHashes = input.map(hash);
    const toolHashes = new Map(Array.from(tools, ([name, tool]) => [name, hash(tool)]));
    const hostedHash = hash(hosted);
    const previous = sessions.get(key);
    const namesAdded = [...tools.keys()].filter(name => !previous?.toolHashes.has(name));
    const addedSet = new Set(namesAdded);
    const hasEarlierCall = previous && namesAdded.length > 0 && input.some(item =>
      (item?.type === 'function_call' || item?.type === 'custom_tool_call') && addedSet.has(item.name));
    const extendsHistory = previous && !hasEarlierCall
      && previous.hostedHash === hostedHash
      && previous.inputHashes.every((value, index) => value === inputHashes[index])
      && Array.from(previous.toolHashes).every(([name, value]) => value === toolHashes.get(name));
    const initialNames = extendsHistory ? previous.initialNames : [...tools.keys()];
    const declarations = extendsHistory ? previous.declarations.slice() : [];
    if (extendsHistory && namesAdded.length) declarations.push({ position: input.length, names: namesAdded });
    if (declarations.length) {
      body.tools = [{ ...namespace, tools: toolsForNames(tools, initialNames) }, ...hosted];
      body.input = replayDeclarations(input, declarations, tools, namespace);
    }
    sessions.delete(key);
    sessions.set(key, { inputHashes, toolHashes, hostedHash, initialNames, declarations });
    if (sessions.size > MAX_SESSIONS) sessions.delete(sessions.keys().next().value!);
  };
}
