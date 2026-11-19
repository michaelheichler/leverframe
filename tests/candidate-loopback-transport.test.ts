import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawn as spawnProcess, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  CANDIDATE_TEST_CREDENTIAL,
  CANDIDATE_TRANSPORT_NAME,
  CANDIDATE_ROUTE_ROWS,
  createCandidateProvenanceHook,
  getResolverAuditCounts,
  loadCandidateRegistryProviders,
  materializeCandidateFixture,
  requestCandidateLoopback,
  setCandidateProtectedOpenHook,
  startCandidateLoopbackTransport,
  strictValidateCandidateFixture,
  validateCandidateLoopbackEnvironment,
  writeResolverAudit,
} from '../src/test-only/candidate-loopback-transport.js';
import type { CandidateProvenanceRecord } from '../src/test-only/candidate-loopback-transport.js';
import type { ProviderRegistry } from '../src/registry/types.js';

function fixture(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    providers: [{
      id: 'kimi',
      templateId: 'kimi',
      name: 'Kimi',
      enabled: true,
      authRef: 'none:anonymous',
      authType: 'none',
      api: {
        npm: '@ai-sdk/openai-compatible',
        url: 'http://127.0.0.1:43721/kimi/k3',
      },
      modelsCache: {
        fetchedAt: '2026-08-10T00:00:00.000Z',
        models: [{
          id: 'k3',
          name: 'k3',
          upstreamModelId: 'k3',
          modelFormat: 'openai',
          npm: '@ai-sdk/openai-compatible',
          apiUrl: 'http://127.0.0.1:43721/kimi/k3',
          contextWindow: 1_048_576,
        }],
      },
      addedAt: '2026-08-10T00:00:00.000Z',
    }],
  };
}

function fullFixture(): Record<string, unknown> {
  const providers = new Map<string, Record<string, unknown>>();
  for (const row of CANDIDATE_ROUTE_ROWS) {
    const provider = providers.get(row.providerId) ?? {
      id: row.providerId,
      templateId: row.providerId,
      name: row.providerId,
      enabled: true,
      authRef: 'none:anonymous',
      authType: 'none',
      api: { npm: row.npm, url: `http://127.0.0.1:43721${row.path}` },
      modelsCache: {
        fetchedAt: '2026-08-10T00:00:00.000Z',
        models: [],
      },
      addedAt: '2026-08-10T00:00:00.000Z',
    };
    (provider.modelsCache as { models: unknown[] }).models.push({
      id: row.modelId,
      name: row.modelId,
      upstreamModelId: row.upstreamModelId,
      modelFormat: row.modelFormat,
      npm: row.npm,
      apiUrl: `http://127.0.0.1:43721${row.path}`,
      ...(row.context === null ? { contextWindowUnconfirmed: true } : { contextWindow: row.context }),
    });
    providers.set(row.providerId, provider);
  }
  return { schemaVersion: 1, providers: [...providers.values()] };
}

function temporaryCandidateRoot(): { home: string; appHome: string; config: string } {
  const home = mkdtempSync(join(tmpdir(), 'leverframe-candidate-'));
  const appHome = join(home, '.leverframe');
  const config = join(home, 'candidate-config');
  mkdirSync(appHome, { recursive: true });
  mkdirSync(join(config, 'logs'), { recursive: true });
  return { home, appHome, config };
}

function withCandidateEnvironment<T>(root: ReturnType<typeof temporaryCandidateRoot>, run: () => T): T {
  clearInheritedEnvs();
  vi.stubEnv('HOME', root.home);
  vi.stubEnv('CANDIDATE_HOME', root.home);
  vi.stubEnv('LEVERFRAME_HOME', root.appHome);
  vi.stubEnv('CANDIDATE_CONFIG', root.config);
  vi.stubEnv('LEVERFRAME_CANDIDATE_MODE', '1');
  vi.stubEnv('LEVERFRAME_TEST_TRANSPORT', CANDIDATE_TRANSPORT_NAME);
  vi.stubEnv('LEVERFRAME_TEST_BUILD', '1');
  return run();
}

/** Because Leverframe-launched shells export unlisted LEVERFRAME_* vars. */
function isInheritedCandidateEnv(name: string): boolean {
  return name.startsWith('LEVERFRAME_') || name.startsWith('CANDIDATE_');
}

