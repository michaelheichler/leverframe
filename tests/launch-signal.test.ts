import { EventEmitter } from 'node:events';
import { expect, it, vi } from 'vitest';
import { launchClaude, type LaunchClaudeOptions } from '../src/launch.js';

vi.mock('../src/config.js', () => ({ loadPreferences: () => ({}), getAppPathOverride: () => undefined }));
const state = vi.hoisted(() => ({ child: null as EventEmitter | null }));
vi.mock('node:child_process', () => ({ spawn: () => state.child, execFileSync: vi.fn() }));

it.each([[null, 'SIGTERM', 143], [null, 'SIGINT', 130], [7, null, 7], [0, null, 0]] as const)(
  'reports exit %s signal %s as %s and removes signal handlers', async (code, signal, expected) => {
    state.child = new EventEmitter();
    const beforeInt = process.listenerCount('SIGINT');
    const beforeTerm = process.listenerCount('SIGTERM');
    const pending = launchClaude({
      installation: { canonicalPath: '/fake/claude' } as LaunchClaudeOptions['installation'],
      env: {}, model: undefined, extraArgs: [],
    });
    state.child.emit('exit', code, signal);
    expect(await pending).toBe(expected);
    expect(process.listenerCount('SIGINT')).toBe(beforeInt);
    expect(process.listenerCount('SIGTERM')).toBe(beforeTerm);
  },
);
