/**
 * INPE Programa Queimadas daily-CSV parsing — pure functions, no Cesium/DOM/
 * network, shared by the /api/inpe proxy and its tests.
 *
 * Upstream (open data, confirmed live 2026-09-18):
 *   https://dataserver-coids.inpe.br/queimadas/queimadas/focos/csv/diario/Brasil/focos_diario_br_YYYYMMDD.csv
 * Header:
 *   id,lat,lon,data_hora_gmt,satelite,municipio,estado,pais,municipio_id,
 *   estado_id,pais_id,numero_dias_sem_chuva,precipitacao,risco_fogo,bioma,frp
 *
 * Quirks this module owns:
 * - One file per UTC day (rows run 00:00–23:59 GMT), regenerated through the
 *   day, so a trailing-24 h window needs today AND yesterday.
 * - `data_hora_gmt` is "YYYY-MM-DD HH:MM:SS" (UTC). It is split into the
 *   FIRMS-style `acqDate` + zero-padded `acqTime` so the records flow through
 *   the same filterTrailing24h / adaptFirmsRecords path as NASA FIRMS.
 * - There is NO confidence column; `frp` is empty for some satellites
 *   (kept as 0); `risco_fogo` / precipitation are often blank.
 * - Numeric cells carry leading spaces (" -12.263300").
 * - `satelite` uses INPE spellings (GOES-19, NPP-375D, AQUA_M-T…); the sensor
 *   is derived here because the rows never say it.
 * - The 10-minute feed only has lat/lon/satellite/time, and the WFS is too
 *   slow to poll, which is why the daily file is the source.
 */

/** Header fields that must all be present for a payload to count as INPE CSV. */
const REQUIRED_HEADER_FIELDS = [
  'lat',
  'lon',
  'data_hora_gmt',
  'satelite',
  'bioma',
  'frp',
];

/** Default biome selection: the layer is the Amazon layer unless told otherwise. */
export const DEFAULT_INPE_BIOMES = Object.freeze(['Amazônia']);

/**
 * Cheap "is this actually the INPE daily CSV?" check — HTML error pages and
 * directory listings fail it, any payload whose first line carries the
 * required header fields passes.
 * @param {string} text - Raw upstream response body.
 * @returns {boolean}
 */
export function isLikelyInpeCsv(text) {
  if (typeof text !== 'string') return false;
  const trimmed = text.trimStart();
  if (!trimmed || trimmed[0] === '<') return false;
  const newline = trimmed.indexOf('\n');
  const headerLine = trimmed
    .slice(0, newline === -1 ? undefined : newline)
    .trim()
    .toLowerCase();
  const fields = splitCsvLine(headerLine).map((f) => f.trim());
  return REQUIRED_HEADER_FIELDS.every((required) => fields.includes(required));
}

/**
 * Parse one INPE daily CSV payload into FIRMS-shaped detection records so the
 * fires layer needs no INPE-specific rendering. Tolerates CRLF, trailing
 * newlines, column reordering and malformed rows (skipped). Non-CSV input
 * returns `null` so callers can tell "no fires" from "upstream failure".
 *
 * @param {string} text - Raw CSV payload.
 * @returns {?Array<{lat: number, lon: number, frp: number, acqDate: string,
 *   acqTime: string, satellite: string, instrument: string, biome: string,
 *   state: string, municipality: string, place: string,
 *   daysWithoutRain: ?number, precipitationMm: ?number, fireRisk: ?number}>}
 */
export function parseInpeCsv(text) {
  if (!isLikelyInpeCsv(text)) return null;
  const lines = text.split('\n');

  let headerIndex = 0;
  while (headerIndex < lines.length && !lines[headerIndex].trim())
    headerIndex += 1;
  const header = splitCsvLine(lines[headerIndex].trim().toLowerCase()).map(
    (f) => f.trim(),
  );
  const col = new Map(header.map((name, i) => [name, i]));
  const iLat = col.get('lat');
  const iLon = col.get('lon');
  const iWhen = col.get('data_hora_gmt');
  const iSatellite = col.get('satelite');
  const iMunicipality = col.get('municipio');
  const iState = col.get('estado');
  const iDaysDry = col.get('numero_dias_sem_chuva');
  const iPrecip = col.get('precipitacao');
  const iRisk = col.get('risco_fogo');
  const iBiome = col.get('bioma');
  const iFrp = col.get('frp');

  const records = [];
  for (let i = headerIndex + 1; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (!line) continue;
    const parts = splitCsvLine(line);
    if (parts.length < header.length) continue; // malformed row — skip
    const lat = Number(parts[iLat]);
    const lon = Number(parts[iLon]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const when = splitGmtTimestamp(cell(parts, iWhen));
    if (!when) continue; // a detection without a time cannot be windowed
    const satellite = cell(parts, iSatellite);
    const municipality = cell(parts, iMunicipality);
    const state = cell(parts, iState);

    records.push({
      lat,
      lon,
      frp: finiteOrZero(parts[iFrp]),
      acqDate: when.acqDate,
      acqTime: when.acqTime,
      satellite,
      instrument: instrumentForSatellite(satellite),
      biome: cell(parts, iBiome),
      state,
      municipality,
      place: [municipality, state].filter(Boolean).join(' · '),
      daysWithoutRain: finiteOrNull(parts[iDaysDry]),
      precipitationMm: finiteOrNull(parts[iPrecip]),
      fireRisk: finiteOrNull(parts[iRisk]),
    });
  }
  return records;
}

/**
 * "YYYY-MM-DD HH:MM[:SS]" (UTC) → FIRMS-style `{acqDate, acqTime}` with a
 * zero-padded HHMM, or null when unparseable.
 * @param {string} value - Raw data_hora_gmt cell.
 * @returns {?{acqDate: string, acqTime: string}}
 */
export function splitGmtTimestamp(value) {
  const match = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}):(\d{2})/.exec(
    String(value ?? '').trim(),
  );
  if (!match) return null;
  return { acqDate: match[1], acqTime: `${match[2]}${match[3]}` };
}

