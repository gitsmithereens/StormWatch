#!/usr/bin/env node
// 8 AM nor'easter heads-up for the DogWalk ntfy topics.
//
// Runs the SAME detector the dashboard panel uses: the pure block between the NOR-CORE markers in
// index.html is extracted and evaluated here, so the alert and the panel can't drift apart.
// Inputs mirror the panel's: NBM/default-blend wind + hindcast-free marine seas for this location,
// Mayport water level vs tide + wind, land and marine-zone NWS alerts, and the JAX forecast discussion.
//
// Sends only when a moderate-or-stronger event is expected or under way (minor ones are routine
// breezy-northeast days, and the panel already shows those). Best-effort throughout: a flaky API
// must never fail the workflow, so every failure path logs and exits 0.
//
// env: LAT, LON, TOPIC (from the workflow matrix); DRY_RUN=true prints instead of sending.

const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '..', '..', 'index.html'), 'utf8');
const m = html.match(/\/\/ <<NOR-CORE-START>>([\s\S]*?)\/\/ <<NOR-CORE-END>>/);
if (!m) { console.log('NOR-CORE markers not found in index.html - skipping'); process.exit(0); }
const core = new Function(m[1] +
  '\nreturn { NOR, assessNoreaster, norBuildHours, norEasternKey, norComputeSurge, norObsWind, norParseAFD };')();

const { LAT, LON, TOPIC, DRY_RUN } = process.env;
if (!LAT || !LON || !TOPIC) { console.log('LAT/LON/TOPIC not set - skipping'); process.exit(0); }

const HEADERS = { 'User-Agent': 'dogwalk-alerts (github.com/gitsmithereens/StormWatch)', Accept: 'application/json' };
const getJson = async url => {
  const r = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
};
const soft = async (label, fn) => {
  try { return await fn(); } catch (e) { console.log('  (' + label + ' unavailable: ' + e.message + ')'); return null; }
};

const fmtT = sec => {
  const d = new Date(sec * 1000), z = { timeZone: 'America/New_York' };
  return d.toLocaleDateString('en-US', { ...z, weekday: 'short' }) + ' ' + d.toLocaleTimeString('en-US', { ...z, hour: 'numeric' });
};
const ascii = s => s.replace(/[  ]/g, ' ').replace(/[^\x20-\x7E]/g, '');   // ntfy treats non-ASCII bodies as file attachments

