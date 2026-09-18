/**
 * One JSON snapshot endpoint (a local proxy route) as a layer feed. The
 * status stays authoritative: a non-JSON body on a 200 is still a malformed
 * snapshot, and a JSON error body on a 5xx is still a failure.
 */
export function createJsonSnapshotSource({
  url,
  label = 'Snapshot',
  fetchImpl = (...args) => globalThis.fetch(...args),
} = {}) {
  if (typeof url !== 'string' || !url)
    throw new TypeError('A snapshot URL is required');
  return {
    async getSnapshot({ signal } = {}) {
      signal?.throwIfAborted();
      const response = await fetchImpl(url, { signal, cache: 'no-store' });
      let payload = null;
      try {
        payload = await response.json();
      } catch {
        /* status below remains authoritative */
      }
      signal?.throwIfAborted();
      if (!response.ok) throw new Error(`${label} HTTP ${response.status}`);
      if (!payload || typeof payload !== 'object')
        throw new Error(`Malformed ${label} snapshot`);
      return payload;
    },
  };
}
