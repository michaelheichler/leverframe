import { runInNewContext } from 'node:vm';
import { expect, it } from 'vitest';
import { applyRoutingSidecarTransform } from '../src/patch-transforms-routing-sidecar.js';
import { CLAUDE_AGENT_2_1_314_SIDECAR_SOURCE } from './fixtures/claude-agent-2.1.314-sidecar.js';

const sourcedSidecar = CLAUDE_AGENT_2_1_314_SIDECAR_SOURCE;
const firstWriteAnchor = 'async function launchSidecar(){';

function transformedSidecar() {
  return applyRoutingSidecarTransform(sourcedSidecar, { enabled: true });
}

function sandboxFor(store: { write: (path: string, value: string) => Promise<{ ok: boolean; error?: Error }> },
  written: Map<string, unknown>, mirrored: Array<Record<string, unknown>>, initialMetadata?: Record<string, unknown>) {
  const imported = transformedSidecar();
  const source = imported.content.replace(/import\{[^}]+\}from"[^"]+";/g, '');
  const recordWrite = async (path: string, value: string) => {
    const result = await store.write(path, value);
    if (result.ok) written.set(path, JSON.parse(value) as unknown);
    return result;
  };
  const storageV5 = { read: async () => ({ ok: true, value: { items: [{ found: false }] } }), write: recordWrite };
  const harness = `
    var G9s, lPt, Se='agent-fixture.jsonl', sn=false, r={storageV5},
      e={agentType:'worker'}, Yl=()=>false, GA='fork', Y, Ie, db=()=>false, Me, fe=false,
      zt, Ve, ze, Re, Ue, w, Q, Z, b='foreground', qt={}, Rn={isNonInteractiveSession:false}, Tf=()=>1,
      __lfBinding='opaque-routing-binding';
    var rQo=64, HR=(value)=>value, pN=()=>undefined, wi=[], uze=/./, HF=()=>true,
      vrs=/./, JS='plan', Qd=error=>{throw error};
    var dtt=async()=>globalThis.initialMetadata??null, q=()=>true, g8e=path=>path, _=value=>JSON.stringify(value),
      b0=()=>{}, kD=async()=>{}, ak=path=>path, Un=async()=>{}, ED=()=> 'agent-fixture.meta.json',
      process={umask:()=>0}, JV=async(_key,write)=>write(), ia=value=>value, z=()=> 'fixture-lock', am=path=>path;
    var mirrorSink={fireMirror:(_path,events)=>mirrored.push(...events), keepsAgentMetadataInStream:()=>true,
      mirrorWorkerEvent:async(_type,event)=>{mirrored.push(event);return true}};
    var Ha=()=>mirrorSink, p=()=>{}, g=()=>{}, t=message=>mirrored.push({error:String(message)}), kA=error=>String(error);
    ${source}
  `;
  return { imported, context: { code: harness, storageV5, initialMetadata, mirrored }, written, mirrored };
}

function invokeSourced(source: string, globals: Record<string, unknown> = {}) {
  const sandbox = { ...globals };
  return { promise: runInNewContext(source, sandbox) as Promise<unknown>, sandbox };
}

it('waits for bound sidecar persistence before child inference proceeds', async () => {
  let releaseWrite!: (result: { ok: boolean }) => void;
  let signalWrite!: () => void;
  const writeGate = new Promise<{ ok: boolean }>(resolve => { releaseWrite = resolve; });
  const writeStarted = new Promise<void>(resolve => { signalWrite = resolve; });
  const written = new Map<string, unknown>();
  const mirrored: Array<Record<string, unknown>> = [];
  const service = sandboxFor({ write: async () => { signalWrite(); return writeGate; } }, written, mirrored);
  expect(service.imported.results[0]?.status).toBe('OK');
  const launch = invokeSourced(`(async()=>{${service.context.code};await launchSidecar()})()`,
    { storageV5: service.context.storageV5, mirrored });
  await writeStarted;

  expect(launch.sandbox.launchReachedAfterSidecar).toBeUndefined();
  releaseWrite({ ok: true });
  await launch.promise;
  expect(launch.sandbox.launchReachedAfterSidecar).toBe(true);
  expect(written.get('agent-fixture.meta.json')).toMatchObject({ leverframeRoutingBinding: 'opaque-routing-binding' });
});

it('keeps a bound launch from reaching inference when sidecar persistence fails', async () => {
  const written = new Map<string, unknown>();
  const mirrored: Array<Record<string, unknown>> = [];
  const service = sandboxFor({ write: async () => ({ ok: false, error: new Error('isolated write failure') }) }, written, mirrored);
  expect(service.imported.results[0]?.status).toBe('OK');
  const launch = invokeSourced(`(async()=>{${service.context.code};await launchSidecar()})()`,
    { storageV5: service.context.storageV5, mirrored });

  await expect(launch.promise).rejects.toThrow();
  expect(launch.sandbox.launchReachedAfterSidecar).toBeUndefined();
});

it('preserves a binding through metadata rewrite and stream mirror projection', async () => {
  const written = new Map<string, unknown>();
  const mirrored: Array<Record<string, unknown>> = [];
  const service = sandboxFor({ write: async () => ({ ok: true }) }, written, mirrored,
    { agentType: 'worker', leverframeRoutingBinding: 'opaque-routing-binding' });
  expect(service.imported.results[0]?.status).toBe('OK');
  const callStart = service.context.code.indexOf(firstWriteAnchor);
  const functionsOnly = service.context.code.slice(0, callStart);
  const rewrite = `${functionsOnly}\n;(async()=>sMt('agent-fixture.meta.json',{agentType:'worker',isBuiltIn:true},'session-fixture',storageV5))()`;
  await invokeSourced(rewrite, { storageV5: service.context.storageV5,
    initialMetadata: service.context.initialMetadata, mirrored }).promise;

  expect(written.get('agent-fixture.meta.json')).toMatchObject({ agentType: 'worker', leverframeRoutingBinding: 'opaque-routing-binding' });
  expect(mirrored[0]).toMatchObject({ type: 'agent_metadata', leverframeRoutingBinding: 'opaque-routing-binding' });
});

it('restores the binding from the sourced stream projection into durable metadata', async () => {
  const written = new Map<string, unknown>();
  const mirrored: Array<Record<string, unknown>> = [];
  const service = sandboxFor({ write: async () => ({ ok: true }) }, written, mirrored);
  expect(service.imported.results[0]?.status).toBe('OK');
  const callStart = service.context.code.indexOf(firstWriteAnchor);
  const functionsOnly = service.context.code.slice(0, callStart);
  const hydrate = `${functionsOnly}\n;(async()=>d7n('restored-agent.meta.json',{agentType:'worker',leverframeRoutingBinding:'opaque-routing-binding'},storageV5))()`;
  const result = await invokeSourced(hydrate, { storageV5: service.context.storageV5, mirrored }).promise;

  expect(result, JSON.stringify(mirrored)).toBe('restored');
  expect(written.get('restored-agent.meta.json')).toMatchObject({ agentType: 'worker', leverframeRoutingBinding: 'opaque-routing-binding' });
});
