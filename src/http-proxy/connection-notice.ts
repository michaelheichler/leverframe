export const CONNECTION_NOTICE_INTERVAL_MS = 30_000;

export function createConnectionNotice(message: string): () => void {
  let nextNoticeAt = Number.NEGATIVE_INFINITY;
  return () => {
    const now = Date.now();
    if (now < nextNoticeAt) return;
    nextNoticeAt = now + CONNECTION_NOTICE_INTERVAL_MS;
    process.stderr.write(`${message}\n`);
  };
}
