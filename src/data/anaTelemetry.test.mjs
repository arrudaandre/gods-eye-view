import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ANA_STATIONS,
  DEFAULT_ANA_STATION_CODES,
  anaDate,
  anaTelemetryUrl,
  bucketLevels,
  gaugeAnalystRecord,
  gaugeCardCopy,
  gaugeLevelLine,
  knownStation,
  parseAnaDateTime,
  parseAnaTelemetryXml,
  parseStationCodes,
  sparklineString,
  summarizeReadings,
} from './anaTelemetry.js';

const HOUR = 3600_000;

function row(at, level, rain = '0.0', flow = '') {
  const d = new Date(at);
  const stamp = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')} ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}:00 `;
  return `<DadosHidrometereologicos diffgr:id="x" msdata:rowOrder="0"><CodEstacao>14990000</CodEstacao><DataHora>${stamp}</DataHora><Vazao>${flow}</Vazao><Nivel>${level}</Nivel><Chuva>${rain}</Chuva></DadosHidrometereologicos>`;
}

function dataset(rows) {
  return `<?xml version="1.0" encoding="utf-8"?><DataTable xmlns="http://MRCS/"><xs:schema id="NewDataSet"></xs:schema><diffgr:diffgram><DocumentElement xmlns="">${rows.join('')}</DocumentElement></diffgr:diffgram></DataTable>`;
}

test('station table and code parsing stay bounded and known', () => {
  assert.equal(knownStation('14990000').name, 'Manaus');
  assert.equal(knownStation('00000000'), null);
  assert.equal(
    new Set(ANA_STATIONS.map((s) => s.code)).size,
    ANA_STATIONS.length,
  );
  assert.deepEqual(parseStationCodes(''), [...DEFAULT_ANA_STATION_CODES]);
  assert.deepEqual(parseStationCodes('14990000, 14100000;junk 123'), [
    '14990000',
    '14100000',
  ]);
  assert.deepEqual(parseStationCodes('nope'), [...DEFAULT_ANA_STATION_CODES]);
  assert.equal(
    parseStationCodes(
      Array.from({ length: 60 }, (_, i) => String(10000000 + i)).join(','),
    ).length,
    40,
  );
});

test('telemetry URL uses dd/mm/yyyy calendar days in UTC', () => {
  const from = Date.UTC(2026, 8, 16, 3, 0, 0);
  const to = Date.UTC(2026, 8, 18, 12, 0, 0);
  assert.equal(anaDate(from), '16/09/2026');
  const url = anaTelemetryUrl('14990000', from, to);
  assert.match(
    url,
    /^https:\/\/telemetriaws1\.ana\.gov\.br\/ServiceANA\.asmx\/DadosHidrometeorologicos\?/,
  );
  assert.match(url, /codEstacao=14990000/);
  assert.match(url, /dataInicio=16%2F09%2F2026/);
  assert.match(url, /dataFim=18%2F09%2F2026/);
  assert.throws(() => anaTelemetryUrl('abc', from, to), TypeError);
});

test('the SOAP DataSet parses into sorted, de-duplicated UTC readings', () => {
  assert.equal(parseAnaTelemetryXml('<html>Service Unavailable</html>'), null);
  assert.deepEqual(parseAnaTelemetryXml(dataset([])), []);
  const t0 = Date.UTC(2026, 8, 18, 7, 45, 0);
  const xml = dataset([
    row(t0, '2120.00', '0.2'),
    row(t0 - 15 * 60_000, '2120.00', ''),
    row(t0, '2120.00', '0.2'), // duplicate stamp
    row(t0 - 30 * 60_000, '', '1.4'), // rain-only reading
  ]);
  const readings = parseAnaTelemetryXml(xml);
  assert.equal(readings.length, 3);
  assert.deepEqual(
    readings.map((r) => r.at),
    [t0 - 30 * 60_000, t0 - 15 * 60_000, t0],
  );
  assert.equal(readings[2].levelCm, 2120);
  assert.equal(readings[2].rainMm, 0.2);
  assert.equal(readings[2].flowM3s, null);
  assert.equal(readings[0].levelCm, null);
  assert.equal(readings[1].rainMm, null);
  assert.equal(parseAnaDateTime('2026-09-18 07:45:00 '), t0);
  assert.equal(parseAnaDateTime('18/09/2026'), null);
});

