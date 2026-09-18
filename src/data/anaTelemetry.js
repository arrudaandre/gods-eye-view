/**
 * ANA (Agência Nacional de Águas) telemetry — pure helpers shared by the
 * `/api/ana-gauges` proxy and the river-gauge layer. No fetch, no DOM, no
 * Cesium: the XML parser is a few regexes over the legacy SOAP DataSet the
 * public `telemetriaws1.ana.gov.br` service answers, so `node --test` covers
 * every line the browser and the proxy depend on.
 *
 * One reading is `{CodEstacao, DataHora, Vazao, Nivel, Chuva}`; `Nivel` is
 * the gauge reading in centimetres (Manaus reads ~2120 cm for the famous
 * "cota 21,20 m"), `Chuva` the 15-minute rain in mm, `Vazao` discharge in
 * m³/s (empty for most Amazon stations).
 */

export const ANA_TELEMETRY_BASE =
  'https://telemetriaws1.ana.gov.br/ServiceANA.asmx';
export const ANA_INVENTORY_URL = `${ANA_TELEMETRY_BASE}/ListaEstacoesTelemetricas?statusEstacoes=&origem=`;
const HOUR_MS = 3600_000;
const DAY_MS = 24 * HOUR_MS;

/**
 * Stations served by default: the Solimões–Amazonas–Negro trunk plus the
 * Madeira and Tapajós mouths, all active SGB-CPRM/Água e Solo telemetry
 * (inventory read 2026-09-18). Codes never change; coordinates come from the
 * inventory and are only a fallback for when it is unreachable.
 */
export const ANA_STATIONS = Object.freeze([
  Object.freeze({
    code: '14990000',
    name: 'Manaus',
    river: 'Rio Negro',
    lat: -3.1383,
    lon: -60.0272,
  }),
  Object.freeze({
    code: '14100000',
    name: 'Manacapuru',
    river: 'Rio Solimões',
    lat: -3.3106,
    lon: -60.6094,
  }),
  Object.freeze({
    code: '15040000',
    name: 'Careiro',
    river: 'Paraná do Careiro',
    lat: -3.1961,
    lon: -59.8336,
  }),
  Object.freeze({
    code: '16030000',
    name: 'Itacoatiara',
    river: 'Rio Amazonas',
    lat: -3.1539,
    lon: -58.4114,
  }),
  Object.freeze({
    code: '16350002',
    name: 'Parintins',
    river: 'Rio Amazonas',
    lat: -2.6306,
    lon: -56.7519,
  }),
  Object.freeze({
    code: '17050001',
    name: 'Óbidos',
    river: 'Rio Amazonas',
    lat: -1.9192,
    lon: -55.5131,
  }),
  Object.freeze({
    code: '17900000',
    name: 'Santarém',
    river: 'Rio Tapajós',
    lat: -2.4136,
    lon: -54.7378,
  }),
  Object.freeze({
    code: '14900050',
    name: 'Novo Airão',
    river: 'Rio Negro',
    lat: -2.625,
    lon: -60.9364,
  }),
  Object.freeze({
    code: '14840000',
    name: 'Moura',
    river: 'Rio Negro',
    lat: -1.4567,
    lon: -61.6347,
  }),
  Object.freeze({
    code: '14480002',
    name: 'Barcelos',
    river: 'Rio Negro',
    lat: -0.9658,
    lon: -62.9311,
  }),
  Object.freeze({
    code: '14320001',
    name: 'São Gabriel da Cachoeira',
    river: 'Rio Negro',
    lat: -0.1367,
    lon: -67.0856,
  }),
  Object.freeze({
    code: '13150003',
    name: 'Coari',
    river: 'Rio Solimões',
    lat: -4.0856,
    lon: -63.0833,
  }),
  Object.freeze({
    code: '12900001',
    name: 'Tefé',
    river: 'Rio Solimões',
    lat: -3.3758,
    lon: -64.6547,
  }),
  Object.freeze({
    code: '12351000',
    name: 'Fonte Boa',
    river: 'Rio Solimões',
    lat: -2.4914,
    lon: -66.0617,
  }),
  Object.freeze({
    code: '10100000',
    name: 'Tabatinga',
    river: 'Rio Solimões',
    lat: -4.2347,
    lon: -69.9447,
  }),
  Object.freeze({
    code: '15900000',
    name: 'Borba',
    river: 'Rio Madeira',
    lat: -4.3892,
    lon: -59.5986,
  }),
  Object.freeze({
    code: '15630000',
    name: 'Humaitá',
    river: 'Rio Madeira',
    lat: -7.5028,
    lon: -63.0183,
  }),
  Object.freeze({
    code: '15400000',
    name: 'Porto Velho',
    river: 'Rio Madeira',
    lat: -8.7483,
    lon: -63.9169,
  }),
  Object.freeze({
    code: '13870000',
    name: 'Lábrea',
    river: 'Rio Purus',
    lat: -7.2581,
    lon: -64.7975,
  }),
]);
export const DEFAULT_ANA_STATION_CODES = Object.freeze(
  ANA_STATIONS.map((station) => station.code),
);

