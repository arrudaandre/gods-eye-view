import test from 'node:test';
import assert from 'node:assert/strict';
import { flyToAustin, flyToLastView } from '../camera.js';

test('teardown before the initial camera delay prevents a late flight', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let flights = 0;
  let cancelled = 0;
  const stop = flyToAustin({
    isDestroyed: () => false,
    camera: {
      setView() {},
      flyTo() {
        flights++;
      },
      cancelFlight() {
        cancelled++;
      },
    },
  });
  stop();
  t.mock.timers.tick(1000);
  assert.equal(flights, 0);
  assert.equal(cancelled, 1);
});

test('the saved-view startup parks above the pose, then flies into it', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const views = [];
  const flights = [];
  const viewer = {
    isDestroyed: () => false,
    camera: {
      setView: (view) => views.push(view),
      flyTo: (flight) => flights.push(flight),
      cancelFlight() {},
    },
  };
  const stop = flyToLastView(viewer, {
    lat: -3.119,
    lon: -60.0217,
    alt: 1235,
    heading: 90,
    pitch: -34,
    roll: 0,
  });
  assert.equal(views.length, 1, 'the camera is parked immediately');
  assert.equal(flights.length, 0);
  t.mock.timers.tick(600);
  assert.equal(flights.length, 1);
  assert.equal(flights[0].duration, 2.5);
  assert.ok(Math.abs(flights[0].orientation.heading - Math.PI / 2) < 1e-9);
  stop();
});

test('teardown before the saved-view delay prevents a late flight', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let flights = 0;
  let cancelled = 0;
  const stop = flyToLastView(
    {
      isDestroyed: () => false,
      camera: {
        setView() {},
        flyTo() {
          flights++;
        },
        cancelFlight() {
          cancelled++;
        },
      },
    },
    { lat: 0, lon: 0, alt: 500, heading: 0, pitch: -35, roll: 0 },
  );
  stop();
  t.mock.timers.tick(1000);
  assert.equal(flights, 0);
  assert.equal(cancelled, 1);
});
