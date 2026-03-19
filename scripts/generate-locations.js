/**
 * generate-locations.js
 *
 * Generates a three-tier set of static HTML pages:
 *   /locations/index.html                                          — world index (all countries)
 *   /locations/[country-slug]/index.html                          — country page (all regions)
 *   /locations/[country-slug]/[region-slug]/index.html            — region page (all cities + event cards)
 *   /locations/[country-slug]/[region-slug]/[city-slug]/index.html — city page (event cards)
 *
 * Region and city are resolved via Nominatim (OpenStreetMap) reverse geocoding.
 * Results are cached in ./geo-cache.json so repeat runs skip the API entirely.
 * Nominatim policy: max 1 req/s, descriptive User-Agent — both enforced here.
 *
 * Event cards include a Leaflet mini-map course-route preview.
 * Pages with 8+ events get a live client-side search filter.
 * Every region/city page has a Stay22 "book accommodation" CTA
 * centred on the geographic centroid of events on that page.
 */

'use strict';

const fs    = require('fs');
const path  = require('path');
const https = require('https');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const EVENTS_URL      = 'https://www.parkrunnertourist.com/events1.json';
const COURSE_MAPS_URL = process.env.COURSE_MAPS_URL;
if (!COURSE_MAPS_URL) throw new Error('COURSE_MAPS_URL secret not set');

const BASE_EXPLORE_URL   = 'https://www.parkrunnertourist.com/explore';
const BASE_LOCATIONS_URL = 'https://www.parkrunnertourist.com/locations';
const SITE_NAME          = 'parkrunner tourist';
const OUTPUT_DIR         = path.join(__dirname, '../locations');
const GEO_CACHE_FILE     = path.join(__dirname, '../geo-cache.json');
const EVENT_LIMIT        = parseInt(process.env.EVENT_LIMIT || '0', 10);
const SEARCH_THRESHOLD   = 8;

// Nominatim rate limit: 1 request per second per their usage policy
const NOMINATIM_DELAY_MS = 1100;
const NOMINATIM_UA       = 'parkrunnertourist.com location-page-builder (jake@parkrunnertourist.com)';

const ACCENT    = '#4caf50';
const DARK      = '#2e7d32';
const ACCENT_JR = '#40e0d0';

// ---------------------------------------------------------------------------
// Country code → display name + parkrun domain
// ---------------------------------------------------------------------------
const COUNTRY_META = {
  '0':  { name: 'Unknown',        url: null                  },
  '3':  { name: 'Australia',      url: 'www.parkrun.com.au'  },
  '4':  { name: 'Austria',        url: 'www.parkrun.co.at'   },
  '14': { name: 'Canada',         url: 'www.parkrun.ca'      },
  '23': { name: 'Denmark',        url: 'www.parkrun.dk'      },
  '30': { name: 'Finland',        url: 'www.parkrun.fi'      },
  '32': { name: 'Germany',        url: 'www.parkrun.com.de'  },
  '42': { name: 'Ireland',        url: 'www.parkrun.ie'      },
  '44': { name: 'Italy',          url: 'www.parkrun.it'      },
  '46': { name: 'Japan',          url: 'www.parkrun.jp'      },
  '54': { name: 'Lithuania',      url: 'www.parkrun.lt'      },
  '57': { name: 'Malaysia',       url: 'www.parkrun.my'      },
  '64': { name: 'Netherlands',    url: 'www.parkrun.co.nl'   },
  '65': { name: 'New Zealand',    url: 'www.parkrun.co.nz'   },
  '67': { name: 'Norway',         url: 'www.parkrun.no'      },
  '74': { name: 'Poland',         url: 'www.parkrun.pl'      },
  '82': { name: 'Singapore',      url: 'www.parkrun.sg'      },
  '85': { name: 'South Africa',   url: 'www.parkrun.co.za'   },
  '88': { name: 'Sweden',         url: 'www.parkrun.se'      },
  '97': { name: 'United Kingdom', url: 'www.parkrun.org.uk'  },
  '98': { name: 'United States',  url: 'www.parkrun.us'      },
};

