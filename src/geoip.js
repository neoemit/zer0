import geoip from 'geoip-lite';

export function geolocateIp(ip) {
  if (!ip) return 'ZZ';
  const lookup = geoip.lookup(ip);
  return normalizeCountry(lookup?.country);
}

function normalizeCountry(country) {
  const value = String(country || 'ZZ').trim().toUpperCase();
  return /^[A-Z]{2}$/.test(value) ? value : 'ZZ';
}
