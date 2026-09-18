import { fetchRegionalJson } from './http.js';
import { normalizeRegionalWeather } from '../../../src/data/regionalModel.js';

const WEATHER_EFFECTS_MAX_RESPONSE_BYTES = 512 * 1024;

async function fetchRegionalWeather(point) {
  const params = new URLSearchParams({
    latitude: point.latitude.toFixed(5),
    longitude: point.longitude.toFixed(5),
    current:
      'temperature_2m,apparent_temperature,precipitation,weather_code,cloud_cover,wind_speed_10m,wind_direction_10m,wind_gusts_10m,visibility',
    // Wind aloft only exists in the hourly block; one day is a few KB and the
    // normalizer picks the hour that matches `current.time`.
    hourly:
      'wind_speed_80m,wind_direction_80m,wind_speed_120m,wind_direction_120m',
    forecast_days: '1',
    timezone: 'UTC',
  });
  try {
    const payload = await fetchRegionalJson(
      `https://api.open-meteo.com/v1/forecast?${params}`,
      {
        maxBytes: WEATHER_EFFECTS_MAX_RESPONSE_BYTES,
      },
    );
    return normalizeRegionalWeather(payload);
  } catch {
    return null;
  }
}

export { fetchRegionalWeather };
