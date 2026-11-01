import { openEvidenceStore } from './context/evidence-runtime.js';

export async function runEvidenceCommand(args: string[]): Promise<number> {
  if (args.length !== 3 || args[0] !== 'get') {
    console.error('Usage: leverframe evidence get <session-id> <reference>');
    return 1;
  }
  try {
    const content = await (await openEvidenceStore()).get(args[1]!, args[2]!);
    process.stdout.write(content);
    return 0;
  } catch {
    console.error('Evidence unavailable');
    return 1;
  }
}
