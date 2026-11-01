const NATIVE_MODELS = '\\["sonnet","opus","haiku","fable"(?:,"[^"]+")*\\]';

export function resolveAgentModelArray(source: string, argument: string): string {
  if (argument.startsWith('[')) return argument;
  const identifier = argument.replace(/[$]/g, '\\$');
  const declaration = new RegExp(`(?:^|[;,])(?:var |let |const )?${identifier}=(${NATIVE_MODELS})(?=[;,])`, 'g');
  const matches = [...source.matchAll(declaration)];
  if (matches.length !== 1) {
    throw new Error(`Agent model array ${argument} has ${matches.length} native declarations, expected one`);
  }
  return matches[0]![1]!;
}
