import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { geolocateIp, startGeoipAutoUpdate } from '../src/geoip.js';

const silentLog = { info() {}, warn() {} };

test('unknown and private addresses fall back to ZZ', () => {
  assert.equal(geolocateIp(''), 'ZZ');
  assert.equal(geolocateIp('127.0.0.1'), 'ZZ');
});

test('no license key means no updater', () => {
  assert.equal(startGeoipAutoUpdate({ licenseKey: '', log: silentLog }), null);
});

test('a successful update reloads the database and keeps the key out of argv', () => {
  const child = new EventEmitter();
  let args;
  let env;
  let reloaded = false;
  const timer = startGeoipAutoUpdate({
    licenseKey: 'secret-key',
    log: silentLog,
    spawnFn: (_bin, spawnArgs, opts) => {
      args = spawnArgs;
      env = opts.env;
      return child;
    },
    reload: (cb) => {
      reloaded = true;
      cb(null);
    },
  });
  clearInterval(timer);

  assert.match(args[0], /updatedb\.js$/);
  assert.equal(args.length, 1);
  assert.equal(env.LICENSE_KEY, 'secret-key');

  child.emit('exit', 0);
  assert.equal(reloaded, true);
});

test('a failed update does not reload', () => {
  const child = new EventEmitter();
  let reloaded = false;
  const timer = startGeoipAutoUpdate({
    licenseKey: 'secret-key',
    log: silentLog,
    spawnFn: () => child,
    reload: () => {
      reloaded = true;
    },
  });
  clearInterval(timer);

  child.emit('exit', 1);
  assert.equal(reloaded, false);
});
