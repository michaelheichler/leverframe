export interface AnthropicWorkspace {
  id: string;
  name: string;
}

export type AnthropicWorkspaceListing =
  | { ok: true; workspaces: AnthropicWorkspace[] }
  | { ok: false; error: string };

interface WorkspaceRow {
  id?: unknown;
  name?: unknown;
  archived_at?: unknown;
}

const WORKSPACES_PATH = '/v1/organizations/workspaces?limit=100';
const TIMEOUT_MS = 10_000;

function toWorkspace(row: WorkspaceRow): AnthropicWorkspace | undefined {
  if (typeof row.id !== 'string' || !row.id.trim() || row.archived_at) return undefined;
  const name = typeof row.name === 'string' && row.name.trim() ? row.name.trim() : row.id;
  return { id: row.id.trim(), name };
}

export async function listAnthropicWorkspaces(baseUrl: string, apiKey: string): Promise<AnthropicWorkspaceListing> {
  const root = baseUrl.replace(/\/v1\/?$/, '').replace(/\/$/, '');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(`${root}${WORKSPACES_PATH}`, {
      method: 'GET',
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', Accept: 'application/json' },
      redirect: 'manual',
      signal: controller.signal,
    });
    if (!response.ok) return { ok: false, error: `HTTP ${response.status}` };
    const body = await response.json() as { data?: WorkspaceRow[] };
    const workspaces = (body.data ?? []).map(toWorkspace).filter((item): item is AnthropicWorkspace => !!item);
    return { ok: true, workspaces };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
  }
}
