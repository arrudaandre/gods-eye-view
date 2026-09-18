import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeRegionalArticles,
  normalizeRegionalPlace,
  normalizeRegionalWeather,
  regionalDistanceM,
  weatherCodeLabel,
  compassPoint,
  hourlyAtCurrent,
  windAloftLine,
} from './regionalBrief.js';

test('normalizes a regional place with stable locality fallback', () => {
  assert.deepEqual(
    normalizeRegionalPlace({
      address: {
        town: 'Davis',
        state: 'California',
        country: 'United States',
        country_code: 'us',
      },
    }),
    {
      label: 'Davis, California',
      locality: 'Davis',
      region: 'California',
      country: 'United States',
      countryCode: 'US',
    },
  );
  assert.equal(normalizeRegionalPlace({ address: {} }), null);
});

test('normalizes, deduplicates, and rejects unsafe regional-news rows', () => {
  const articles = normalizeRegionalArticles({
    articles: [
      {
        title: 'Regional update',
        url: 'https://news.example/one',
        domain: 'news.example',
        seendate: '20260722T081500Z',
      },
      { title: 'Regional   update', url: 'https://news.example/two' },
      { title: 'Unsafe', url: 'javascript:alert(1)' },
      {
        title: 'Second story',
        url: 'https://other.example/story',
        seendate: '2026-07-22T07:00:00Z',
      },
    ],
  });
  assert.equal(articles.length, 2);
  assert.equal(articles[0].publishedAt, '2026-07-22T08:15:00Z');
  assert.equal(articles[1].domain, 'other.example');
});

test('normalizes weather values and labels WMO conditions', () => {
  const weather = normalizeRegionalWeather({
    current: {
      time: '2026-07-22T08:15:00Z',
      temperature_2m: 21.4,
      apparent_temperature: 20.8,
      precipitation: 0,
      cloud_cover: 42,
      wind_speed_10m: 18.2,
      wind_direction_10m: 270,
      visibility: 18000,
      weather_code: 2,
    },
  });
  assert.equal(weather.temperatureC, 21.4);
  assert.equal(weather.visibilityM, 18000);
  assert.equal(weatherCodeLabel(weather.weatherCode), 'PARTLY CLOUDY');
  assert.equal(normalizeRegionalWeather({ current: {} }), null);
  assert.equal(weather.windGustKph, null);
  assert.equal(weather.wind80Kph, null, 'no hourly block → no wind aloft');
});

test('wind aloft comes from the hourly row that matches the current hour', () => {
  const weather = normalizeRegionalWeather({
    current: {
      time: '2026-09-18T12:00',
      temperature_2m: 29.2,
      wind_speed_10m: 2.4,
      wind_direction_10m: 222,
      wind_gusts_10m: 12.6,
    },
    hourly: {
      time: ['2026-09-18T11:00', '2026-09-18T12:00', '2026-09-18T13:00'],
      wind_speed_80m: [9.1, 11.5, 13.0],
      wind_direction_80m: [200, 225, 230],
      wind_speed_120m: [10.2, 14.4, 15.9],
      wind_direction_120m: [205, 228, 233],
    },
  });
  assert.equal(weather.windGustKph, 12.6);
  assert.equal(weather.wind80Kph, 11.5);
  assert.equal(weather.wind80DirectionDeg, 225);
  assert.equal(weather.wind120Kph, 14.4);
  assert.equal(weather.wind120DirectionDeg, 228);
  assert.equal(compassPoint(225), 'SW');
  assert.equal(compassPoint(359), 'N');
  assert.equal(compassPoint(null), '');
  assert.equal(
    windAloftLine(weather),
    'WIND km/h · 10 m 2 SW · 80 m 12 SW · 120 m 14 SW · gust 13',
  );
  assert.equal(
    windAloftLine({ windKph: 8, windDirectionDeg: 90 }),
    'WIND km/h · 10 m 8 E',
  );
  assert.equal(windAloftLine({}), null);
  assert.equal(windAloftLine(null), null);
  assert.deepEqual(
    hourlyAtCurrent(
      { time: ['2026-09-18T11:00'], wind_speed_80m: [1] },
      '2026-09-18T12:00',
    ),
    null,
    'a missing hour is not approximated',
  );
});

test('zone-naive Open-Meteo timestamps are pinned to UTC, zoned ones pass through', () => {
  // Open-Meteo's default payload carries no zone designator; JS would parse it
  // as host-local time, skewing observedAt by the UTC offset.
  const naive = normalizeRegionalWeather({
    current: { time: '2026-08-17T00:15', temperature_2m: 20 },
  });
  assert.equal(naive.observedAt, '2026-08-17T00:15:00.000Z');
  const zoned = normalizeRegionalWeather({
    current: { time: '2026-08-17T00:15:00+02:00', temperature_2m: 20 },
  });
  assert.equal(zoned.observedAt, '2026-08-16T22:15:00.000Z');
  const invalid = normalizeRegionalWeather({
    current: { time: 'not-a-time', temperature_2m: 20 },
  });
  assert.equal(invalid.observedAt, null);
});

test('regional distance handles nearby movement and missing positions', () => {
  const distance = regionalDistanceM(
    { latitude: 38.5, longitude: -121.7 },
    { latitude: 38.6, longitude: -121.7 },
  );
  assert.ok(distance > 11000 && distance < 11200);
  assert.equal(regionalDistanceM(null, null), Infinity);
});
