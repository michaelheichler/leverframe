import { EventEmitter } from 'node:events';
import { runInNewContext } from 'node:vm';
import { expect, it, vi } from 'vitest';
import { applyRoutingNoticeFrameTransform } from '../src/patch-transforms-routing-notice-frame.js';
import { noticeFrameSource } from './fixtures/claude-agent-2.1.314-notice-frame.js';

function noticeFrameSourceFixture(): string {
  return noticeFrameSource;
}

function evaluateTransformedNoticeFrame(source: string, fakeTerminal: Record<string, unknown> = {}) {
  const transformed = applyRoutingNoticeFrameTransform(source, { enabled: true });
  expect(transformed.content).not.toBe(source);
  const text = String(fakeTerminal['text'] ?? 'nonce-4f2a');
  const width = Number(fakeTerminal['width'] ?? 40);
  const height = Number(fakeTerminal['height'] ?? 6);
  const screenWidth = Number(fakeTerminal['screenWidth'] ?? width);
  const screenHeight = Number(fakeTerminal['screenHeight'] ?? height - 1);
  const rows = Array.isArray(fakeTerminal['screenRows']) ? fakeTerminal['screenRows'] as string[] : [text];
  const cells = new Uint32Array(screenWidth * screenHeight * 2);
  const charPool = new Map<number, string>([[0, ' ']]);
  let characterId = 1;
  for (let row = 0; row < screenHeight; row++) {
    const line = rows[row] ?? '';
    for (let column = 0; column < Math.min(screenWidth, line.length); column++) {
      charPool.set(characterId, line[column]!);
      cells[(row * screenWidth + column) << 1] = characterId;
      characterId++;
    }
  }
  const patches = fakeTerminal['patches'] as Array<Record<string, unknown>> | undefined;
  const scrollResetPrefix = '\u001b[r';
  const frame = {
    screen: { width: screenWidth, height: screenHeight, cells, charPool },
    viewport: { width: Number(fakeTerminal['viewportWidth'] ?? width), height: Number(fakeTerminal['viewportHeight'] ?? height) },
    patches: patches ?? [
      { type: 'clearTerminal', altScreen: false, viewportRows: height },
      { type: 'stdout', content: text },
    ],
  };
  const rawWrites: string[] = [];
  const stdout = Object.assign(new EventEmitter(), {
    isTTY: fakeTerminal['isTTY'] !== false,
    columns: width,
    rows: height,
    destroyed: false,
    write: (data: string | Buffer) => { rawWrites.push(String(data)); return true; },
  });
  const processHarness = { stdout };
  const writerCalls: Array<{ data: string; complete: () => void; fail: () => void }> = [];
  const notice = {
    text,
    signal: fakeTerminal['signal'] as AbortSignal | undefined ?? new AbortController().signal,
    deadline: Date.now() + 5_000,
    complete: vi.fn(),
    fail: vi.fn(),
  };
  const terminalImages = {
    size: Number(fakeTerminal['imageCount'] ?? 0),
    drain: () => String(fakeTerminal['imageContent'] ?? ''),
  };
  const renderer = {
    __lfRoutingNotice: notice,
    frontFrame: frame,
    options: { stdout: fakeTerminal['optionsStdout'] ?? stdout, patchConsole: fakeTerminal['patchConsole'] !== false },
    terminal: { stdout: fakeTerminal['terminalStdout'] ?? stdout, stdoutDead: fakeTerminal['stdoutDead'] === true },
    terminalImages,
    frameSink: fakeTerminal['frameSink'] ?? null,
    nonBlockingStdout: {
      isActive: () => fakeTerminal['writerActive'] !== false,
      writeTracked: (data: string | Buffer, _signal: AbortSignal, _deadline: number,
        complete: () => void, fail: () => void) => writerCalls.push({ data: String(data), complete, fail }),
    },
    stdoutSize: () => ({ columns: stdout.columns, rows: stdout.rows }),
    isUnmounted: fakeTerminal['isUnmounted'] === true,
    isHandedOff: fakeTerminal['isHandedOff'] === true,
    isScreenReaderEnabled: fakeTerminal['isScreenReaderEnabled'] === true,
    altScreenActive: fakeTerminal['altScreenActive'] === true,
    leftAltScreenSinceFrame: false,
    skipSyncMarkers: () => false,
    takeKeptForNextFrame: () => String(fakeTerminal['kept'] ?? ''),
    forceRedraw: vi.fn(),
  };
  const microtasks: Array<() => void> = [];
  const sandbox: Record<string, unknown> = {
    Buffer,
    Date,
    process: processHarness,
    performance: { now: () => 1 },
    queueMicrotask: (callback: () => void) => microtasks.push(callback),
    Snn: '',
    Omt: '',
    Rmt: (rows: number) => `<RESET:${rows}>`,
    Yle: scrollResetPrefix,
    j7t: () => '',
    bxs: () => '<ALT>',
    $F: '',
    FF: '',
    Yne: () => '',
    b8e: () => '',
    kEt: () => '',
    v: (error: unknown) => error && typeof error === 'object' && 'code' in error ? error.code : undefined,
    wAr: () => {},
  };
  runInNewContext(`${transformed.content}\nglobalThis.__renderNoticeFrame = onRender;`, sandbox);
  const onRender = sandbox['__renderNoticeFrame'] as (this: typeof renderer) => void;
  return {
    frame,
    notice,
    renderer,
    scrollResetPrefix,
    stdout,
    rawWrites,
    writerCalls,
    microtasks,
    render: () => onRender.call(renderer),
    replaceProcessStdout: (replacement: typeof stdout) => { processHarness.stdout = replacement; },
  };
}

