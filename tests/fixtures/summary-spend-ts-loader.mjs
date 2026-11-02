import { existsSync, readFileSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';

export async function resolve(specifier, context, nextResolve) {
  if (specifier.endsWith('.js') && context.parentURL?.startsWith('file:')) {
    const parentPath = fileURLToPath(context.parentURL);
    const candidate = join(dirname(parentPath), `${specifier.slice(0, -3)}.ts`);
    if (existsSync(candidate)) return { url: pathToFileURL(candidate).href, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}

export async function load(url, context, nextLoad) {
  if (extname(new URL(url).pathname) === '.ts') {
    const source = readFileSync(fileURLToPath(url), 'utf8');
    const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
    return { format: 'module', source: output, shortCircuit: true };
  }
  return nextLoad(url, context);
}