const haversineMiles = (lat1, lon1, lat2, lon2) => {
  const R = 3958.8, rad = d => d * Math.PI / 180;
  const a = Math.sin(rad(lat2 - lat1) / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(rad(lon2 - lon1) / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
};
const STORM_LABEL = { HU: 'Hurricane', TS: 'Tropical Storm', TD: 'Tropical Depression', STS: 'Subtropical Storm',
                      STD: 'Subtropical Depression', PTC: 'Potential Tropical Cyclone' };

// Nearest ATLANTIC tropical system within 900 mi (same rule as the dashboard panel), or null. A hurricane's
// wind field reads as a nor'easter to the detector, so say so in one short sentence.
async function nearbyStorm() {
  if (process.env.FAKE_STORM) {   // "Name,lat,lon,CLASS" - test hook, removed after validation
    const [name, lat, lon, cls] = process.env.FAKE_STORM.split(',');
    return { name, cls, mi: haversineMiles(+LAT, +LON, +lat, +lon) };
  }
  const j = await getJson('https://www.nhc.noaa.gov/CurrentStorms.json');
  const near = (j.activeStorms || []).filter(s => /^al/i.test(s.id) && isFinite(s.latitudeNumeric) && isFinite(s.longitudeNumeric))
    .map(s => ({ name: s.name, cls: s.classification, mi: haversineMiles(+LAT, +LON, s.latitudeNumeric, s.longitudeNumeric) }))
    .filter(s => s.mi < 900).sort((a, b) => a.mi - b.mi);
  return near[0] || null;
}

async function main() {
  const now = Date.now();
  const dayKey = off => core.norEasternKey(now + off * 86400000).slice(0, 10).replace(/-/g, '');
  const co = (product, extra) => 'https://api.tidesandcurrents.noaa.gov/api/prod/datagetter?station=8720218&product=' + product +
    '&time_zone=lst_ldt&units=english&format=json' + extra;
  const tz = 'America%2FNew_York';

  const [fc, mar, lvl, pred, hilo, wnd, marAl, landAl, afdText] = await Promise.all([
    soft('forecast', () => getJson('https://api.open-meteo.com/v1/forecast?latitude=' + LAT + '&longitude=' + LON +
      '&hourly=wind_speed_10m,wind_direction_10m,wind_gusts_10m,pressure_msl&models=ncep_nbm_conus,best_match' +
      '&past_hours=12&forecast_hours=84&wind_speed_unit=mph&timeformat=unixtime&timezone=' + tz)),
    soft('marine', () => getJson('https://marine-api.open-meteo.com/v1/marine?latitude=' + LAT + '&longitude=' + LON +
      '&hourly=wave_height,wave_direction,wave_period&past_hours=12&forecast_hours=84&length_unit=imperial&timeformat=unixtime&timezone=' + tz)),
    soft('water level', () => getJson(co('water_level', '&datum=MLLW&begin_date=' + dayKey(-1) + '&end_date=' + dayKey(0)))),
    soft('tide predictions', () => getJson(co('predictions', '&datum=MLLW&interval=6&begin_date=' + dayKey(-1) + '&end_date=' + dayKey(2)))),
    soft('high/low tides', () => getJson(co('predictions', '&datum=MLLW&interval=hilo&begin_date=' + dayKey(0) + '&end_date=' + dayKey(2)))),
    soft('observed wind', () => getJson(co('wind', '&begin_date=' + dayKey(-1) + '&end_date=' + dayKey(0)))),
    soft('marine alerts', () => getJson('https://api.weather.gov/alerts/active?zone=' + core.NOR.marineZone)),
    soft('land alerts', () => getJson('https://api.weather.gov/alerts/active?point=' + LAT + ',' + LON)),
    soft('forecast discussion', async () => {
      const list = await getJson('https://api.weather.gov/products/types/AFD/locations/JAX');
      const id = list && list['@graph'] && list['@graph'][0] && list['@graph'][0].id;
      return id ? (await getJson('https://api.weather.gov/products/' + id)).productText : null;
    })
  ]);

  if (!(fc && fc.hourly && Array.isArray(fc.hourly.time))) { console.log('no wind forecast - cannot assess, skipping'); return; }

  const hours = core.norBuildHours({ hourly: fc.hourly }, mar && mar.hourly && Array.isArray(mar.hourly.time) ? { hourly: mar.hourly } : null);
  const surge = core.norComputeSurge(lvl && lvl.data, pred && pred.predictions, hilo && hilo.predictions, core.norEasternKey(now));
  const obs = core.norObsWind(wnd && wnd.data);
  const alerts = []
    .concat(((landAl && landAl.features) || []).map(f => ({ event: f.properties.event, src: 'land' })))
    .concat(((marAl && marAl.features) || []).map(f => ({ event: f.properties.event, src: 'marine' })));
  const afd = afdText ? core.norParseAFD(afdText) : null;

  const res = core.assessNoreaster({ nowSec: Math.floor(now / 1000), hours, surge, obs, alerts, afd });
  console.log('assessment: level=' + res.level + ' severity=' + res.severity + ' total=' + res.total + ' (' + hours.length + ' hourly rows)');
  res.evidence.forEach(e => console.log('  +' + e.pts + ' ' + e.k + ': ' + e.text));

  const worthy = (res.level === 'watch' || res.level === 'active') && (res.severity === 'moderate' || res.severity === 'strong');
  if (!worthy) {
    if (process.env.FORCE_SEND === 'true') {   // delivery test only, removed after validation
      const ping = 'Test: nor\'easter heads-ups are set up. You will get one at 8 AM when a moderate or stronger one is expected or under way.';
      if (DRY_RUN === 'true') { console.log('DRY RUN - would send test ping: ' + ping); return; }
      const rp = await fetch('https://ntfy.sh/' + TOPIC, { method: 'POST', body: ping, headers: { Title: 'DogWalk', Tags: 'ocean' } });
      console.log('sent test ping (HTTP ' + rp.status + ')');
      return;
    }
    console.log('no nor\'easter alert needed'); return;
  }

  const w = res.window, sg = res.now.surge;
  const peak = w ? 'gusts ~' + Math.round(w.peakGust) + ' mph' + (w.peakWave >= 3 ? ', seas ~' + Math.round(w.peakWave) + ' ft' : '') : null;
  let msg;
  if (res.level === 'watch') {
    msg = 'Nor\'easter expected (' + res.severity + '): north-to-northeast wind from ' + fmtT(w.start) + ', ' + peak + '. Plan walks and beach trips around it.';
  } else {
    msg = 'Nor\'easter active (' + res.severity + '): ' + (peak ? peak + (w.end < Date.now() / 1000 + 70 * 3600 ? ', easing ~' + fmtT(w.end) : ', lasting past 72 h')
      : res.evidence.filter(e => e.k === 'seas' || e.k === 'obs').map(e => e.text).join(', '));
    if (sg && sg.now >= 0.8) msg += '. Water +' + sg.now.toFixed(1) + ' ft above tide' +
      (sg.nextHigh && sg.nextHigh.proj >= core.NOR.flood.minor ? ', next high tide ~' + sg.nextHigh.proj.toFixed(1) + ' ft vs ' + core.NOR.flood.minor + ' ft flood stage' : '');
    msg += '.';
  }
  const storm = await soft('NHC storms', nearbyStorm);
  if (storm) msg += ' ' + (STORM_LABEL[storm.cls] || 'Tropical system') + ' ' + storm.name + ' ~' + Math.round(storm.mi) + ' mi away may be feeding this.';
  msg = ascii(msg);

  if (DRY_RUN === 'true') { console.log('DRY RUN - would send: ' + msg); return; }
  const r = await fetch('https://ntfy.sh/' + TOPIC, { method: 'POST', body: msg, headers: { Title: 'DogWalk', Tags: 'ocean' } });
  console.log('sent (HTTP ' + r.status + '): ' + msg);
}

main().catch(e => { console.log('nor\'easter check failed (ignored): ' + e.message); }).then(() => process.exit(0));