it('writes a full-reset frame with one visible nonce and completes only after the tracked write', () => {
  const harness = evaluateTransformedNoticeFrame(noticeFrameSourceFixture());

  harness.render();

  expect(harness.writerCalls).toHaveLength(1);
  expect(harness.writerCalls[0]?.data).toContain('<RESET:6>');
  expect(harness.writerCalls[0]?.data).toContain(harness.notice.text);
  expect(harness.rawWrites).toEqual([]);
  expect(harness.notice.complete).not.toHaveBeenCalled();

  harness.writerCalls[0]!.complete();

  expect(harness.notice.complete).toHaveBeenCalledOnce();
  expect(harness.notice.fail).not.toHaveBeenCalled();
});

it('tracks an indented multiline notice with its scroll reset prefix in one completed buffer', () => {
  const firstRow = '  - reviewed task';
  const nextRow = '    additional context';
  const text = `${firstRow}\n${nextRow}`;
  const harness = evaluateTransformedNoticeFrame(noticeFrameSourceFixture(), {
    text, screenRows: [firstRow, nextRow], frameSink: null,
  });

  harness.render();

  expect(harness.writerCalls).toHaveLength(1);
  expect(harness.writerCalls[0]?.data.startsWith(harness.scrollResetPrefix)).toBe(true);
  expect(harness.writerCalls[0]?.data).toContain('<RESET:6>');
  expect(harness.writerCalls[0]?.data).toContain(text);
  expect(harness.notice.complete).not.toHaveBeenCalled();

  harness.writerCalls[0]!.complete();

  expect(harness.notice.complete).toHaveBeenCalledOnce();
  expect(harness.notice.fail).not.toHaveBeenCalled();
});