test('summary reports level, 24 h trend, rain and a 48 h sparkline', () => {
  const latestAt = Date.UTC(2026, 8, 18, 7, 45, 0);
  const readings = [];
  // 48 h of 15-minute readings, falling 1 cm per hour, 0.1 mm rain each.
  for (let i = 0; i <= 48 * 4; i++) {
    const at = latestAt - (48 * 4 - i) * 15 * 60_000;
    readings.push({ at, levelCm: 2168 - i / 4, rainMm: 0.1, flowM3s: null });
  }
  const summary = summarizeReadings(readings, latestAt + 10 * 60_000);
  assert.equal(summary.levelCm, 2120);
  assert.equal(summary.levelM, 21.2);
  assert.equal(summary.delta24hCm, -24);
  assert.equal(summary.rain24hMm, 9.6);
  assert.equal(summary.sparkline.length, 12);
  assert.equal(summary.sparkline[0], '█');
  assert.equal(summary.sparkline[11], '▁');
  assert.equal(summary.ageMs, 10 * 60_000);
  assert.equal(
    summarizeReadings([{ at: latestAt, levelCm: null, rainMm: 1 }], latestAt),
    null,
  );

  const sparse = summarizeReadings(
    [{ at: latestAt, levelCm: 2120, rainMm: null }],
    latestAt,
  );
  assert.equal(sparse.delta24hCm, null, 'no reading near 24 h ago → no trend');
  assert.equal(sparse.rain24hMm, null);
  assert.equal(gaugeLevelLine(sparse), '21.20 m');
  assert.equal(gaugeLevelLine(summary), '21.20 m ▼ 24 cm/24h');
  assert.equal(gaugeLevelLine(null), 'NO READING');
});

test('sparkline and buckets tolerate gaps and flat series', () => {
  assert.equal(sparklineString([]), '');
  assert.equal(sparklineString([5, 5, 5]), '▄▄▄');
  assert.equal(sparklineString([0, null, 7]), '▁ █');
  const now = Date.UTC(2026, 8, 18, 12, 0, 0);
  const buckets = bucketLevels(
    [
      { at: now - 47 * HOUR, levelCm: 100 },
      { at: now - 1 * HOUR, levelCm: 200 },
      { at: now - 100 * HOUR, levelCm: 999 },
    ],
    now,
  );
  assert.equal(buckets.length, 12);
  assert.equal(buckets[0], 100);
  assert.equal(buckets[11], 200);
  assert.equal(buckets[5], 100, 'gaps carry the last level forward');
  assert.deepEqual(
    bucketLevels([{ at: now - 1 * HOUR, levelCm: 7 }], now, { buckets: 3 }),
    [7, 7, 7],
    'a lone recent reading fills backwards too',
  );
  assert.deepEqual(bucketLevels([], now, { buckets: 2 }), [null, null]);
});

test('card copy and analyst records read like the panel expects', () => {
  const station = {
    code: '14990000',
    name: 'Manaus',
    river: 'Rio Negro',
    lat: -3.1383,
    lon: -60.0272,
    summary: {
      at: 1,
      levelCm: 2120,
      levelM: 21.2,
      delta24hCm: -24,
      rain24hMm: 3.2,
      sparkline: '██▇▇▆▆▅▄▃▂▁▁',
      ageMs: 25 * 60_000,
    },
  };
  const ambient = gaugeCardCopy(station);
  assert.equal(ambient.title, 'MANAUS · RIO NEGRO');
  assert.deepEqual(ambient.details, ['21.20 m ▼ 24 cm/24h', '██▇▇▆▆▅▄▃▂▁▁']);
  assert.equal(ambient.accent, '#ffb02e');
  const selected = gaugeCardCopy(station, { selected: true });
  assert.deepEqual(selected.details.slice(2), [
    '25m ago · rain 24h 3.2 mm',
    'ANA station 14990000',
  ]);
  assert.equal(
    gaugeCardCopy({ ...station, summary: null }).details[0],
    'NO READING',
  );
  assert.equal(
    gaugeCardCopy({
      ...station,
      summary: { ...station.summary, delta24hCm: 5 },
    }).accent,
    '#4fd1ff',
  );
  assert.deepEqual(gaugeAnalystRecord(station, 3), {
    index: 3,
    id: '14990000',
    name: 'Manaus',
    river: 'Rio Negro',
    levelM: 21.2,
    delta24hCm: -24,
    rain24hMm: 3.2,
    lat: -3.1383,
    lon: -60.0272,
  });
});
