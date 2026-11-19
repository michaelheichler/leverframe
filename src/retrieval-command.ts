import { readFile } from 'node:fs/promises';
import { evaluateRetrieval } from './retrieval/evaluation.js';
import { serveRetrieval } from './retrieval/stdio-server.js';
import { createWorkspaceRetriever } from './retrieval/workspace-retriever.js';

const HELP = [
  'Usage: leverframe retrieval serve --workspace <git-root>',
  '       leverframe retrieval evaluate --input <report-input.json>',
].join('\n');

export async function runRetrievalCommand(args: string[]): Promise<number> {
  if (args.length === 0 || (args.length === 1 && args[0] === '--help')) {
    console.log(HELP);
    return 0;
  }

  const [command, flag, value] = args;
  if (args.length === 3 && command === 'serve' && flag === '--workspace' && value) {
    try {
      const retriever = await createWorkspaceRetriever(value);
      await serveRetrieval(retriever);
      return 0;
    } catch {
      console.error('Cannot start local retrieval. Use the root of a readable Git worktree.');
      return 1;
    }
  }

  if (args.length === 3 && command === 'evaluate' && flag === '--input' && value) {
    try {
      const input: unknown = JSON.parse(await readFile(value, 'utf8'));
      console.log(JSON.stringify(evaluateRetrieval(input)));
      return 0;
    } catch {
      console.error('Cannot evaluate retrieval. Supply a readable JSON file with valid paired observations.');
      return 1;
    }
  }

  console.error(HELP);
  return 1;
}