function clearInheritedEnvs(): void {
  for (const name of Object.keys(process.env)) {
    if (/(?:api[_-]?key|auth(?:entication)?[_-]?(?:token|key)|access[_-]?token|refresh[_-]?token|secret|password|credential|cookie|bearer|oauth|keyring|ssh_auth_sock|npm[_-]?token|proxy|(?:^|[_-])(?:key|token)(?:$|[_-]))/i.test(name)
      || isInheritedCandidateEnv(name)) vi.stubEnv(name, undefined);
  }
}

describe('candidate loopback transport', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('strictly validates the sanitized anonymous fixture and all twelve route rows', () => {
    expect(strictValidateCandidateFixture(fullFixture(), { requireAllRoutes: true }).providers).toHaveLength(3);
  });

  it('keeps route metadata and transport expectations explicit for every model', () => {
    expect(CANDIDATE_ROUTE_ROWS).toHaveLength(12);
    for (const row of CANDIDATE_ROUTE_ROWS) {
      const metadata = row as unknown as Record<string, unknown>;
      expect(typeof metadata.upstreamModelId).toBe('string');
      expect(Array.isArray(metadata.aliases)).toBe(true);
      expect(Object.prototype.hasOwnProperty.call(metadata, 'context')).toBe(true);
      expect(metadata.expectedTransport).toMatchObject({
        npm: row.npm,
        modelFormat: row.modelFormat,
      });
    }
  });

  it('keeps the twelve route-row provenance hashes deterministic', () => {
    expect(CANDIDATE_ROUTE_ROWS.map(routeRowSha256)).toEqual([
      '1c6f0e7d5229c33243fdbd864cc661951a695dc6adff7b4173b8a69b51bf74ca',
      '9875bdb4ff4d933ec23486133b735ff3957f9f07292806e5b28b41e9f6f59f87',
      '872a0cd0d7de38835f5ef8a47e4869d1649a97d30f60fbff7c1867e765b90a7d',
      '8a452be3fb258496633d42be8c7a2520f5b4e7fee64bc99f69bfbf5eb65eba38',
      '11e87ddc923fe813a995ad52eeb8019c450f3cf48c99110e793efb7871ab95f4',
      '03b185e125767896a7d9a86ba133fb15bbf07335ab274565780a330d7e9a24e7',
      '5fa5f0a8a605b9b046c4b51bc975256090d6a7ae1bcc73433fc718f08ac2bff5',
      '81e81ee9586798183101b4efd84075f7a9091c60d06090aaf72a42f8965623ed',
      '985d1eff09efaf6dbf66e9f4db652166c43083391f905c82ba8326b2bbb80fc1',
      '71a6c2d69b1581bc6ad17ab2e5b668ee1e042803c1b26b68f6e959f1fa2b887a',
      '6d02ae65c4807b172dc402bf5b438a4674202c36955585cea842734028d5ab7d',
      '220560d4f339609b88e2e2b73bb463f82f7b525e0fb38587a64fd86b51d1e9f1',
    ]);
  });

  it('rejects headers, credential-shaped fields, external URLs, and wrong auth markers', () => {
    const withHeader = fixture();
    ((withHeader.providers as Record<string, unknown>[])[0]!.api as Record<string, unknown>).headers = {};
    expect(() => strictValidateCandidateFixture(withHeader)).toThrow(/headers/i);

    const withCredential = fixture();
    (withCredential.providers as Record<string, unknown>[])[0]!.credential = 'secret';
    expect(() => strictValidateCandidateFixture(withCredential)).toThrow(/credential/i);

    const withExternalUrl = fixture();
    ((withExternalUrl.providers as Record<string, unknown>[])[0]!.api as Record<string, unknown>).url = 'https://api.example.test/route';
    expect(() => strictValidateCandidateFixture(withExternalUrl)).toThrow(/loopback/i);

    const withWrongAuth = fixture();
    (withWrongAuth.providers as Record<string, unknown>[])[0]!.authRef = 'keyring:provider:kimi';
    expect(() => strictValidateCandidateFixture(withWrongAuth)).toThrow(/authRef/i);

    const withUnknownModelField = fixture();
    const model = ((withUnknownModelField.providers as Record<string, unknown>[])[0]!.modelsCache as Record<string, unknown>).models as Record<string, unknown>[];
    model[0]!.unknown = true;
    expect(() => strictValidateCandidateFixture(withUnknownModelField)).toThrow(/unsupported key/i);

    const withBadCost = fixture();
    const badCostModel = (((withBadCost.providers as Record<string, unknown>[])[0]!.modelsCache as Record<string, unknown>).models as Record<string, unknown>[])[0]!;
    badCostModel.cost = { input: 1, unexpected: 2 };
    expect(() => strictValidateCandidateFixture(withBadCost)).toThrow(/cost/i);
  });

  it('rejects every incomplete candidate gate before registry or resolver work', async () => {
    const root = temporaryCandidateRoot();
    writeFileSync(join(root.appHome, 'providers.json'), JSON.stringify(fixture()));
    const base = {
      HOME: root.home,
      CANDIDATE_HOME: root.home,
      LEVERFRAME_HOME: root.appHome,
      CANDIDATE_CONFIG: root.config,
      LEVERFRAME_CANDIDATE_MODE: '1',
      LEVERFRAME_TEST_TRANSPORT: CANDIDATE_TRANSPORT_NAME,
      LEVERFRAME_TEST_BUILD: '1',
    };
    for (const missing of ['LEVERFRAME_CANDIDATE_MODE', 'LEVERFRAME_TEST_TRANSPORT', 'LEVERFRAME_TEST_BUILD']) {
      const env = { ...base };
      delete env[missing as keyof typeof env];
      expect(() => validateCandidateLoopbackEnvironment(env)).toThrow(/candidate|transport|test build/i);
    }
  });

  it('hard-fails direct candidate exports when the complete gate is absent', async () => {
    const root = temporaryCandidateRoot();
    const env = candidateEnvironment(root);
    delete env.LEVERFRAME_CANDIDATE_MODE;
    clearInheritedEnvs();
    for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
    const candidateModeGateError = new Error('Candidate mode requires LEVERFRAME_CANDIDATE_MODE=1');
    expect(() => materializeCandidateFixture(fullFixture() as unknown as ProviderRegistry, (registry, key) => {
      void registry;
      void key;
      return [];
    })).toThrowError(candidateModeGateError);
    await expect(startCandidateLoopbackTransport()).rejects.toThrowError(candidateModeGateError);
    await expect(requestCandidateLoopback('/kimi/k3', { model: 'k3' })).rejects.toThrowError(candidateModeGateError);
  });

  it('rejects inherited credential variables even when candidate controls are valid', () => {
    const root = temporaryCandidateRoot();
    writeFileSync(join(root.appHome, 'providers.json'), JSON.stringify(fixture()));
    const env = candidateEnvironment(root, { OPENAI_API_KEY: 'inherited-dummy' });
    expect(() => validateCandidateLoopbackEnvironment(env)).toThrow(/credential|allowlist/i);
  });

  it('rejects a real HOME and the ordinary production build', () => {
    const root = temporaryCandidateRoot();
    writeFileSync(join(root.appHome, 'providers.json'), JSON.stringify(fixture()));
    const env = {
      HOME: `${root.home}-real`,
      CANDIDATE_HOME: root.home,
      LEVERFRAME_HOME: root.appHome,
      CANDIDATE_CONFIG: root.config,
      LEVERFRAME_CANDIDATE_MODE: '1',
      LEVERFRAME_TEST_TRANSPORT: CANDIDATE_TRANSPORT_NAME,
      LEVERFRAME_TEST_BUILD: '1',
    };
    expect(() => validateCandidateLoopbackEnvironment(env)).toThrow(/HOME/);
    expect(() => validateCandidateLoopbackEnvironment({ ...env, HOME: root.home, LEVERFRAME_PRODUCTION_BUILD: '1' })).toThrow(/production build/i);
  });

  it('leaves the production build flag unchanged after main returns', async () => {
    vi.stubEnv('LEVERFRAME_PRODUCTION_BUILD', 'before');
    const { main } = await import('../src/cli.js');
    await expect(main(['--version'])).resolves.toBe(0);
    expect(process.env.LEVERFRAME_PRODUCTION_BUILD).toBe('before');
    vi.stubEnv('LEVERFRAME_PRODUCTION_BUILD', undefined);
    await expect(main(['--version'])).resolves.toBe(0);
    expect(process.env.LEVERFRAME_PRODUCTION_BUILD).toBeUndefined();
  });

  it('materializes all candidate routes with the constant credential and zero resolver calls', async () => {
    const root = temporaryCandidateRoot();
    writeFileSync(join(root.appHome, 'providers.json'), JSON.stringify(fullFixture()));
    clearInheritedEnvs();
    vi.stubEnv('HOME', root.home);
    vi.stubEnv('CANDIDATE_HOME', root.home);
    vi.stubEnv('LEVERFRAME_HOME', root.appHome);
    vi.stubEnv('CANDIDATE_CONFIG', root.config);
    vi.stubEnv('LEVERFRAME_CANDIDATE_MODE', '1');
    vi.stubEnv('LEVERFRAME_TEST_TRANSPORT', CANDIDATE_TRANSPORT_NAME);
    vi.stubEnv('LEVERFRAME_TEST_BUILD', '1');

    const providers = loadCandidateRegistryProviders();
    expect(providers.flatMap(provider => provider.models)).toHaveLength(12);
    expect(providers.every(provider => provider.apiKey === CANDIDATE_TEST_CREDENTIAL)).toBe(true);
    expect(getResolverAuditCounts()).toEqual({
      resolveProviderCredentialCalls: 0,
      resolveProviderOAuthAccountIdCalls: 0,
      resolveProviderOAuthProviderDataCalls: 0,
    });
  });

  it('persists the child resolver audit with zero counts and private mode', async () => {
    const root = temporaryCandidateRoot();
    writeFileSync(join(root.appHome, 'providers.json'), JSON.stringify(fullFixture()));
    clearInheritedEnvs();
    vi.stubEnv('HOME', root.home);
    vi.stubEnv('CANDIDATE_HOME', root.home);
    vi.stubEnv('LEVERFRAME_HOME', root.appHome);
    vi.stubEnv('CANDIDATE_CONFIG', root.config);
    vi.stubEnv('LEVERFRAME_CANDIDATE_MODE', '1');
    vi.stubEnv('LEVERFRAME_TEST_TRANSPORT', CANDIDATE_TRANSPORT_NAME);
    vi.stubEnv('LEVERFRAME_TEST_BUILD', '1');
    const { runCandidateCli } = await import('../src/test-only/candidate-cli.js');
    await expect(runCandidateCli()).resolves.toBe(0);
    const auditPath = join(root.config, 'logs', 'resolver-audit.json');
    const audit = JSON.parse(readFileSync(auditPath, 'utf8')) as Record<string, unknown>;
    expect(audit.schemaVersion).toBe(1);
    expect(audit.candidateMode).toBe(true);
    expect(audit.testBuild).toBe(true);
    expect(audit.transport).toBe(CANDIDATE_TRANSPORT_NAME);
    expect(audit.counts).toEqual({
      resolveProviderCredentialCalls: 0,
      resolveProviderOAuthAccountIdCalls: 0,
      resolveProviderOAuthProviderDataCalls: 0,
    });
    expect(audit.routes).toHaveLength(12);
    for (const route of audit.routes as Array<Record<string, unknown>>) {
      expect(route.statusCode).toBe(200);
      for (const field of ['requestSha256', 'responseSha256', 'outputHash']) expect(route[field]).toMatch(/^[a-f0-9]{64}$/);
    }
    expect(typeof audit.auditSha256).toBe('string');
    expect(statSync(auditPath).mode & 0o777).toBe(0o600);
    expect(getResolverAuditCounts()).toEqual({
      resolveProviderCredentialCalls: 0,
      resolveProviderOAuthAccountIdCalls: 0,
      resolveProviderOAuthProviderDataCalls: 0,
    });
  });

  it('writes provenance before transport and never adds tags to the request body', async () => {
    const root = temporaryCandidateRoot();
    const sidecar = join(root.config, 'provenance.jsonl');
    const hook = createCandidateProvenanceHook(sidecar);
    const transport = await withCandidateEnvironment(root, () => startCandidateLoopbackTransport({
      provenance: hook,
    }));
    try {
      const marker = {
        eventClass: 'request' as const,
        invocationId: 'invocation-1',
        sourcePromptId: 'prompt-1',
        route: '/kimi/k3',
        byteSpan: { start: 0, end: 16 },
        jsonPath: '$.model',
        inputHash: '1'.repeat(64),
        normalizedInputHash: '2'.repeat(64),
        outputHash: '3'.repeat(64),
        routeRowSha256: routeRowSha256(CANDIDATE_ROUTE_ROWS[0]!),
        upstream: { providerId: 'kimi', modelId: 'k3', upstreamModelId: 'k3', upstreamId: 'k3' },
        upstreamModelId: 'k3',
        upstreamId: 'k3',
        aliases: ['kimi3'],
        context: 1_048_576,
        transport: CANDIDATE_ROUTE_ROWS[0]!.expectedTransport,
        ordinal: 0,
      };
      const response = await requestCandidateLoopback('/kimi/k3', { model: 'k3' }, { provenance: hook, provenanceRecord: marker });
      expect(response.statusCode).toBe(200);
      const records = readFileSync(sidecar, 'utf8').trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>);
      expect(records[0]).toMatchObject({ invocationId: 'invocation-1', eventClass: 'request', routeRowSha256: routeRowSha256(CANDIDATE_ROUTE_ROWS[0]!) });
      expect(records[1]).toMatchObject({ eventClass: 'response', outputHash: createHash('sha256').update(response.body).digest('hex') });
      expect(response.body).not.toContain('sourcePromptId');
    } finally {
      await transport.close();
    }
  });

  it('persists typed provenance fields with a stable ordinal and route metadata', async () => {
    const root = temporaryCandidateRoot();
    const sidecar = join(root.config, 'provenance.jsonl');
    const hook = createCandidateProvenanceHook(sidecar);
    const record = {
      eventClass: 'request' as const,
      invocationId: 'invocation-typed',
      sourcePromptId: 'prompt-typed',
      route: '/kimi/k3/chat/completions',
      byteSpan: { start: 0, end: 42 },
      jsonPath: '$.messages[0].content',
      inputHash: '1'.repeat(64),
      normalizedInputHash: '2'.repeat(64),
      outputHash: '3'.repeat(64),
      routeRowSha256: routeRowSha256(CANDIDATE_ROUTE_ROWS[0]!),
      upstream: { providerId: 'kimi', modelId: 'k3', upstreamModelId: 'k3', upstreamId: 'k3' },
      upstreamModelId: 'k3',
      upstreamId: 'k3',
      aliases: ['kimi3'],
      context: 1_048_576,
      transport: CANDIDATE_ROUTE_ROWS[0]!.expectedTransport,
      ordinal: 0,
    };
    const transport = await withCandidateEnvironment(root, () => startCandidateLoopbackTransport());
    try {
      await requestCandidateLoopback('/kimi/k3', { model: 'k3' }, { provenance: hook, provenanceRecord: record });
      const persisted = JSON.parse(readFileSync(sidecar, 'utf8').split('\n')[0]!) as Record<string, unknown>;
      expect(persisted).toMatchObject(record);
    } finally {
      await transport.close();
    }
  });

  it('rejects malformed provenance paths, short hashes, and non-sequential ordinals', async () => {
    const root = temporaryCandidateRoot();
    const hook = createCandidateProvenanceHook(join(root.config, 'provenance.jsonl'));
    withCandidateEnvironment(root, () => undefined);
    const base = provenanceRecord(0);
    await expect(hook.beforeTransport({ ...base, jsonPath: '$.messages..content' })).rejects.toThrow(/JSON path/i);
    await expect(hook.beforeTransport({ ...base, inputHash: 'a'.repeat(63) })).rejects.toThrow(/64|hash/i);
    await expect(hook.beforeTransport({ ...base, ordinal: 1 })).rejects.toThrow(/ordinal/i);
  });

  it('continues provenance ordinals across hook instances for one sidecar', async () => {
    const root = temporaryCandidateRoot();
    const sidecar = join(root.config, 'provenance.jsonl');
    const first = createCandidateProvenanceHook(sidecar);
    withCandidateEnvironment(root, () => undefined);
    await first.beforeTransport(provenanceRecord(0));
    const second = createCandidateProvenanceHook(sidecar);
    await expect(second.beforeTransport(provenanceRecord(1))).resolves.toBe(1);
  });

  it('rejects existing audit and provenance symlinks', async () => {
    const root = temporaryCandidateRoot();
    writeFileSync(join(root.appHome, 'providers.json'), JSON.stringify(fullFixture()));
    withCandidateEnvironment(root, () => undefined);
    const outside = join(root.home, 'outside.json');
    writeFileSync(outside, 'outside');
    const auditPath = join(root.config, 'logs', 'resolver-audit.json');
    const provenancePath = join(root.config, 'provenance.jsonl');
    symlinkSync(outside, auditPath);
    symlinkSync(outside, provenancePath);
    const { writeResolverAudit } = await import('../src/test-only/candidate-loopback-transport.js');
    expect(() => writeResolverAudit(auditPath, {
      schemaVersion: 1,
      processId: process.pid,
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
      candidateMode: true,
      testBuild: true,
      transport: CANDIDATE_TRANSPORT_NAME,
      counts: getResolverAuditCounts(),
    })).toThrow(/symlink|regular|audit/i);
    const hook = createCandidateProvenanceHook(provenancePath);
    await expect(hook.beforeTransport(provenanceRecord(0))).rejects.toThrow(/symlink|regular|provenance/i);
  });

  it('does not follow an audit path swapped after the protected descriptor opens', () => {
    const root = temporaryCandidateRoot();
    withCandidateEnvironment(root, () => undefined);
    const realConfig = realpathSync.native(root.config);
    const auditPath = join(realConfig, 'logs', 'resolver-audit.json');
    const movedPath = join(realConfig, 'logs', 'resolver-audit-held.json');
    const outsidePath = join(root.home, 'outside-audit.json');
    writeFileSync(outsidePath, 'outside', { mode: 0o644 });
    let swapped = false;
    setCandidateProtectedOpenHook(openedPath => {
      if (openedPath === auditPath) {
        renameSync(auditPath, movedPath);
        symlinkSync(outsidePath, auditPath);
        swapped = true;
      }
    });
    try {
      writeResolverAudit(auditPath, {
        schemaVersion: 1,
        processId: process.pid,
        startedAt: new Date().toISOString(),
        endedAt: new Date().toISOString(),
        candidateMode: true,
        testBuild: true,
        transport: CANDIDATE_TRANSPORT_NAME,
        counts: getResolverAuditCounts(),
      });
      expect(swapped).toBe(true);
      expect(statSync(outsidePath).mode & 0o777).toBe(0o644);
    } finally {
      setCandidateProtectedOpenHook(undefined);
    }
  });

  it('serializes provenance ordinals across concurrent writer processes', { timeout: 20_000 }, async () => {
    const root = temporaryCandidateRoot();
    const sidecar = join(realpathSync.native(root.config), 'provenance.jsonl');
    const workerMarker = join(root.config, '.candidate-provenance-worker.json');
    writeFileSync(workerMarker, JSON.stringify(provenanceRecord(0)), { mode: 0o600 });
    const spawn = () => new Promise<{ code: number | null; stderr: string }>((resolve) => {
      const child = spawnProcess(process.execPath, [join(process.cwd(), 'node_modules/vitest/vitest.mjs'), 'run', 'tests/candidate-provenance-worker.test.ts'], {
        env: { ...candidateEnvironment(root), TMPDIR: dirname(root.home) },
        stdio: ['ignore', 'pipe', 'pipe'],
      }) as ChildProcess;
      let stderr = '';
      child.stderr?.setEncoding('utf8');
      child.stderr?.on('data', chunk => { stderr += chunk; });
      child.on('close', code => {
        resolve({ code, stderr });
      });
    });
    const results = await Promise.all([spawn(), spawn()]);
    expect(results.map(result => result.code), results.map(result => result.stderr).join('\n')).toEqual([0, 0]);
    const records = readFileSync(sidecar, 'utf8').trim().split('\n').map(line => JSON.parse(line) as { ordinal: number });
    expect(records.map(record => record.ordinal).sort((left, right) => left - right)).toEqual([0, 1]);
  });

  it('restores changed globals after candidate failure', async () => {
    const root = temporaryCandidateRoot();
    writeFileSync(join(root.appHome, 'providers.json'), JSON.stringify(fullFixture()));
    withCandidateEnvironment(root, () => undefined);
    const blocker = createServer((_req, res) => res.end()).listen(43721, '127.0.0.1');
    const previous = process.env.LEVERFRAME_TEST_CLI;
    process.env.LEVERFRAME_TEST_CLI = 'before';
    try {
      const { runCandidateCli } = await import('../src/test-only/candidate-cli.js');
      let diagnostic = '';
      const stderrWrite = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
        diagnostic += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString();
        return true;
      });
      try {
        await expect(runCandidateCli()).resolves.toBe(1);
      } finally {
        stderrWrite.mockRestore();
      }
      expect(diagnostic).toBe('Candidate transport could not bind 127.0.0.1:43721\n');
      expect(process.env.LEVERFRAME_TEST_CLI).toBe('before');
      expect(getResolverAuditCounts()).toEqual({
        resolveProviderCredentialCalls: 0,
        resolveProviderOAuthAccountIdCalls: 0,
        resolveProviderOAuthProviderDataCalls: 0,
      });
    } finally {
      blocker.close();
      if (previous === undefined) delete process.env.LEVERFRAME_TEST_CLI;
      else process.env.LEVERFRAME_TEST_CLI = previous;
    }
  });

  it('fails closed when either fixed listener port is already occupied', async () => {
    const root = temporaryCandidateRoot();
    const first = await withCandidateEnvironment(root, () => startCandidateLoopbackTransport());
    try {
      await expect(startCandidateLoopbackTransport()).rejects.toThrow(/4372[01]/);
    } finally {
      await first.close();
    }
  });

  it('serves every configured route row through the fixed loopback ingress', async () => {
    const root = temporaryCandidateRoot();
    const transport = await withCandidateEnvironment(root, () => startCandidateLoopbackTransport());
    try {
      for (const row of CANDIDATE_ROUTE_ROWS) {
        const response = await requestCandidateLoopback(row.path, { model: row.modelId });
        expect(response.statusCode).toBe(200);
        expect(JSON.parse(response.body).model).toBe(row.modelId);
      }
    } finally {
      await transport.close();
    }
  });
});