// ---------------------------------------------------------------------------
// Nominatim address field priority per country code.
//
// Nominatim's `address` object contains fields like `city`, `town`, `county`,
// `state`, `province`, `suburb`, etc. — but which ones carry meaningful
// region/city data depends entirely on each country's admin structure.
//
// `regionFields` — ordered list of address keys to try for the region tier
// `cityFields`   — ordered list of address keys to try for the city tier
//
// The first non-empty value found wins. Any country not listed falls through
// to DEFAULT_ADDRESS_FIELDS at the bottom.
// ---------------------------------------------------------------------------
const ADDRESS_FIELDS = {
  // UK — county/unitary authority as region, city/town as city
  '97': {
    regionFields: ['county', 'state_district', 'state'],
    cityFields:   ['city', 'town', 'village', 'suburb', 'municipality'],
  },
  // Australia — state as region, suburb/city as city
  '3': {
    regionFields: ['state'],
    cityFields:   ['city', 'suburb', 'town', 'village'],
  },
  // USA — state as region, city/town as city
  '98': {
    regionFields: ['state'],
    cityFields:   ['city', 'town', 'village', 'county'],
  },
  // Canada — province as region
  '14': {
    regionFields: ['state', 'province'],
    cityFields:   ['city', 'town', 'village', 'municipality'],
  },
  // Germany — Bundesland as region
  '32': {
    regionFields: ['state'],
    cityFields:   ['city', 'town', 'village', 'suburb'],
  },
  // Ireland — county as region
  '42': {
    regionFields: ['county', 'state'],
    cityFields:   ['city', 'town', 'village', 'suburb'],
  },
  // New Zealand
  '65': {
    regionFields: ['state', 'region'],
    cityFields:   ['city', 'town', 'suburb', 'village'],
  },
  // South Africa — province as region
  '85': {
    regionFields: ['state', 'province'],
    cityFields:   ['city', 'town', 'suburb', 'village'],
  },
  // Poland — voivodeship as region
  '74': {
    regionFields: ['state'],
    cityFields:   ['city', 'town', 'village'],
  },
  // Sweden — lan as region
  '88': {
    regionFields: ['county', 'state'],
    cityFields:   ['city', 'town', 'village', 'suburb'],
  },
  // Denmark
  '23': {
    regionFields: ['state', 'county', 'region'],
    cityFields:   ['city', 'town', 'village'],
  },
  // Finland
  '30': {
    regionFields: ['state', 'region'],
    cityFields:   ['city', 'town', 'village', 'municipality'],
  },
  // Norway
  '67': {
    regionFields: ['state', 'county'],
    cityFields:   ['city', 'town', 'village', 'municipality'],
  },
  // Netherlands
  '64': {
    regionFields: ['state', 'province'],
    cityFields:   ['city', 'town', 'village', 'suburb', 'municipality'],
  },
  // Italy
  '44': {
    regionFields: ['state', 'county'],
    cityFields:   ['city', 'town', 'village', 'suburb'],
  },
  // Austria
  '4': {
    regionFields: ['state'],
    cityFields:   ['city', 'town', 'village', 'suburb'],
  },
  // Japan
  '46': {
    regionFields: ['state', 'province', 'county'],
    cityFields:   ['city', 'town', 'village', 'suburb'],
  },
  // Lithuania
  '54': {
    regionFields: ['state', 'county'],
    cityFields:   ['city', 'town', 'village', 'municipality'],
  },
  // Malaysia
  '57': {
    regionFields: ['state'],
    cityFields:   ['city', 'town', 'suburb', 'village'],
  },
  // Singapore — city-state; use neighbourhood as city
  '82': {
    regionFields: ['country'],
    cityFields:   ['suburb', 'quarter', 'neighbourhood'],
  },
};

const DEFAULT_ADDRESS_FIELDS = {
  regionFields: ['state', 'county', 'state_district', 'region', 'province'],
  cityFields:   ['city', 'town', 'village', 'suburb', 'municipality'],
};

function getAddressFields(countryCode) {
  return ADDRESS_FIELDS[String(countryCode)] || DEFAULT_ADDRESS_FIELDS;
}

// ---------------------------------------------------------------------------
// HTTP fetch (JSON) — works for both our own API and Nominatim
// ---------------------------------------------------------------------------
function fetchJson(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const opts = { headers: { Accept: 'application/json', ...headers } };
    https.get(url, opts, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error(`JSON parse error for ${url}: ${e.message}`)); }
      });
    }).on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// Nominatim reverse geocode
// Returns the raw `address` object, or null on failure.
// ---------------------------------------------------------------------------
async function nominatimReverse(lat, lon) {
  const url = `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lon}&format=json&addressdetails=1&zoom=10`;
  try {
    const data = await fetchJson(url, { 'User-Agent': NOMINATIM_UA });
    return (data && data.address) ? data.address : null;
  } catch (e) {
    console.warn(`  Nominatim error (${lat},${lon}): ${e.message}`);
    return null;
  }
}

function extractFromAddress(address, countryCode) {
  if (!address) return { city: null, region: null };
  const { regionFields, cityFields } = getAddressFields(countryCode);
  const region = regionFields.reduce((found, f) => found || address[f] || null, null);
  const city   = cityFields.reduce((found, f) => found || address[f] || null, null);
  return { city: city || null, region: region || null };
}

// ---------------------------------------------------------------------------
// Geo cache
// Keyed by coordinates rounded to 4 decimal places (~11 m grid).
// Events at the same park share a single cache entry.
// ---------------------------------------------------------------------------
function cacheKey(lat, lon) {
  return `${Math.round(lat * 1e4) / 1e4},${Math.round(lon * 1e4) / 1e4}`;
}

function loadCache() {
  try {
    if (fs.existsSync(GEO_CACHE_FILE)) {
      return JSON.parse(fs.readFileSync(GEO_CACHE_FILE, 'utf-8'));
    }
  } catch (e) {
    console.warn('Could not load geo cache, starting fresh:', e.message);
  }
  return {};
}

function saveCache(cache) {
  try {
    fs.writeFileSync(GEO_CACHE_FILE, JSON.stringify(cache, null, 2), 'utf-8');
  } catch (e) {
    console.warn('Could not save geo cache:', e.message);
  }
}

