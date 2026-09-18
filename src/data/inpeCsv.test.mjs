import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_INPE_BIOMES,
  filterByBiome,
  inpeDailyFileName,
  instrumentForSatellite,
  isLikelyInpeCsv,
  parseBiomeList,
  parseInpeCsv,
  splitGmtTimestamp,
} from './inpeCsv.js';
import { filterTrailing24h } from './firmsCsv.js';
import { adaptFirmsRecords } from './firmsAdapt.js';

// Verbatim shape of focos_diario_br_20260918.csv (leading spaces included).
const HEADER =
  'id,lat,lon,data_hora_gmt,satelite,municipio,estado,pais,municipio_id,estado_id,pais_id,numero_dias_sem_chuva,precipitacao,risco_fogo,bioma,frp\n';
const ROWS =
  '05638ef9-3686-3fb7-bc4c-2394ae9fbc14, -12.263300, -50.746300,2026-09-18 00:00:00,GOES-19,NOVO SANTO ANTÔNIO,MATO GROSSO,Brasil,5106315,51,33,,,,Cerrado,74.6\r\n' +
  'd80dcda1-1f53-3b34-b5ef-cb0a05e1c9e6,  -5.761400, -57.600200,2026-09-18 04:50:00,GOES-19,JACAREACANGA,PARÁ,Brasil,1503754,15,33,3,0.4,0.87,Amazônia,70.0\n' +
  'aa,  -3.100000, -60.000000,2026-09-17 23:58:00,NPP-375D,MANAUS,AMAZONAS,Brasil,1302603,13,33,,,,Amazônia,\n' +
  'bad row without enough columns\n' +
  'cc, x, -60.0,2026-09-17 23:58:00,AQUA_M-T,MANAUS,AMAZONAS,Brasil,1,13,33,,,,Amazônia,5\n' +
  'dd, -3.2, -60.1,not a time,AQUA_M-T,MANAUS,AMAZONAS,Brasil,1,13,33,,,,Amazônia,5\n';

test('parses the INPE daily CSV into FIRMS-shaped records', () => {
  const records = parseInpeCsv(HEADER + ROWS);
  assert.equal(records.length, 3, 'malformed, non-numeric and untimed rows are skipped');
  assert.deepEqual(records[1], {
    lat: -5.7614,
    lon: -57.6002,
    frp: 70,
    acqDate: '2026-09-18',
    acqTime: '0450',
    satellite: 'GOES-19',
    instrument: 'ABI',
    biome: 'Amazônia',
    state: 'PARÁ',
    municipality: 'JACAREACANGA',
    place: 'JACAREACANGA · PARÁ',
    daysWithoutRain: 3,
    precipitationMm: 0.4,
    fireRisk: 0.87,
  });
  assert.equal(records[2].frp, 0, 'blank FRP reads as 0, like FIRMS');
  assert.equal(records[2].instrument, 'VIIRS');
  assert.equal(records[2].daysWithoutRain, null, 'blank INPE columns stay unknown');
  assert.equal(records[0].acqTime, '0000');
});

test('non-CSV payloads (HTML listings, errors) parse to null, not []', () => {
  assert.equal(parseInpeCsv('<html><body>404</body></html>'), null);
  assert.equal(parseInpeCsv('Not Found'), null);
  assert.equal(parseInpeCsv(''), null);
  assert.deepEqual(parseInpeCsv(HEADER), []);
  assert.equal(isLikelyInpeCsv('latitude,longitude,acq_date,acq_time,confidence,frp\n'), false, 'FIRMS CSV is not INPE CSV');
});

test('the records flow through the shared FIRMS window filter and adapter', () => {
  const records = parseInpeCsv(HEADER + ROWS);
  const now = Date.UTC(2026, 8, 18, 5, 15);
  const fresh = filterTrailing24h(records, now);
  assert.equal(fresh.length, 3, 'all three rows are inside the trailing 24 h');
  const stale = filterTrailing24h(records, Date.UTC(2026, 8, 19, 5, 15));
  assert.equal(stale.length, 0);
  const [fire] = adaptFirmsRecords(fresh.slice(1, 2), { feedId: 'inpe' });
  assert.equal(fire.acqMs, Date.UTC(2026, 8, 18, 4, 50));
  assert.equal(fire.sensor, 'ABI');
  assert.equal(fire.confidence, null, 'INPE publishes no confidence');
  assert.equal(fire.place, 'JACAREACANGA · PARÁ');
  assert.equal(fire.feedId, 'inpe');
});

test('biome filter ignores accents and case; * means every biome', () => {
  const records = parseInpeCsv(HEADER + ROWS);
  assert.deepEqual(filterByBiome(records, ['amazonia']).map((r) => r.municipality), ['JACAREACANGA', 'MANAUS']);
  assert.deepEqual(filterByBiome(records, ['CERRADO', 'Amazônia']).length, 3);
  assert.equal(filterByBiome(records, null).length, 3);
  assert.equal(filterByBiome(records, []).length, 0);
  assert.deepEqual(parseBiomeList(undefined), ['Amazônia']);
  assert.deepEqual(parseBiomeList('  '), [...DEFAULT_INPE_BIOMES]);
  assert.equal(parseBiomeList('*'), null);
  assert.deepEqual(parseBiomeList('Cerrado, Pantanal,'), ['Cerrado', 'Pantanal']);
});

test('timestamps, sensors and daily file names', () => {
  assert.deepEqual(splitGmtTimestamp('2026-09-18 04:50:00'), { acqDate: '2026-09-18', acqTime: '0450' });
  assert.deepEqual(splitGmtTimestamp('2026-09-18T23:58'), { acqDate: '2026-09-18', acqTime: '2358' });
  assert.equal(splitGmtTimestamp('18/09/2026'), null);
  assert.equal(instrumentForSatellite('NOAA-21'), 'VIIRS');
  assert.equal(instrumentForSatellite('NPP-375'), 'VIIRS');
  assert.equal(instrumentForSatellite('TERRA_M-M'), 'MODIS');
  assert.equal(instrumentForSatellite('METOP-B'), 'AVHRR');
  assert.equal(instrumentForSatellite('MSG-03'), 'SEVIRI');
  assert.equal(instrumentForSatellite('GOES-19'), 'ABI');
  assert.equal(instrumentForSatellite('LANDSAT'), '');
  assert.equal(inpeDailyFileName(Date.UTC(2026, 8, 18, 0, 5)), 'focos_diario_br_20260918.csv');
  assert.equal(inpeDailyFileName(Date.UTC(2026, 0, 1)), 'focos_diario_br_20260101.csv');
});

test('a quoted municipality with a comma does not shift the columns', () => {
  const quoted =
    'q, -3.0, -60.0,2026-09-18 01:00:00,GOES-19,"SANTA ISABEL, DO RIO NEGRO",AMAZONAS,Brasil,1,13,33,,,,Amazônia,12\n';
  const [record] = parseInpeCsv(HEADER + quoted);
  assert.equal(record.municipality, 'SANTA ISABEL, DO RIO NEGRO');
  assert.equal(record.biome, 'Amazônia');
  assert.equal(record.frp, 12);
});
