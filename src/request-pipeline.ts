import type { IncomingMessage, ServerResponse } from 'node:http';
import type { RequestExecutionContext } from './request-execution-context.js';

export interface ClientDisconnectAbort {
  controller: AbortController;
  detach: () => void;
}

export function wireClientDisconnectAbort(req: IncomingMessage, res: ServerResponse): ClientDisconnectAbort {
  const clientAbort = new AbortController();
  const abort = () => {
    if (!clientAbort.signal.aborted) {
      clientAbort.abort(new DOMException('Client disconnected', 'AbortError'));
    }
  };
  const onClose = () => {
    if (!res.writableFinished) abort();
  };
  req.once('aborted', abort);
  res.once('close', onClose);
  return {
    controller: clientAbort,
    detach: () => {
      req.removeListener('aborted', abort);
      res.removeListener('close', onClose);
    },
  };
}

export function attachRequestExecutionDisposal(
  res: ServerResponse,
  requestExecution: RequestExecutionContext,
): void {
  res.once('finish', () => requestExecution.dispose());
  res.once('close', () => requestExecution.dispose());
}
