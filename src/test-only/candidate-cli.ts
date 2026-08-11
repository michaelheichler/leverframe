import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import {
  CANDIDATE_ROUTE_ROWS,
  CANDIDATE_TRANSPORT_NAME,
  createCandidateProvenanceHook,
  getResolverAuditCounts,
  loadCandidateRegistryProviders,
  requestCandidateLoopback,
  startCandidateLoopbackTransport,
  writeResolverAudit,
  validateCandidateLoopbackEnvironment,
} from './candidate-loopback-transport.js';

export async function runCandidateCli(): Promise<number> {
  const startedAt = new Date().toISOString();
  const candidate = validateCandidateLoopbackEnvironment();
  if (!candidate) throw new Error('Candidate CLI requires candidate environment gates');
  const previousTestCli = process.env.LEVERFRAME_TEST_CLI;
  process.env.LEVERFRAME_TEST_CLI = '1';
  let exitCode = 0;
  let transport: Awaited<ReturnType<typeof startCandidateLoopbackTransport>> | undefined;
  const routeAudits: Array<{
    route: string;
    statusCode: number;
    requestBytes: number;
    responseBytes: number;
    requestSha256: string;
    responseSha256: string;
    outputHash: string;
    ordinal: number;
  }> = [];
  try {
    const providers = loadCandidateRegistryProviders();
    const provenance = createCandidateProvenanceHook(`${candidate.configRoot}/logs/provenance.jsonl`);
    transport = await startCandidateLoopbackTransport({ provenance });
    for (const [ordinal, row] of CANDIDATE_ROUTE_ROWS.entries()) {
      const payload = JSON.stringify({ model: row.upstreamModelId, messages: [{ role: 'user', content: `candidate:${row.modelId}` }] });
      const response = await requestCandidateLoopback(row.path, JSON.parse(payload), {
        provenance,
        provenanceRecord: {
          eventClass: 'request',
          invocationId: `candidate-${process.pid}`,
          sourcePromptId: `candidate-route-${row.modelId}`,
          route: row.path,
          byteSpan: { start: 0, end: Buffer.byteLength(payload) },
          jsonPath: '$.messages[0].content',
          inputHash: createHash('sha256').update(payload).digest('hex'),
          normalizedInputHash: createHash('sha256').update(payload).digest('hex'),
          outputHash: createHash('sha256').update(payload).digest('hex'),
          routeRowSha256: createHash('sha256').update(JSON.stringify(row)).digest('hex'),
          upstream: {
            providerId: row.providerId,
            modelId: row.modelId,
            upstreamModelId: row.upstreamModelId,
            upstreamId: row.upstreamId,
          },
          upstreamModelId: row.upstreamModelId,
          upstreamId: row.upstreamId,
          aliases: row.aliases,
          context: row.context,
          transport: row.expectedTransport,
          ordinal: ordinal * 2,
        },
      });
      const responseHash = createHash('sha256').update(response.body).digest('hex');
      if (response.statusCode !== 200) throw new Error(`Candidate route failed: ${row.path} (${response.statusCode})`);
      routeAudits.push({
        route: row.path,
        statusCode: response.statusCode,
        requestBytes: Buffer.byteLength(payload),
        responseBytes: Buffer.byteLength(response.body),
        requestSha256: createHash('sha256').update(payload).digest('hex'),
        responseSha256: responseHash,
        outputHash: responseHash,
        ordinal,
      });
    }
    process.stdout.write(`${JSON.stringify({ providers: providers.map(provider => ({ id: provider.id, models: provider.models.map(model => model.id) })) })}\n`);
  } catch (error) {
    exitCode = 1;
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  } finally {
    try {
      if (transport) await transport.close();
    } catch (error) {
      exitCode = 1;
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    }
    try {
      writeResolverAudit(candidate.resolverAuditPath, {
        schemaVersion: 1,
        processId: process.pid,
        startedAt,
        endedAt: new Date().toISOString(),
        candidateMode: true,
        testBuild: true,
        transport: CANDIDATE_TRANSPORT_NAME,
        counts: getResolverAuditCounts(),
        routes: routeAudits,
      });
    } catch (error) {
      exitCode = 1;
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    } finally {
      if (previousTestCli === undefined) delete process.env.LEVERFRAME_TEST_CLI;
      else process.env.LEVERFRAME_TEST_CLI = previousTestCli;
    }
  }
  return exitCode;
}

if (process.argv[1] && existsSync(process.argv[1])) {
  const entry = process.argv[1].replaceAll('\\', '/');
  if (import.meta.url.endsWith(entry) || import.meta.url.includes(`/dist-test/${entry.split('/').pop()}`)) {
    runCandidateCli().then(code => process.exit(code)).catch(error => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exit(1);
    });
  }
}
