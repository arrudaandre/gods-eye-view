/**
 * Construct a live-fire snapshot endpoint without making a request. The
 * INPE proxy answers with the same `{fetchedAt, stale, fires}` contract as
 * /api/firms, so one source factory serves both feeds — `url` picks the
 * proxy and `label` names it in errors.
 */
export function createFirmsSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
  url = '/api/firms',
  label = 'FIRMS',
} = {}) {
  return {
    async getSnapshot({ signal } = {}) {
      signal?.throwIfAborted();
      const response = await fetchImpl(url, {
        signal,
        cache: 'no-store',
      });
      let payload;
      try {
        payload = await response.json();
      } catch {
        /* status below remains authoritative */
      }
      signal?.throwIfAborted();
      if (!response.ok) {
        if (response.status === 503 && payload?.error === 'no_key')
          return { keyRequired: true };
        throw new Error(`${label} HTTP ${response.status}`);
      }
      if (!Array.isArray(payload?.fires))
        throw new Error('Malformed fire snapshot');
      return payload;
    },
  };
}
