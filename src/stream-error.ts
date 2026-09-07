

export function toUpstreamStreamError(error: unknown): Error | object {
  return error instanceof Error || (error !== null && typeof error === 'object')
    ? error
    : new Error(typeof error === 'string' ? error : 'Upstream stream failed');
}
