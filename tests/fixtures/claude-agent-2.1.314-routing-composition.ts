import { CLAUDE_MODULE_BOUNDARY, splitModulePayload } from '../../src/claude-bundle-native.js';
import { auxiliaryGuardSource, auxiliaryRequestSource } from './claude-agent-2.1.314-notice-auxiliary-guard.js';
import { noticeFrameSource } from './claude-agent-2.1.314-notice-frame.js';
import { noticeHostSource, noticeRequestSource } from './claude-agent-2.1.314-notice-host.js';
import { noticeStartupSource } from './claude-agent-2.1.314-notice-startup.js';
import { noticeWriterSource } from './claude-agent-2.1.314-notice-writer.js';
import { claudeAgentRoutingHandoffSource } from './claude-agent-2.1.314-routing.js';

export function claudeAgentRoutingNoticeCompositionSource(): string {
  const writer = `${CLAUDE_MODULE_BOUNDARY}/$bunfs/root/chunk-w2wf6pm6.js\n${noticeWriterSource}`;
  const adapter = `${CLAUDE_MODULE_BOUNDARY}/$bunfs/root/chunk-f5200rjz.js\nfunction ai(){return{get(){}}}export{ai};`;
  const modules = new Map<string, string>();
  const fragments = [claudeAgentRoutingHandoffSource(), writer, noticeFrameSource, noticeStartupSource,
    noticeHostSource + noticeRequestSource, auxiliaryGuardSource + auxiliaryRequestSource, adapter];

  for (const fragment of fragments) {
    const parsed = splitModulePayload(fragment);
    if (!parsed) throw new Error('The supported routing fixture has no module boundary.');
    for (const [name, content] of parsed) {
      const previous = modules.get(name);
      modules.set(name, previous === undefined ? content : `${previous}\n${content}`);
    }
  }
  return [...modules].map(([name, content]) => `${CLAUDE_MODULE_BOUNDARY}${name}\n${content}`).join('');
}
