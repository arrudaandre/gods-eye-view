import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  accentForSeverity,
  FIRMS_AMBIENT_COHORT_LIMIT,
  FIRMS_OVERLAY_SOURCE_ID,
  fireDetectionKey,
  satelliteShortName,
} from './firmsLabels.js';

test('FIRMS formatting helpers retain the shipped severity palette', () => {
  assert.equal(accentForSeverity('red'), '224, 82, 82');
  assert.equal(accentForSeverity('orange'), '240, 178, 62');
  assert.equal(accentForSeverity('yellow'), '244, 227, 108');
  assert.equal(accentForSeverity('chartreuse'), accentForSeverity('yellow'));
});

test('FIRMS satellite names retain the three VIIRS abbreviations', () => {
  assert.equal(satelliteShortName('N20'), 'N20');
  assert.equal(satelliteShortName('N21'), 'N21');
  assert.equal(satelliteShortName('N'), 'SNPP');
  assert.equal(satelliteShortName('TERRA-X9'), 'TERRA-');
  assert.equal(satelliteShortName(''), '');
});

test('INPE satellite spellings get readable short names', () => {
  assert.equal(satelliteShortName('NPP-375'), 'SNPP');
  assert.equal(satelliteShortName('NPP-375D'), 'SNPP');
  assert.equal(satelliteShortName('NOAA-20'), 'N20');
  assert.equal(satelliteShortName('AQUA_M-T'), 'AQUA');
  assert.equal(satelliteShortName('TERRA_M-M'), 'TERRA');
  assert.equal(satelliteShortName('GOES-19'), 'G19');
  assert.equal(satelliteShortName('METOP-C'), 'MET-C');
  assert.equal(satelliteShortName('MSG-03'), 'MSG-03');
});

test('detection keys are prefixed by the record feed, FIRMS by default', () => {
  const fire = { lat: -5.7614, lon: -57.6002, acqMs: 1_789_700_000_000, satellite: 'NOAA-20' };
  assert.match(fireDetectionKey(fire), /^firms:-5\.7614:-57\.6002:1789700000000:N20$/);
  assert.match(fireDetectionKey({ ...fire, feedId: 'inpe' }), /^inpe:-5\.7614:/);
  assert.notEqual(fireDetectionKey(fire), fireDetectionKey({ ...fire, feedId: 'inpe' }));
  assert.match(fireDetectionKey({ feedId: '' }), /^firms:x:x:0:x$/);
});

test('FIRMS host registration constants pin the shipped source budget', () => {
  assert.equal(FIRMS_OVERLAY_SOURCE_ID, 'firms');
  assert.equal(FIRMS_AMBIENT_COHORT_LIMIT, 18);
});

test('FIRMS helper module cannot resurrect a dedicated canvas renderer', () => {
  const source = readFileSync(new URL('./firmsLabels.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /createElement\(['"]canvas['"]\)/);
  assert.doesNotMatch(source, /postRender/);
  assert.doesNotMatch(source, /worldToWindowCoordinates/);
});
