import { describe, expect, it } from 'vitest';
import { createMemorySessionFsProvider } from '../src/copilot/memory-session-fs.js';

describe('createMemorySessionFsProvider', () => {
  it('keeps session files in isolated memory and exposes Node-like metadata', async () => {
    const first = createMemorySessionFsProvider();
    const second = createMemorySessionFsProvider();
    await first.mkdir('/session/events', true, 0o700);
    await first.writeFile('/session/events/turn.json', 'private prompt body', 0o600);

    expect(await first.readFile('/session/events/turn.json')).toBe('private prompt body');
    expect(await first.stat('/session/events/turn.json')).toMatchObject({
      isFile: true,
      isDirectory: false,
      size: Buffer.byteLength('private prompt body'),
    });
    expect(await second.exists('/session/events/turn.json')).toBe(false);
  });

  it('supports append, directory enumeration, rename, and recursive removal', async () => {
    const provider = createMemorySessionFsProvider();
    await provider.mkdir('/session/checkpoints', true);
    await provider.writeFile('/session/checkpoints/a.json', 'a');
    await provider.appendFile('/session/checkpoints/a.json', 'b');
    await provider.rename('/session/checkpoints/a.json', '/session/checkpoints/b.json');

    expect(await provider.readFile('/session/checkpoints/b.json')).toBe('ab');
    expect(await provider.readdir('/session/checkpoints')).toEqual(['b.json']);
    expect(await provider.readdirWithTypes('/session')).toEqual([
      { name: 'checkpoints', type: 'directory' },
    ]);
    await provider.rm('/session', true, false);
    expect(await provider.exists('/session')).toBe(false);
  });

  it('raises explicit errors for missing paths and invalid non-recursive removal', async () => {
    const provider = createMemorySessionFsProvider();
    await provider.mkdir('/session/events', true);
    await provider.writeFile('/session/events/a.json', 'a');

    await expect(provider.readFile('/missing')).rejects.toThrow(/ENOENT.*\/missing/);
    await expect(provider.rm('/session', false, false)).rejects.toThrow(/ENOTEMPTY.*\/session/);
  });
});