// ---------------------------------------------------------------------------
// Rate-limited geocoding pass
// Only hits Nominatim for coordinates not already in the cache.
// Saves progress every 50 requests so a partial run is not wasted.
// ---------------------------------------------------------------------------
async function geocodeAllEvents(events, cache) {
  // Collect unique coordinates not yet cached
  const seen    = new Set();
  const missing = [];
  for (const ev of events) {
    if (ev.lat === 0 && ev.lon === 0) continue;
    const k = cacheKey(ev.lat, ev.lon);
    if (!cache[k] && !seen.has(k)) {
      seen.add(k);
      missing.push({ lat: ev.lat, lon: ev.lon, k });
    }
  }

  if (missing.length === 0) {
    console.log('Geo cache: all coordinates already resolved, skipping Nominatim.');
    return;
  }

  const estimatedSeconds = Math.ceil(missing.length * NOMINATIM_DELAY_MS / 1000);
  console.log(`Geo cache: ${missing.length} new coordinates to resolve (~${estimatedSeconds}s at 1 req/s)...`);

  for (let i = 0; i < missing.length; i++) {
    const { lat, lon, k } = missing[i];
    const address = await nominatimReverse(lat, lon);
    cache[k] = address || {};   // empty object on failure — prevents infinite retries

    if ((i + 1) % 50 === 0 || i === missing.length - 1) {
      console.log(`  Geocoded ${i + 1}/${missing.length}...`);
      saveCache(cache);
    }

    if (i < missing.length - 1) await sleep(NOMINATIM_DELAY_MS);
  }

  saveCache(cache);
  console.log('Geo cache: saved.');
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// String utilities
// ---------------------------------------------------------------------------
function slugify(str) {
  return (str || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')   // strip accents
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

function ensure(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function centroid(events) {
  if (!events.length) return { lat: 51.5, lon: -0.1 };
  return {
    lat: events.reduce((s, e) => s + e.lat, 0) / events.length,
    lon: events.reduce((s, e) => s + e.lon, 0) / events.length,
  };
}

function getExploreSubfolder(slug) {
  const c = slug.charAt(0).toLowerCase();
  return (c >= 'a' && c <= 'z') ? c.toUpperCase() : '0-9';
}

// ---------------------------------------------------------------------------
// Coordinate encryption — mirrors generate-events.js exactly
// ---------------------------------------------------------------------------
function eventSeed(name) {
  let h = 0x12345678;
  for (let i = 0; i < name.length; i++) {
    h = Math.imul(h ^ name.charCodeAt(i), 0x9e3779b9);
    h ^= h >>> 16;
  }
  return Math.abs(h) % 0xFFFFFF;
}

function encryptCoords(coords, seed) {
  const flat = [];
  let s = seed & 0xFFFFFFFF;
  for (const [lng, lat] of coords) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    flat.push(Math.round(lng * 1e6) ^ (s & 0xFFFFFF));
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    flat.push(Math.round(lat * 1e6) ^ (s & 0xFFFFFF));
  }
  return Buffer.from(JSON.stringify(flat)).toString('base64');
}

function decryptFnJs() {
  return `function _d(b,s){const f=JSON.parse(atob(b));const r=[];let v=s>>>0;for(let i=0;i<f.length;i+=2){v=(Math.imul(v,1664525)+1013904223)>>>0;const lng=(f[i]^(v&0xFFFFFF))/1e6;v=(Math.imul(v,1664525)+1013904223)>>>0;const lat=(f[i+1]^(v&0xFFFFFF))/1e6;r.push([lng,lat]);}return r;}`;
}

// ---------------------------------------------------------------------------
// Shared HTML fragments
// ---------------------------------------------------------------------------
function htmlHead({ title, description, canonicalPath, lat, lon, locationName }) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${title}</title>
<meta name="description" content="${description}" />
<meta name="robots" content="index, follow" />
<link rel="canonical" href="${BASE_LOCATIONS_URL}/${canonicalPath}" />
${lat != null ? `<meta name="geo.position" content="${lat};${lon}" /><meta name="geo.placename" content="${locationName}" />` : ''}
<meta property="og:title" content="${title}" />
<meta property="og:description" content="${description}" />
<meta property="og:type" content="website" />
<meta property="og:url" content="${BASE_LOCATIONS_URL}/${canonicalPath}" />
<meta name="twitter:card" content="summary" />
<link rel="icon" type="image/x-icon" href="https://parkrunnertourist.com/favicon.ico" />
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" />
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.2.1/css/all.min.css" />
<link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&family=DM+Serif+Display&display=swap" rel="stylesheet" />
<script async src="https://www.googletagmanager.com/gtag/js?id=G-REFFZSK4XK"></script>
<script>window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}gtag('js',new Date());gtag('config','G-REFFZSK4XK');</script>
</head>`;
}

function sharedStyles() {
  return `<style>
*{box-sizing:border-box;margin:0;padding:0}
:root{
  --green:${ACCENT};--dark:${DARK};--teal:${ACCENT_JR};
  --bg:#f4f6f0;--surface:#ffffff;--border:#e2e8d8;
  --text:#1a2318;--muted:#5a6e52;--radius:12px;
}
body{font-family:'DM Sans',sans-serif;background:var(--bg);color:var(--text);line-height:1.6;}
a{color:inherit;text-decoration:none;}
header{
  background:linear-gradient(135deg,var(--dark) 0%,#1b5e20 100%);
  color:#fff;padding:1rem 2rem;
  display:flex;justify-content:space-between;align-items:center;
  box-shadow:0 4px 20px rgba(46,125,50,0.3);
}
header a.brand{font-family:'DM Serif Display',serif;font-size:1.4rem;color:#fff;}
header a.map-btn{
  padding:.4rem 1.1rem;border:2px solid rgba(255,255,255,.7);border-radius:8px;
  font-size:.875rem;font-weight:600;color:#fff;transition:all .2s;
}
header a.map-btn:hover{background:#fff;color:var(--dark);}
.breadcrumb{
  background:var(--surface);border-bottom:1px solid var(--border);
  padding:.6rem 2rem;font-size:.825rem;color:var(--muted);
  display:flex;gap:.5rem;align-items:center;flex-wrap:wrap;
}
.breadcrumb a{color:var(--dark);font-weight:500;}
.breadcrumb a:hover{text-decoration:underline;}
.breadcrumb span{opacity:.5;}
main{max-width:1200px;margin:0 auto;padding:2rem 1.5rem 4rem;}
.page-hero{text-align:center;padding:2.5rem 0 2rem;}
.page-hero h1{
  font-family:'DM Serif Display',serif;font-size:3rem;
  color:var(--dark);margin-bottom:.5rem;line-height:1.15;
}
.page-hero p{color:var(--muted);font-size:1.05rem;max-width:600px;margin:0 auto;}
.section-label{
  font-size:.7rem;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;
  color:var(--muted);margin-bottom:1rem;
}
.search-wrap{margin-bottom:1.75rem;position:relative;}
.search-input{
  width:100%;padding:.75rem 1.1rem .75rem 2.75rem;
  border:1.5px solid var(--border);border-radius:var(--radius);
  font-family:'DM Sans',sans-serif;font-size:1rem;background:var(--surface);
  outline:none;transition:border .2s;
}
.search-input:focus{border-color:var(--green);}
.search-icon{position:absolute;left:.9rem;top:50%;transform:translateY(-50%);color:var(--muted);pointer-events:none;font-size:.9rem;}
.tile-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:1rem;}
.tile{
  background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);
  padding:1.1rem 1.25rem;display:flex;align-items:center;justify-content:space-between;
  transition:box-shadow .2s,transform .2s;cursor:pointer;
}
.tile:hover{box-shadow:0 6px 24px rgba(46,125,50,.13);transform:translateY(-2px);}
.tile-name{font-weight:600;font-size:.975rem;}
.tile-count{
  background:#e8f5e9;color:var(--dark);
  font-size:.75rem;font-weight:700;padding:.2rem .55rem;border-radius:99px;flex-shrink:0;
}
.event-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:1.5rem;}
.event-card{
  background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);
  overflow:hidden;transition:box-shadow .25s,transform .25s;display:flex;flex-direction:column;
}
.event-card:hover{box-shadow:0 8px 32px rgba(46,125,50,.15);transform:translateY(-3px);}
.card-map{height:180px;flex-shrink:0;}
.card-body{padding:1rem 1.1rem;flex:1;display:flex;flex-direction:column;gap:.4rem;}
.card-title{font-weight:700;font-size:1rem;color:var(--text);line-height:1.3;}
.card-location{font-size:.825rem;color:var(--muted);display:flex;align-items:center;gap:.35rem;}
.card-badges{display:flex;gap:.4rem;flex-wrap:wrap;margin-top:auto;padding-top:.5rem;}
.badge{font-size:.72rem;font-weight:600;padding:.2rem .55rem;border-radius:99px;background:#e8f5e9;color:var(--dark);}
.badge.junior{background:#e0f7fa;color:#006064;}
.card-cta{
  display:block;margin:.75rem 1.1rem 1rem;padding:.55rem 1rem;
  background:linear-gradient(135deg,var(--green),var(--dark));
  color:#fff;border-radius:8px;font-weight:600;font-size:.875rem;
  text-align:center;transition:opacity .2s;
}
.card-cta:hover{opacity:.88;}
.hotel-cta{
  background:linear-gradient(135deg,var(--dark),#1b5e20);
  border-radius:var(--radius);padding:2rem 1.75rem;
  display:flex;align-items:center;justify-content:space-between;
  gap:1.5rem;margin-bottom:2.5rem;flex-wrap:wrap;
}
.hotel-cta-text h2{font-family:'DM Serif Display',serif;font-size:1.5rem;color:#fff;margin-bottom:.3rem;}
.hotel-cta-text p{font-size:.9rem;color:rgba(255,255,255,.75);}
.hotel-cta-btn{
  background:#fff;color:var(--dark);font-weight:700;font-size:.95rem;
  padding:.75rem 1.75rem;border-radius:10px;white-space:nowrap;
  border:none;cursor:pointer;transition:transform .2s,box-shadow .2s;flex-shrink:0;
}
.hotel-cta-btn:hover{transform:translateY(-2px);box-shadow:0 6px 20px rgba(0,0,0,.18);}
#stay22-modal{
  display:none;position:fixed;inset:0;z-index:9999;
  background:rgba(0,0,0,.6);backdrop-filter:blur(6px);
  align-items:center;justify-content:center;padding:1rem;
}
#stay22-modal.open{display:flex;}
.stay22-inner{
  background:#fff;border-radius:16px;width:100%;max-width:900px;max-height:90vh;
  display:flex;flex-direction:column;overflow:hidden;
  box-shadow:0 32px 80px rgba(0,0,0,.35);
}
.stay22-header{
  padding:.85rem 1.1rem;border-bottom:1px solid #eee;
  display:flex;align-items:center;justify-content:space-between;flex-shrink:0;
}
.stay22-header span{font-weight:700;font-size:.95rem;}
.stay22-close{
  background:rgba(0,0,0,.07);border:none;border-radius:50%;
  width:28px;height:28px;cursor:pointer;font-size:14px;
  display:flex;align-items:center;justify-content:center;color:#555;
}
.stay22-close:hover{background:rgba(0,0,0,.14);}
#stay22-iframe{flex:1;border:none;min-height:480px;}
.stats-bar{
  display:flex;gap:2rem;margin-bottom:2rem;flex-wrap:wrap;
  background:var(--surface);border:1px solid var(--border);
  border-radius:var(--radius);padding:1rem 1.5rem;
}
.stat{display:flex;flex-direction:column;}
.stat-value{font-family:'DM Serif Display',serif;font-size:1.6rem;color:var(--dark);line-height:1;}
.stat-label{font-size:.775rem;color:var(--muted);margin-top:.2rem;}
.country-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:1rem;}
.country-card{
  background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);
  padding:1.25rem 1.4rem;transition:box-shadow .2s,transform .2s;
}
.country-card:hover{box-shadow:0 6px 24px rgba(46,125,50,.12);transform:translateY(-2px);}
.country-card h3{font-weight:700;font-size:1rem;margin-bottom:.2rem;}
.country-card p{font-size:.825rem;color:var(--muted);}
footer{
  background:var(--surface);border-top:1px solid var(--border);
  padding:1.5rem 2rem;text-align:center;font-size:.8rem;color:var(--muted);
}
.leaflet-control-attribution{display:none!important;}
@media(max-width:640px){
  .page-hero h1{font-size:2rem;}
  main{padding:1.25rem 1rem 3rem;}
  .hotel-cta{flex-direction:column;text-align:center;}
  .hotel-cta-btn{width:100%;}
}
</style>`;
}

function htmlHeader() {
  return `<header>
  <a class="brand" href="https://www.parkrunnertourist.com">${SITE_NAME}</a>
  <a class="map-btn" href="https://www.parkrunnertourist.com/webapp" target="_blank">Full Map</a>
</header>`;
}

function htmlFooter() {
  return `<footer>
  <p style="max-width:800px;margin:0 auto .5rem;">
    parkrun is a registered trademark of parkrun Limited.
    This website is independent and is not affiliated with or endorsed by parkrun.
  </p>
  &copy; ${new Date().getFullYear()} ${SITE_NAME}
</footer>`;
}

function breadcrumb(crumbs) {
  const parts = crumbs.map((c, i) =>
    i < crumbs.length - 1
      ? `<a href="${c.href}">${c.label}</a><span>/</span>`
      : `<span>${c.label}</span>`
  ).join('');
  return `<div class="breadcrumb"><a href="${BASE_LOCATIONS_URL}/index.html">All Locations</a><span>/</span>${parts}</div>`;
}

function stay22Modal() {
  return `
<div id="stay22-modal">
  <div class="stay22-inner">
    <div class="stay22-header">
      <span id="stay22-modal-title">Find Hotels</span>
      <button class="stay22-close" onclick="closeStay22()">&times;</button>
    </div>
    <iframe id="stay22-iframe" src="" title="Find hotels near parkrun events"></iframe>
  </div>
</div>
<script>
function openStay22(lat, lon, name) {
  var date = (function(){
    var d = new Date(), day = d.getDay(), diff = (5 - day + 7) % 7 || 7;
    d.setDate(d.getDate() + diff);
    return d.toISOString().slice(0, 10);
  })();
  var url = 'https://www.stay22.com/embed/gm?aid=parkrunnertourist'
    + '&lat=' + lat + '&lng=' + lon + '&maincolor=4caf50'
    + '&venue=' + encodeURIComponent(name) + '&checkin=' + date
    + '&viewmode=listview&listviewexpand=true';
  document.getElementById('stay22-iframe').src = url;
  document.getElementById('stay22-modal-title').textContent = 'Hotels near ' + name;
  document.getElementById('stay22-modal').classList.add('open');
}
function closeStay22() {
  document.getElementById('stay22-modal').classList.remove('open');
  document.getElementById('stay22-iframe').src = '';
}
document.getElementById('stay22-modal').addEventListener('click', function(e) {
  if (e.target === this) closeStay22();
});
</script>`;
}

function searchScript(inputId, cardClass) {
  return `<script>
(function() {
  var inp = document.getElementById('${inputId}');
  if (!inp) return;
  inp.addEventListener('input', function() {
    var q = this.value.toLowerCase().trim();
    document.querySelectorAll('.${cardClass}').forEach(function(el) {
      var text = (el.dataset.search || el.textContent).toLowerCase();
      el.style.display = (!q || text.includes(q)) ? '' : 'none';
    });
  });
})();
</script>`;
}

// ---------------------------------------------------------------------------
// Event card — Leaflet mini-map with encrypted course route preview
// ---------------------------------------------------------------------------
function eventCardHtml(ev) {
  const { slug, longName, lat, lon, city, isJunior } = ev;
  const subfolder = getExploreSubfolder(slug);
  const eventUrl  = `${BASE_EXPLORE_URL}/${subfolder}/${slug}`;
  const seed      = eventSeed(ev.eventName);
  const hasRoute  = ev.route && ev.route.length > 1;
  const encRoute  = hasRoute ? `"${encryptCoords(ev.route, seed)}"` : 'null';
  const mapId     = `map-${slug.replace(/[^a-z0-9]/g, '')}`;
  const accent    = isJunior ? ACCENT_JR : ACCENT;
  const cityBadge = city ? `<span class="card-location"><i class="fas fa-map-marker-alt"></i> ${city}</span>` : '';
  const typeBadge = isJunior ? `<span class="badge junior">Junior</span>` : `<span class="badge">5k</span>`;

  return `<div class="event-card" data-search="${longName.toLowerCase()} ${(city || '').toLowerCase()}">
  <div class="card-map"><div id="${mapId}" style="height:180px;"></div></div>
  <div class="card-body">
    <div class="card-title">${longName}</div>
    ${cityBadge}
    <div class="card-badges">${typeBadge}</div>
  </div>
  <a href="${eventUrl}" class="card-cta" target="_blank">View Guide &amp; Hotels</a>
</div>
<script>
(function() {
  ${decryptFnJs()}
  var el = document.getElementById('${mapId}');
  if (!el) return;
  var map = L.map('${mapId}', {
    zoomControl: false, dragging: false, scrollWheelZoom: false,
    doubleClickZoom: false, boxZoom: false, keyboard: false,
    tap: false, touchZoom: false, attributionControl: false
  });
  L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', { maxZoom: 18 }).addTo(map);
  var enc = ${encRoute};
  if (enc) {
    var route = _d(enc, ${seed});
    var lls = route.map(function(p) { return [p[1], p[0]]; });
    L.polyline(lls, { color: '${accent}', weight: 3.5, opacity: .9 }).addTo(map);
    L.circleMarker(lls[0], { radius: 6, fillColor: '${accent}', color: '#fff', weight: 2, fillOpacity: 1 }).addTo(map);
    L.circleMarker(lls[lls.length - 1], { radius: 6, fillColor: '#dc3545', color: '#fff', weight: 2, fillOpacity: 1 }).addTo(map);
    map.fitBounds(L.latLngBounds(lls), { padding: [16, 16], animate: false });
  } else {
    map.setView([${lat}, ${lon}], 14);
    L.circleMarker([${lat}, ${lon}], { radius: 8, fillColor: '${accent}', color: '#fff', weight: 2.5, fillOpacity: 1 }).addTo(map);
  }
})();
</script>`;
}

// ---------------------------------------------------------------------------
// Page generators
// ---------------------------------------------------------------------------
function generateWorldIndex(countries) {
  const sorted = Object.entries(countries).sort((a, b) => a[0].localeCompare(b[0]));
  const totalEvents = sorted.reduce((s, [, d]) => s + d.totalEvents, 0);

  const cards = sorted.map(([cSlug, d]) => `
<a href="${cSlug}/index.html" class="country-card">
  <h3>${d.name}</h3>
  <p>${d.totalEvents} event${d.totalEvents !== 1 ? 's' : ''} &middot; ${d.regions.length} region${d.regions.length !== 1 ? 's' : ''}</p>
</a>`).join('');

  return `${htmlHead({
    title: 'parkrun Tourist — Browse Events by Location',
    description: 'Find parkrun events near you. Browse by country, region and city. View course maps, nearby hotels and visitor guides.',
    canonicalPath: 'index.html',
  })}
<body>
${sharedStyles()}
${htmlHeader()}
<main>
  <div class="page-hero">
    <h1>Browse by Location</h1>
    <p>Find parkrun events near you — browse by country, region and city, then plan your visit with hotels, course maps and weather.</p>
  </div>
  <div class="stats-bar">
    <div class="stat"><span class="stat-value">${totalEvents.toLocaleString()}</span><span class="stat-label">Total events</span></div>
    <div class="stat"><span class="stat-value">${sorted.length}</span><span class="stat-label">Countries</span></div>
  </div>
  <div class="section-label">Select a country</div>
  <div class="country-grid">${cards}</div>
</main>
${htmlFooter()}
</body></html>`;
}

function generateCountryPage(countrySlug, countryData) {
  const { name, regions, totalEvents } = countryData;
  const c = centroid(regions.flatMap(r => r.events));
  const showSearch = regions.length >= SEARCH_THRESHOLD;

  const tiles = regions
    .sort((a, b) => b.events.length - a.events.length)
    .map(r => `
<a href="${r.slug}/index.html" class="tile" data-search="${r.name.toLowerCase()}">
  <span class="tile-name">${r.name}</span>
  <span class="tile-count">${r.events.length}</span>
</a>`).join('');

  return `${htmlHead({
    title: `${name} parkrun Events — Hotels &amp; Visitor Guides`,
    description: `Browse all parkrun events in ${name} by region. View course maps, find hotels and plan your visit with parkrunner tourist.`,
    canonicalPath: `${countrySlug}/index.html`,
    lat: c.lat, lon: c.lon, locationName: name,
  })}
<body>
${sharedStyles()}
${htmlHeader()}
${breadcrumb([{ label: name }])}
<main>
  <div class="page-hero">
    <h1>${name}</h1>
    <p>${totalEvents} parkrun event${totalEvents !== 1 ? 's' : ''} across ${regions.length} region${regions.length !== 1 ? 's' : ''}</p>
  </div>
  <div class="hotel-cta">
    <div class="hotel-cta-text">
      <h2>Need accommodation in ${name}?</h2>
      <p>Compare hotels and rentals near any parkrun event.</p>
    </div>
    <button class="hotel-cta-btn" onclick="openStay22(${c.lat},${c.lon},'${name.replace(/'/g, "\\'")} parkrun events')">Find Hotels</button>
  </div>
  ${showSearch ? `<div class="search-wrap"><i class="fas fa-search search-icon"></i><input id="region-search" class="search-input" type="text" placeholder="Search regions in ${name}..." /></div>` : ''}
  <div class="section-label">Regions</div>
  <div class="tile-grid" id="region-grid">${tiles}</div>
</main>
${htmlFooter()}
${stay22Modal()}
${showSearch ? searchScript('region-search', 'tile') : ''}
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
</body></html>`;
}

function generateRegionPage(countrySlug, countryName, regionSlug, regionData) {
  const { name, cities, events } = regionData;
  const c = centroid(events);
  const showSearch = events.length >= SEARCH_THRESHOLD;
  const hasCities = Object.keys(cities).length > 1;

  const cityTiles = Object.entries(cities)
    .sort((a, b) => b[1].length - a[1].length)
    .map(([cSlug, evs]) => {
      const cityName = evs[0].city || cSlug;
      return `<a href="${cSlug}/index.html" class="tile" data-search="${cityName.toLowerCase()}">
  <span class="tile-name">${cityName}</span>
  <span class="tile-count">${evs.length}</span>
</a>`;
    }).join('');

  const cards = events
    .sort((a, b) => a.longName.localeCompare(b.longName))
    .map(ev => eventCardHtml(ev)).join('\n');

  return `${htmlHead({
    title: `${name} parkrun Events — Hotels &amp; Visitor Guides`,
    description: `All parkrun events in ${name}. Browse course maps, find nearby hotels, check weather forecasts and plan your perfect parkrun weekend.`,
    canonicalPath: `${countrySlug}/${regionSlug}/index.html`,
    lat: c.lat, lon: c.lon, locationName: name,
  })}
<body>
${sharedStyles()}
${htmlHeader()}
${breadcrumb([
    { label: countryName, href: `${BASE_LOCATIONS_URL}/${countrySlug}/index.html` },
    { label: name },
  ])}
<main>
  <div class="page-hero">
    <h1>${name}</h1>
    <p>${events.length} parkrun event${events.length !== 1 ? 's' : ''} in this region</p>
  </div>
  <div class="hotel-cta">
    <div class="hotel-cta-text">
      <h2>Need accommodation in ${name}?</h2>
      <p>Compare hotels and rentals near any ${name} parkrun event.</p>
    </div>
    <button class="hotel-cta-btn" onclick="openStay22(${c.lat},${c.lon},'${name.replace(/'/g, "\\'")} parkrun')">Find Hotels</button>
  </div>
  ${hasCities ? `<div class="section-label">Browse by city</div><div class="tile-grid" style="margin-bottom:2rem;">${cityTiles}</div>` : ''}
  ${showSearch ? `<div class="search-wrap"><i class="fas fa-search search-icon"></i><input id="event-search" class="search-input" type="text" placeholder="Search events in ${name}..." /></div>` : ''}
  <div class="section-label">All events in ${name}</div>
  <div class="event-grid" id="event-grid">${cards}</div>