it.each([
  { label: 'clipped text', options: { width: 4, text: 'nonce' } },
  { label: 'a clipped multiline row', options: { text: 'first row\nsecond row', width: 10,
    screenRows: ['first row', 'second'] } },
  { label: 'duplicate screen matches', options: { screenRows: ['nonce-4f2a', 'nonce-4f2a'] } },
  { label: 'a duplicate row in a multiline notice', options: { text: 'first row\nsecond row',
    screenRows: ['first row', 'second row', 'first row', 'second row'] } },
  { label: 'a long logical row cropped outside the viewport', options: { width: 40, screenWidth: 64,
    text: 'nonce-4f2a', screenRows: [`${' '.repeat(45)}nonce-4f2a`] } },
  { label: 'mismatched screen width', options: { screenWidth: 39 } },
  { label: 'mismatched viewport width', options: { viewportWidth: 39 } },
  { label: 'no spare screen row', options: { screenHeight: 6 } },
  { label: 'kept output bytes', options: { kept: 'pending output' } },
  { label: 'a terminal image sequence', options: { imageCount: 1, imageContent: 'image payload' } },
  { label: 'non-TTY output', options: { isTTY: false, writerActive: false } },
  { label: 'an active handoff', options: { isHandedOff: true } },
  { label: 'screen reader mode', options: { isScreenReaderEnabled: true } },
  { label: 'alternate screen mode', options: { altScreenActive: true } },
  { label: 'unpatched console output', options: { patchConsole: false } },
  { label: 'inactive tracked writer', options: { writerActive: false } },
  { label: 'an active frame sink', options: { frameSink: { active: true } } },
  { label: 'a stdout mismatch', options: { optionsStdout: new EventEmitter() } },
  { label: 'a terminal stdout mismatch', options: { terminalStdout: Object.assign(new EventEmitter(), {
    write: (_data: string | Buffer) => true,
  }) } },
  { label: 'a partial patch without a reset', options: { patches: [{ type: 'stdout', content: 'nonce-4f2a' }] } },
  { label: 'an alternate-screen reset', options: { patches: [
    { type: 'clearTerminal', altScreen: true, viewportRows: 6 }, { type: 'stdout', content: 'nonce-4f2a' },
  ] } },
])('does not create a tracked writer for $label', ({ options }) => {
  const harness = evaluateTransformedNoticeFrame(noticeFrameSourceFixture(), options);

  harness.render();

  expect(harness.writerCalls).toEqual([]);
  expect(harness.notice.complete).not.toHaveBeenCalled();
});

it('fails the pending notice if the front frame changes before the tracked write completes', () => {
  const harness = evaluateTransformedNoticeFrame(noticeFrameSourceFixture());
  harness.render();
  const tracked = harness.writerCalls[0]!;
  harness.renderer.frontFrame = { ...harness.frame };

  tracked.complete();

  expect(harness.notice.complete).not.toHaveBeenCalled();
  expect(harness.notice.fail).toHaveBeenCalledOnce();
});

it('fails the pending notice if the terminal is resized before the tracked write completes', () => {
  const harness = evaluateTransformedNoticeFrame(noticeFrameSourceFixture());
  harness.render();
  const tracked = harness.writerCalls[0]!;
  harness.stdout.columns += 1;

  tracked.complete();

  expect(harness.notice.complete).not.toHaveBeenCalled();
  expect(harness.notice.fail).toHaveBeenCalledOnce();
});

it('fails the pending notice if process stdout ownership changes before the tracked write completes', () => {
  const harness = evaluateTransformedNoticeFrame(noticeFrameSourceFixture());
  harness.render();
  const tracked = harness.writerCalls[0]!;
  const replacement = Object.assign(new EventEmitter(), { columns: 40, rows: 6, isTTY: true, destroyed: false,
    write: (_data: string | Buffer) => true });
  harness.replaceProcessStdout(replacement as typeof harness.stdout);

  tracked.complete();

  expect(harness.notice.complete).not.toHaveBeenCalled();
  expect(harness.notice.fail).toHaveBeenCalledOnce();
});

it('does not release a newer notice when an older tracked frame completes', () => {
  const harness = evaluateTransformedNoticeFrame(noticeFrameSourceFixture());
  harness.render();
  const tracked = harness.writerCalls[0]!;
  const newerNotice = { text: 'new nonce', signal: new AbortController().signal,
    deadline: Date.now() + 5_000, complete: vi.fn(), fail: vi.fn() };
  harness.renderer.__lfRoutingNotice = newerNotice;

  tracked.complete();

  expect(harness.notice.complete).not.toHaveBeenCalled();
  expect(harness.notice.fail).not.toHaveBeenCalled();
  expect(harness.renderer.__lfRoutingNotice).toBe(newerNotice);
});

it('fails the notice if the tracked writer reports a write failure', () => {
  const harness = evaluateTransformedNoticeFrame(noticeFrameSourceFixture());
  harness.render();

  harness.writerCalls[0]?.fail();

  expect(harness.notice.complete).not.toHaveBeenCalled();
  expect(harness.notice.fail).toHaveBeenCalledOnce();
});

it('leaves a truncated renderer source unchanged when a required output module is missing', () => {
  const source = noticeFrameSourceFixture();
  const truncated = source.slice(0, source.indexOf('\n//#__leverframe_claude_module__:/\u0024bunfs/root/chunk-xsq68wek.js'));
  const transformed = applyRoutingNoticeFrameTransform(truncated, { enabled: true });

  expect(transformed.content).toBe(truncated);
});
