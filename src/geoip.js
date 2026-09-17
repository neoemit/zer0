import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import geoip from 'geoip-lite';

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export function geolocateIp(ip) {
  if (!ip) return 'ZZ';
  const lookup = geoip.lookup(ip);
  return normalizeCountry(lookup?.country);
}

// geoip-lite bundles a GeoLite2 snapshot frozen at npm publish time, while MaxMind
// reassigns ranges twice a week. Without a refresh, newer IPs degrade to 'ZZ'.
export function startGeoipAutoUpdate({
  licenseKey,
  intervalMs = WEEK_MS,
  log = console,
  spawnFn = spawn,
  reload = (cb) => geoip.reloadData(cb),
} = {}) {
  if (!licenseKey) return null;

  const require = createRequire(import.meta.url);
  const script = path.join(path.dirname(require.resolve('geoip-lite/package.json')), 'scripts', 'updatedb.js');

  const update = () => {
    // Key goes through the environment, not argv, so it stays out of the process table.
    const child = spawnFn(process.execPath, [script], {
      env: { ...process.env, LICENSE_KEY: licenseKey },
      stdio: 'ignore',
    });
    child.on('error', (err) => log.warn({ err }, 'geoip update could not start'));
    child.on('exit', (code) => {
      if (code !== 0) return log.warn({ code }, 'geoip update failed');
      reload((err) => (err ? log.warn({ err }, 'geoip reload failed') : log.info('geoip database refreshed')));
    });
  };

  update();
  const timer = setInterval(update, intervalMs);
  timer.unref();
  return timer;
}

function normalizeCountry(country) {
  const value = String(country || 'ZZ').trim().toUpperCase();
  return /^[A-Z]{2}$/.test(value) ? value : 'ZZ';
}