</main>
${htmlFooter()}
${stay22Modal()}
${showSearch ? searchScript('event-search', 'event-card') : ''}
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
</body></html>`;
}

function generateCityPage(countrySlug, countryName, regionSlug, regionName, citySlug, cityEvents) {
  const cityName = cityEvents[0].city || citySlug;
  const c = centroid(cityEvents);
  const showSearch = cityEvents.length >= SEARCH_THRESHOLD;

  const cards = cityEvents
    .sort((a, b) => a.longName.localeCompare(b.longName))
    .map(ev => eventCardHtml(ev)).join('\n');

  return `${htmlHead({
    title: `parkrun Events in ${cityName} — Hotels &amp; Visitor Guides`,
    description: `All parkrun events in ${cityName}, ${regionName}. Browse course maps, find nearby hotels and plan your parkrun visit.`,
    canonicalPath: `${countrySlug}/${regionSlug}/${citySlug}/index.html`,
    lat: c.lat, lon: c.lon, locationName: cityName,
  })}
<body>
${sharedStyles()}
${htmlHeader()}
${breadcrumb([
    { label: countryName, href: `${BASE_LOCATIONS_URL}/${countrySlug}/index.html` },
    { label: regionName, href: `${BASE_LOCATIONS_URL}/${countrySlug}/${regionSlug}/index.html` },
    { label: cityName },
  ])}
