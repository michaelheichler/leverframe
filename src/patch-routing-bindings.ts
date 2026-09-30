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

export function resolveRoutingBinding(source: string, definition: RegExp, consumerOffset: number): string | undefined {
  const matches = [...source.matchAll(new RegExp(definition.source, 'g'))];
  if (matches.length !== 1) return undefined;
  const match = matches[0]!;
  const name = match[1]!;
  const owner = moduleAt(source, match.index);
  const consumer = moduleAt(source, consumerOffset);
  if (owner.start === consumer.start) return name;
  if (owner.name === undefined) return undefined;
  const exports = [...owner.content.matchAll(/export\{([^}]+)\}/g)]
    .flatMap(entry => entry[1]!.split(','));
  const exported = exports.find(entry => new RegExp('^' + escapePattern(name) + '(?: as [\\w$]+)?$').test(entry));
  if (!exported) return undefined;
  const exportedName = exported.split(' as ')[1] ?? name;
  const imports = [...consumer.content.matchAll(/import\{([^}]+)\}from"([^"\n]+)"/g)]
    .filter(entry => entry[2] === owner.name)
    .flatMap(entry => entry[1]!.split(','));
  const binding = imports.find(entry => new RegExp('^' + escapePattern(exportedName) + '(?: as [\\w$]+)?$').test(entry));
  return binding?.split(' as ').at(-1);
}

export function importRoutingBinding(source: string, definition: RegExp, consumerOffset: number): string | undefined {
  const matches = [...source.matchAll(new RegExp(definition.source, 'g'))];
  if (matches.length !== 1) return undefined;
  const match = matches[0]!;
  const owner = moduleAt(source, match.index);
  const consumer = moduleAt(source, consumerOffset);
  if (owner.name === undefined || owner.start === consumer.start) return undefined;
  const exports = [...owner.content.matchAll(/export\{([^}]+)\}/g)].flatMap(entry => entry[1]!.split(','));
  const exported = exports.find(entry => new RegExp('^' + escapePattern(match[1]!) + '(?: as [\\w$]+)?$').test(entry));
  if (!exported || /\b__lfcRoutingEffort\b/.test(consumer.content)) return undefined;
  const exportedName = exported.split(' as ')[1] ?? match[1]!;
  const imports = [...consumer.content.matchAll(/import\{([^}]+)\}from"([^"\n]+)"/g)]
    .filter(entry => entry[2] === owner.name);
  if (imports.length !== 1) return undefined;
  const entry = imports[0]!;
  const offset = consumer.start + entry.index!;
  const replacement = 'import{' + entry[1] + ',' + exportedName + ' as __lfcRoutingEffort}from' + JSON.stringify(owner.name);
  return source.slice(0, offset) + replacement + source.slice(offset + entry[0].length);
}