function candidateEnvironment(root: ReturnType<typeof temporaryCandidateRoot>, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    HOME: root.home,
    CANDIDATE_HOME: root.home,
    LEVERFRAME_HOME: root.appHome,
    CANDIDATE_CONFIG: root.config,
    LEVERFRAME_CANDIDATE_MODE: '1',
    LEVERFRAME_TEST_TRANSPORT: CANDIDATE_TRANSPORT_NAME,
    LEVERFRAME_TEST_BUILD: '1',
    ...extra,
  };
}

function provenanceRecord(ordinal: number): CandidateProvenanceRecord {
  return {
    eventClass: 'request',
    invocationId: 'invocation-test',
    sourcePromptId: 'prompt-test',
    route: '/kimi/k3/chat/completions',
    byteSpan: { start: 0, end: 1 },
    jsonPath: '$.model',
    inputHash: '1'.repeat(64),
    normalizedInputHash: '2'.repeat(64),
    outputHash: '3'.repeat(64),
    routeRowSha256: routeRowSha256(CANDIDATE_ROUTE_ROWS[0]!),
    upstream: { providerId: 'kimi', modelId: 'k3', upstreamModelId: 'k3', upstreamId: 'k3' },
    upstreamModelId: 'k3',
    upstreamId: 'k3',
    aliases: ['kimi3'],
    context: 1_048_576,
    transport: CANDIDATE_ROUTE_ROWS[0]!.expectedTransport,
    ordinal,
  };
}

function routeRowSha256(row: (typeof CANDIDATE_ROUTE_ROWS)[number]): string {
  return createHash('sha256').update(JSON.stringify(row)).digest('hex');
}
