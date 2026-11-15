'use strict';

/**
 * FreeEats - turns a typed street address into map coordinates.
 *
 * Uses OpenStreetMap's free Nominatim service (no API key). Its usage policy asks for
 * at most one request per second, an identifying User-Agent, and caching, so lookups
 * are queued one second apart and results are remembered for a day.
 * https://operations.osmfoundation.org/policies/nominatim/
 *
 * Set GEOCODE_URL to use a different Nominatim-compatible server.
 */

const https = require('node:https');

const DEFAULT_URL = 'https://nominatim.openstreetmap.org/search';
const SPACING_MS = 1100;
const CACHE_MS = 24 * 60 * 60 * 1000;
const CACHE_MAX = 500;

function fetchJson(url, headers) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers, timeout: 8000 }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error('Address lookup returned HTTP ' + res.statusCode));
      }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => {
        body += c;
        if (body.length > 1e6) req.destroy(new Error('Address lookup reply too large'));
      });
      res.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch (e) {
          reject(new Error('Address lookup sent bad JSON'));
        }
      });
    });
    req.on('timeout', () => req.destroy(new Error('Address lookup timed out')));
    req.on('error', reject);
  });
}

function createGeocoder(env) {
  env = env || process.env;
  const base = env.GEOCODE_URL || DEFAULT_URL;
  const cache = new Map(); // key -> { at, result }
  let queue = Promise.resolve();
  let last = 0;

  /**
   * Look up an address. `near` ({lat, lng}, optional) prefers results around there,
   * e.g. the student's current location, so "Student Union" finds the one on their campus.
   * Resolves to { lat, lng, label } or null when nothing matches.
   */
  return function geocode(query, near) {
    const key = query.toLowerCase() + (near ? '@' + near.lat.toFixed(2) + ',' + near.lng.toFixed(2) : '');
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_MS) return Promise.resolve(hit.result);

    const run = queue.then(async () => {
      const wait = last + SPACING_MS - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      last = Date.now();

      const url = new URL(base);
      url.searchParams.set('q', query);
      url.searchParams.set('format', 'jsonv2');
      url.searchParams.set('limit', '1');
      if (near) {
        const d = 0.15; // about 15 km each way
        url.searchParams.set('viewbox', [near.lng - d, near.lat + d, near.lng + d, near.lat - d].join(','));
      }
      const rows = await fetchJson(url, { 'User-Agent': 'FreeEats/1.0 (campus free food app)', Accept: 'application/json' });
      const top = Array.isArray(rows) && rows[0];
      const lat = top && Number(top.lat);
      const lng = top && Number(top.lon);
      const result =
        top && Number.isFinite(lat) && Number.isFinite(lng)
          ? { lat, lng, label: String(top.display_name || query).slice(0, 200) }
          : null;

      if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
      cache.set(key, { at: Date.now(), result });
      return result;
    });
    queue = run.catch(() => {});
    return run;
  };
}

module.exports = { createGeocoder };
