import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { filterTrailing24h } from './firmsCsv.js';
import { filterByBiome, parseInpeCsv } from './inpeCsv.js';

// Same technique as firmsProxy.test.mjs: exercise the production refresh
// without opening a server, injecting only its upstream, clock, filters and
// console so the aggregation and source-status code stay intact.
const config = fs.readFileSync(new URL('../../server/providers/inpe.js', import.meta.url), 'utf8');
const start = config.indexOf('  async function refreshUpstream(biomes) {');
assert.notEqual(start, -1, 'INPE refresh function exists');
const end = config.indexOf('\n  }', start);
assert.notEqual(end, -1, 'INPE refresh function closes');
const refreshSource = config.slice(start, end + 4);
const NOW = Date.UTC(2026, 8, 18, 5, 15);
const SOURCES = ['focos_diario_br_20260917.csv', 'focos_diario_br_20260918.csv'];
const HEADER =
  'id,lat,lon,data_hora_gmt,satelite,municipio,estado,pais,municipio_id,estado_id,pais_id,numero_dias_sem_chuva,precipitacao,risco_fogo,bioma,frp\n';
const row = (when, biome, frp = '10') =>
  `x, -5.0, -60.0,${when},GOES-19,MANAUS,AMAZONAS,Brasil,1,13,33,,,,${biome},${frp}\n`;

function createRefresh(fetchSource) {
  return new Function(
    'dailySources', 'fetchSource', 'filterByBiome', 'filterTrailing24h', 'Date', 'console',
    `return (${refreshSource});`,
  )(() => SOURCES, fetchSource, filterByBiome, filterTrailing24h, { now: () => NOW }, { warn() {} });
}

test('INPE fetches both daily files in order and keeps only fresh Amazon rows', async () => {
  const calls = [];
  let active = 0;
  const refresh = createRefresh(async (source) => {
    assert.equal(active++, 0, 'daily files must be fetched sequentially');
    calls.push(source);
    await Promise.resolve();
    active--;
    if (source === SOURCES[0]) {
      return parseInpeCsv(
        HEADER +
          row('2026-09-17 04:00:00', 'Amazônia') + // >24 h old → dropped
          row('2026-09-17 06:00:00', 'Amazônia', '55') + // inside window
          row('2026-09-17 12:00:00', 'Cerrado'), // wrong biome → dropped
      );
    }
    return parseInpeCsv(HEADER + row('2026-09-18 04:50:00', 'Amazônia', '70'));
  });
  const result = await refresh(['Amazônia']);
  assert.deepEqual(calls, SOURCES);
  assert.deepEqual(result.fires.map((fire) => fire.frp), [55, 70]);
  assert.deepEqual(result.biomes, ['Amazônia']);
  assert.deepEqual(result.sources, [
    { source: SOURCES[0], count: 1, ok: true },
    { source: SOURCES[1], count: 1, ok: true },
  ]);
  assert.equal(result.at, NOW);
});

test("INPE keeps yesterday when today's file is not published yet", async () => {
  const result = await createRefresh(async (source) => {
    if (source === SOURCES[1]) throw new Error('HTTP 404');
    return parseInpeCsv(HEADER + row('2026-09-17 06:00:00', 'Amazônia'));
  })(['Amazônia']);
  assert.equal(result.fires.length, 1);
  assert.deepEqual(result.sources, [
    { source: SOURCES[0], count: 1, ok: true },
    { source: SOURCES[1], count: 0, ok: false },
  ]);
});

test('INPE distinguishes all-source failure from successful empty files', async () => {
  await assert.rejects(
    createRefresh(async () => { throw new Error('upstream unavailable'); })(['Amazônia']),
    /all INPE sources failed/,
  );
  const result = await createRefresh(async () => [])(null);
  assert.deepEqual(result.fires, []);
  assert.equal(result.biomes, null, 'null biomes = every biome, recorded on the entry');
  assert.deepEqual(result.sources, SOURCES.map((source) => ({ source, count: 0, ok: true })));
});

test('INPE keeps large days intact (no argument-spread append)', async () => {
  const many = parseInpeCsv(HEADER + row('2026-09-18 04:00:00', 'Amazônia').repeat(150_000));
  const result = await createRefresh(async (source) => (source === SOURCES[1] ? many : []))(['Amazônia']);
  assert.equal(result.fires.length, 150_000);
  assert.equal(result.fires[0], many[0]);
  assert.equal(result.fires.at(-1), many.at(-1));
});
