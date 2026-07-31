// Adapters share this path because downstream status mapping depends on identical metadata preservation.

/** Wraps only primitives because provider error objects carry status and retry metadata. */
export function toUpstreamStreamError(error: unknown): Error | object {
  return error instanceof Error || (error !== null && typeof error === 'object')
    ? error
    : new Error(typeof error === 'string' ? error : 'Upstream stream failed');
}