<main>
  <div class="page-hero">
    <h1>${cityName}</h1>
    <p>${cityEvents.length} parkrun event${cityEvents.length !== 1 ? 's' : ''} in ${cityName}</p>
  </div>
  <div class="hotel-cta">
    <div class="hotel-cta-text">
      <h2>Staying in ${cityName}?</h2>
      <p>Find hotels and rentals near your parkrun event.</p>
    </div>
    <button class="hotel-cta-btn" onclick="openStay22(${c.lat},${c.lon},'${cityName.replace(/'/g, "\\'")} parkrun')">Find Hotels</button>
  </div>
  ${showSearch ? `<div class="search-wrap"><i class="fas fa-search search-icon"></i><input id="event-search" class="search-input" type="text" placeholder="Search events in ${cityName}..." /></div>` : ''}
  <div class="section-label">Events in ${cityName}</div>
  <div class="event-grid" id="event-grid">${cards}</div>
</main>
${htmlFooter()}
${stay22Modal()}
${showSearch ? searchScript('event-search', 'event-card') : ''}
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
</body></html>`;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  console.log('Fetching events JSON...');
  const data = await fetchJson(EVENTS_URL);
  let events;
  if (Array.isArray(data)) events = data;
  else if (Array.isArray(data.features)) events = data.features;
  else if (data.events && Array.isArray(data.events.features)) events = data.events.features;
  else throw new Error('Unexpected JSON structure');

  console.log('Fetching course maps...');
  let courseMaps = {};
  try {
    courseMaps = await fetchJson(COURSE_MAPS_URL);
    console.log(`Loaded ${Object.keys(courseMaps).length} course map entries.`);
  } catch (e) { console.warn('Could not load course maps:', e.message); }

  const limited = EVENT_LIMIT > 0 ? events.slice(0, EVENT_LIMIT) : events;
  console.log(`Processing ${limited.length} events...`);

  // ---- Build minimal event list for geocoding pass -------------------------
  const rawEvents = limited.map(ev => {
    const props  = ev.properties || {};
    const coords = (ev.geometry && ev.geometry.coordinates) || [0, 0];
    return {
      eventName:   props.eventname || '',
      longName:    props.EventLongName || props.eventname || '',
      slug:        slugify(props.eventname || ''),
      countryCode: String(props.countrycode || '0'),
      lat:         coords[1] || 0,
      lon:         coords[0] || 0,
    };
  });

  // ---- Resolve all coordinates via Nominatim (cache-first) -----------------
  const cache = loadCache();
  await geocodeAllEvents(rawEvents, cache);

  // ---- Enrich with geocoded admin data and course routes -------------------
  const enriched = rawEvents.map(ev => {
    const address = cache[cacheKey(ev.lat, ev.lon)] || null;
    const { city, region } = extractFromAddress(address, ev.countryCode);
    const isJunior = ev.longName.toLowerCase().includes('junior');

    const courseKey = Object.keys(courseMaps).find(k =>
      k === ev.eventName ||
      k === ev.eventName.toLowerCase() ||
      k === ev.slug ||
      k.replace(/-/g, '').toLowerCase() === ev.eventName.replace(/\s+/g, '').toLowerCase()
    );
    const courseData = courseKey ? courseMaps[courseKey] : null;
    const route = (courseData && Array.isArray(courseData.route) && courseData.route.length > 1)
      ? courseData.route : null;

    return { ...ev, isJunior, city, region, route };
  });

  // ---- Build 3-tier hierarchy ----------------------------------------------
  const hierarchy = {};

  for (const ev of enriched) {
    const meta        = COUNTRY_META[ev.countryCode] || { name: 'Unknown' };
    const countryName = meta.name;
    const countrySlug = slugify(countryName);
    const regionName  = ev.region || countryName;
    const regionSlug  = slugify(regionName);
    const cityName    = ev.city || regionName;
    const citySlug    = slugify(cityName);

    if (!hierarchy[countrySlug]) {
      hierarchy[countrySlug] = { name: countryName, regions: {}, totalEvents: 0 };
    }
    hierarchy[countrySlug].totalEvents++;

    const regions = hierarchy[countrySlug].regions;
    if (!regions[regionSlug]) {
      regions[regionSlug] = { name: regionName, slug: regionSlug, cities: {}, events: [] };
    }
    regions[regionSlug].events.push(ev);

    const cities = regions[regionSlug].cities;
    if (!cities[citySlug]) cities[citySlug] = [];
    cities[citySlug].push(ev);
  }

  // ---- Write all HTML files ------------------------------------------------
  ensure(OUTPUT_DIR);

  const countryList = Object.fromEntries(
    Object.entries(hierarchy).map(([cs, cd]) => [cs, {
      name: cd.name,
      totalEvents: cd.totalEvents,
      regions: Object.values(cd.regions),
    }])
  );

  fs.writeFileSync(path.join(OUTPUT_DIR, 'index.html'), generateWorldIndex(countryList), 'utf-8');
  console.log('Generated: locations/index.html');
  let pageCount = 1;

  for (const [countrySlug, countryData] of Object.entries(hierarchy)) {
    const countryDir = path.join(OUTPUT_DIR, countrySlug);
    ensure(countryDir);

    fs.writeFileSync(
      path.join(countryDir, 'index.html'),
      generateCountryPage(countrySlug, { ...countryData, regions: Object.values(countryData.regions) }),
      'utf-8'
    );
    console.log(`Generated: locations/${countrySlug}/index.html`);
    pageCount++;

    for (const [regionSlug, regionData] of Object.entries(countryData.regions)) {
      const regionDir = path.join(countryDir, regionSlug);
      ensure(regionDir);

      fs.writeFileSync(
        path.join(regionDir, 'index.html'),
        generateRegionPage(countrySlug, countryData.name, regionSlug, regionData),
        'utf-8'
      );
      console.log(`Generated: locations/${countrySlug}/${regionSlug}/index.html`);
      pageCount++;

      for (const [citySlug, cityEvents] of Object.entries(regionData.cities)) {
        if (citySlug === regionSlug || !cityEvents.length) continue;

        const cityDir = path.join(regionDir, citySlug);
        ensure(cityDir);
        fs.writeFileSync(
          path.join(cityDir, 'index.html'),
          generateCityPage(countrySlug, countryData.name, regionSlug, regionData.name, citySlug, cityEvents),
          'utf-8'
        );
        console.log(`Generated: locations/${countrySlug}/${regionSlug}/${citySlug}/index.html`);
        pageCount++;
      }
    }
  }

  console.log(`\nDone. ${pageCount} location pages generated in ./locations/`);
}

main().catch(err => { console.error(err); process.exit(1); });