/**
 * Sensor name for an INPE satellite spelling (the CSV has no instrument
 * column). Unknown satellites yield '' so the card falls back gracefully.
 * @param {string} satellite - Raw `satelite` cell.
 * @returns {string}
 */
export function instrumentForSatellite(satellite) {
  const s = String(satellite || '')
    .trim()
    .toUpperCase();
  if (/^(NOAA-2\d|NPP)/.test(s)) return 'VIIRS';
  if (/^(AQUA|TERRA)/.test(s)) return 'MODIS';
  if (/^GOES/.test(s)) return 'ABI';
  if (/^METOP/.test(s)) return 'AVHRR';
  if (/^MSG/.test(s)) return 'SEVIRI';
  return '';
}

/**
 * Keep the records whose `biome` is in `biomes` (accent- and case-
 * insensitive, so "Amazonia" matches "Amazônia"). `null` biomes = keep all.
 * @param {Array<{biome?: string}>} records - Parser records.
 * @param {?Array<string>} biomes - Biome names, or null for no filter.
 * @returns {Array<Object>} Filtered records (original objects, order kept).
 */
export function filterByBiome(records, biomes) {
  if (!Array.isArray(records)) return [];
  if (!Array.isArray(biomes)) return records;
  const wanted = new Set(biomes.map(foldName).filter(Boolean));
  if (!wanted.size) return [];
  return records.filter((record) => wanted.has(foldName(record?.biome)));
}

/**
 * Parse the INPE_FIRES_BIOMES setting: comma-separated names, `*` for every
 * biome, unset/blank for the Amazon default.
 * @param {*} value - Raw environment value.
 * @returns {?Array<string>} Biome list, or null meaning "all biomes".
 */
export function parseBiomeList(value) {
  const text = String(value ?? '').trim();
  if (!text) return [...DEFAULT_INPE_BIOMES];
  if (text === '*') return null;
  const names = text
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean);
  return names.length ? names : [...DEFAULT_INPE_BIOMES];
}

/**
 * Daily file name for the UTC day containing `ms`.
 * @param {number} ms - Epoch milliseconds.
 * @returns {string} e.g. "focos_diario_br_20260918.csv".
 */
export function inpeDailyFileName(ms) {
  const date = new Date(ms);
  const yyyy = date.getUTCFullYear();
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(date.getUTCDate()).padStart(2, '0');
  return `focos_diario_br_${yyyy}${mm}${dd}.csv`;
}

/** Lowercase, accent-stripped comparison key ("Amazônia" → "amazonia"). */
function foldName(value) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .trim()
    .toLowerCase();
}

/**
 * Split one CSV line. The INPE files carry no quotes today; the quoted-field
 * branch exists so a future municipality name with a comma cannot shift every
 * column after it.
 */
function splitCsvLine(line) {
  if (!line.includes('"')) return line.split(',');
  const out = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      out.push(field);
      field = '';
    } else field += ch;
  }
  out.push(field);
  return out;
}

/** Trimmed string cell at index, '' for missing columns. */
function cell(parts, index) {
  if (index === undefined || parts[index] === undefined) return '';
  return parts[index].trim();
}

/** Numeric cell → finite number, else 0. */
function finiteOrZero(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

/** Numeric cell → finite number, else null (blank INPE columns stay unknown). */
function finiteOrNull(value) {
  const text = String(value ?? '').trim();
  if (!text) return null;
  const number = Number(text);
  return Number.isFinite(number) ? number : null;
}