/**
 * Station codes from `ANA_STATIONS` (comma-separated 8-digit codes). Empty or
 * absent keeps the default trunk; unknown-but-valid codes are kept so the
 * proxy can resolve them against the inventory. Bounded to 40 stations: each
 * one is a sequential upstream request every refresh.
 */
export function parseStationCodes(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return [...DEFAULT_ANA_STATION_CODES];
  const codes = [];
  for (const part of raw.split(/[,\s;]+/)) {
    const code = part.trim();
    if (/^\d{8}$/.test(code) && !codes.includes(code)) codes.push(code);
    if (codes.length >= 40) break;
  }
  return codes.length ? codes : [...DEFAULT_ANA_STATION_CODES];
}

/** Known station descriptor for a code, or null. */
export function knownStation(code) {
  return ANA_STATIONS.find((station) => station.code === code) || null;
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

/** dd/mm/yyyy as the SOAP service wants it (UTC calendar day). */
export function anaDate(ms) {
  const d = new Date(ms);
  return `${pad2(d.getUTCDate())}/${pad2(d.getUTCMonth() + 1)}/${d.getUTCFullYear()}`;
}

/** Telemetry URL for one station over [fromMs, toMs] (calendar days). */
export function anaTelemetryUrl(code, fromMs, toMs, base = ANA_TELEMETRY_BASE) {
  if (!/^\d{8}$/.test(String(code)))
    throw new TypeError('An 8-digit ANA station code is required');
  const params = new URLSearchParams({
    codEstacao: String(code),
    dataInicio: anaDate(fromMs),
    dataFim: anaDate(toMs),
  });
  return `${base}/DadosHidrometeorologicos?${params}`;
}

function textOf(block, tag) {
  const match = new RegExp(`<${tag}>([^<]*)</${tag}>`).exec(block);
  return match ? match[1].trim() : '';
}

function numberOrNull(text) {
  if (text === '' || text == null) return null;
  const n = Number(String(text).replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

/**
 * Parse `DataHora` ("2026-09-18 07:45:00 ") as UTC. The service reports the
 * station clock without a zone; ANA telemetry is transmitted in UTC, and the
 * Manaus series lines up with UTC when compared to the portal.
 */
export function parseAnaDateTime(text) {
  const match = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/.exec(
    String(text || '').trim(),
  );
  if (!match) return null;
  const [, y, mo, d, h, mi, s] = match;
  const ms = Date.UTC(+y, +mo - 1, +d, +h, +mi, +(s || 0));
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Readings from one DadosHidrometeorologicos response, oldest first,
 * duplicates by timestamp collapsed. Returns null when the body is not the
 * service's DataSet at all (an HTML error page), and [] for an empty set.
 */
export function parseAnaTelemetryXml(text) {
  const body = String(text || '');
  if (!/<DataTable|<DocumentElement|<NewDataSet/.test(body)) return null;
  const rows = new Map();
  const blocks = body.match(
    /<DadosHidrometereologicos\b[^>]*>[\s\S]*?<\/DadosHidrometereologicos>/g,
  );
  for (const block of blocks || []) {
    const at = parseAnaDateTime(textOf(block, 'DataHora'));
    if (at === null) continue;
    rows.set(at, {
      at,
      levelCm: numberOrNull(textOf(block, 'Nivel')),
      rainMm: numberOrNull(textOf(block, 'Chuva')),
      flowM3s: numberOrNull(textOf(block, 'Vazao')),
    });
  }
  return [...rows.values()].sort((a, b) => a.at - b.at);
}

const SPARK_GLYPHS = '▁▂▃▄▅▆▇█';

/**
 * A text sparkline: eight glyphs scaled between the min and max of `values`
 * (a flat series is drawn at mid height, not as noise). Nulls become gaps.
 */
export function sparklineString(values) {
  const finite = values.filter((v) => Number.isFinite(v));
  if (!finite.length) return '';
  const min = Math.min(...finite);
  const max = Math.max(...finite);
  const span = max - min;
  return values
    .map((v) => {
      if (!Number.isFinite(v)) return ' ';
      if (span < 1e-9) return SPARK_GLYPHS[3];
      const idx = Math.round(((v - min) / span) * (SPARK_GLYPHS.length - 1));
      return SPARK_GLYPHS[Math.max(0, Math.min(SPARK_GLYPHS.length - 1, idx))];
    })
    .join('');
}

/**
 * Bucket the trailing `hours` of readings into `buckets` mean levels (cm),
 * oldest first, so the sparkline has one glyph per bucket regardless of the
 * 15-minute cadence or gaps.
 */
export function bucketLevels(
  readings,
  nowMs,
  { hours = 48, buckets = 12 } = {},
) {
  const start = nowMs - hours * HOUR_MS;
  const width = (hours * HOUR_MS) / buckets;
  const sums = new Array(buckets).fill(0);
  const counts = new Array(buckets).fill(0);
  for (const reading of readings) {
    if (!Number.isFinite(reading.levelCm)) continue;
    if (reading.at < start || reading.at > nowMs) continue;
    const idx = Math.min(buckets - 1, Math.floor((reading.at - start) / width));
    sums[idx] += reading.levelCm;
    counts[idx] += 1;
  }
  const means = sums.map((sum, i) => (counts[i] ? sum / counts[i] : null));
  // Stations that report level every few hours leave empty buckets; a river
  // level is a slow signal, so carry the last mean forward (and the first one
  // back) rather than drawing holes. A bucket stays null only when the whole
  // window is empty.
  let last = null;
  for (let i = 0; i < means.length; i++) {
    if (means[i] === null) means[i] = last;
    else last = means[i];
  }
  let next = null;
  for (let i = means.length - 1; i >= 0; i--) {
    if (means[i] === null) means[i] = next;
    else next = means[i];
  }
  return means;
}

/**
 * The card-sized summary of one station's series: latest level, the change
 * over the trailing 24 h (nearest reading to 24 h ago), rain over 24 h, and
 * the 48 h sparkline. Null when there is no level at all.
 */
export function summarizeReadings(readings, nowMs) {
  const levels = readings.filter((r) => Number.isFinite(r.levelCm));
  if (!levels.length) return null;
  const latest = levels[levels.length - 1];
  const dayAgo = latest.at - DAY_MS;
  let reference = null;
  for (const reading of levels) {
    if (
      !reference ||
      Math.abs(reading.at - dayAgo) < Math.abs(reference.at - dayAgo)
    )
      reference = reading;
  }
  const delta24hCm =
    reference && Math.abs(reference.at - dayAgo) <= 3 * HOUR_MS
      ? Math.round(latest.levelCm - reference.levelCm)
      : null;
  let rain24hMm = 0;
  let rainSamples = 0;
  for (const reading of readings) {
    if (reading.at <= dayAgo || reading.at > latest.at) continue;
    if (Number.isFinite(reading.rainMm)) {
      rain24hMm += reading.rainMm;
      rainSamples += 1;
    }
  }
  const buckets = bucketLevels(readings, latest.at);
  return {
    at: latest.at,
    levelCm: latest.levelCm,
    levelM: Number((latest.levelCm / 100).toFixed(2)),
    delta24hCm,
    rain24hMm: rainSamples ? Number(rain24hMm.toFixed(1)) : null,
    sparkline: sparklineString(buckets),
    ageMs: Math.max(0, nowMs - latest.at),
    readingCount: readings.length,
  };
}

function trendGlyph(delta) {
  if (!Number.isFinite(delta)) return '';
  if (delta > 2) return '▲';
  if (delta < -2) return '▼';
  return '▬';
}

function formatAge(ageMs) {
  if (!Number.isFinite(ageMs)) return '';
  const minutes = Math.round(ageMs / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

/** Level line: "21.20 m ▼ 3 cm/24h" (delta omitted when unknown). */
export function gaugeLevelLine(summary) {
  if (!summary) return 'NO READING';
  const delta = summary.delta24hCm;
  const trend = Number.isFinite(delta)
    ? ` ${trendGlyph(delta)} ${Math.abs(delta)} cm/24h`
    : '';
  return `${summary.levelM.toFixed(2)} m${trend}`;
}

/** Title and detail lines shared by the ambient card and the readout. */
export function gaugeCardCopy(station, { selected = false } = {}) {
  const summary = station?.summary || null;
  const title = [station?.name, station?.river]
    .filter(Boolean)
    .join(' · ')
    .toUpperCase();
  const details = [gaugeLevelLine(summary)];
  if (summary?.sparkline) details.push(summary.sparkline);
  if (selected && summary) {
    const parts = [`${formatAge(summary.ageMs)} ago`];
    if (Number.isFinite(summary.rain24hMm))
      parts.push(`rain 24h ${summary.rain24hMm.toFixed(1)} mm`);
    details.push(parts.join(' · '));
    details.push(`ANA station ${station.code}`);
  }
  const accent = !summary
    ? '#8a8f98'
    : Number.isFinite(summary.delta24hCm) && summary.delta24hCm > 2
      ? '#4fd1ff'
      : Number.isFinite(summary.delta24hCm) && summary.delta24hCm < -2
        ? '#ffb02e'
        : '#7fe0c4';
  return { title, details, accent };
}

/** Plain record for the analyst engine. */
export function gaugeAnalystRecord(station, index) {
  return {
    index,
    id: station.code,
    name: station.name,
    river: station.river,
    levelM: station.summary?.levelM ?? null,
    delta24hCm: station.summary?.delta24hCm ?? null,
    rain24hMm: station.summary?.rain24hMm ?? null,
    lat: station.lat,
    lon: station.lon,
  };
}
