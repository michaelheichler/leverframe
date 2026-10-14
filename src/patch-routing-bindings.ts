const MODULE_BOUNDARY = ['\n', '//#__leverframe_claude_module__:'].join('');

export function escapePattern(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function moduleAt(source: string, offset: number): { start: number; name?: string; content: string } {
  const start = source.lastIndexOf(MODULE_BOUNDARY, offset);
  const end = source.indexOf(MODULE_BOUNDARY, offset);
  const content = source.slice(Math.max(0, start), end < 0 ? undefined : end);
  const name = start < 0 ? undefined : content.slice(MODULE_BOUNDARY.length).split('\n', 1)[0];
  return { start, name, content };
}

function bindingPattern(name: string): RegExp {
  return new RegExp('^' + escapePattern(name) + '(?: as [\\w$]+)?$');
}

type RoutingBinding =
  | { kind: 'local'; name: string }
  | { kind: 'foreign'; ownerName: string; exportedName: string; consumerContent: string };

function findRoutingBinding(source: string, definition: RegExp, consumerOffset: number): RoutingBinding | undefined {
  const matches = [...source.matchAll(new RegExp(definition.source, 'g'))];
  if (matches.length !== 1) return undefined;
  const match = matches[0]!;
  const name = match[1]!;
  const owner = moduleAt(source, match.index);
  const consumer = moduleAt(source, consumerOffset);
  if (owner.start === consumer.start) return { kind: 'local', name };
  if (owner.name === undefined) return undefined;
  const exported = [...owner.content.matchAll(/export\{([^}]+)\}/g)]
    .flatMap(entry => entry[1]!.split(','))
    .find(entry => bindingPattern(name).test(entry));
  if (!exported) return undefined;
  return {
    kind: 'foreign',
    ownerName: owner.name,
    exportedName: exported.split(' as ')[1] ?? name,
    consumerContent: consumer.content,
  };
}

export function resolveRoutingBinding(source: string, definition: RegExp, consumerOffset: number): string | undefined {
  const binding = findRoutingBinding(source, definition, consumerOffset);
  if (binding?.kind !== 'foreign') return binding?.name;
  const imports = [...binding.consumerContent.matchAll(/import\{([^}]+)\}from"([^"\n]+)"/g)]
    .filter(entry => entry[2] === binding.ownerName)
    .flatMap(entry => entry[1]!.split(','));
  return imports.find(entry => bindingPattern(binding.exportedName).test(entry))?.split(' as ').at(-1);
}

export function requireRoutingBinding(source: string, definition: RegExp, consumerOffset: number): string | undefined {
  const binding = findRoutingBinding(source, definition, consumerOffset);
  if (binding?.kind !== 'foreign') return undefined;
  return 'import.meta.require(' + JSON.stringify(binding.ownerName) + ').' + binding.exportedName;
}
