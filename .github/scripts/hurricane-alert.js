#!/usr/bin/env node
// Hurricane heads-up for the DogWalk ntfy topics.
//
// Runs the SAME hazard logic the dashboard's Hurricane tab uses: the pure block between the HURR-CORE markers in
// index.html is extracted and evaluated here (cone containment, closest approach, wind-radii reach), so the alert and
// the tab can't disagree about whether a storm matters to this location.
//
// Sends only when it is actually about to matter here:
//   - NWS has a tropical Watch/Warning (hurricane, tropical storm, storm surge) in effect for this point, or
//   - NHC's forecast puts tropical-storm- or hurricane-force wind at this location, or this location in the cone.
// A storm that is merely nearby ("indirect effects possible") stays panel-only, same philosophy as the nor'easter alert.
//
// Stateless de-duplication: the workflow runs hourly and each situation gets a key; before sending we read the topic's
// last 12 h of messages from ntfy itself (each message carries its key in its Click URL) and skip if that key was
// already sent. A changed situation (new warning type, storm escalates) is a new key and notifies again.
//
// Best-effort throughout: every failure path logs and exits 0 so a flaky feed never paints the workflow red.
//
// env: LAT, LON, TOPIC, PLACE (from the workflow matrix); DRY_RUN=true prints instead of sending;
//      SIMULATE=warning|threat|direct sends a clearly-labelled TEST message from synthetic data (no NHC calls).

const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '..', '..', 'index.html'), 'utf8');
const m = html.match(/\/\/ <<HURR-CORE-START>>([\s\S]*?)\/\/ <<HURR-CORE-END>>/);
if (!m) { console.log('HURR-CORE markers not found in index.html - skipping'); process.exit(0); }
const core = new Function(m[1] +
  '\nreturn { HURR, hurrResolveLayers, hurrBuildStorm, hurrAssess, hurrMiles, hurrBearing, hurrCompass };')();

const { LAT, LON, TOPIC, PLACE, DRY_RUN } = process.env;
const SIMULATE = process.env.SIMULATE && process.env.SIMULATE !== 'none' ? process.env.SIMULATE : '';   // the dispatch menu's "none"
if (!LAT || !LON || !TOPIC) { console.log('LAT/LON/TOPIC not set - skipping'); process.exit(0); }
const HOME = { lat: +LAT, lon: +LON };
const PLACE_NAME = PLACE || 'your location';
const SITE = 'https://gitsmithereens.github.io/StormWatch/';

const HEADERS = { 'User-Agent': 'dogwalk-alerts (github.com/gitsmithereens/StormWatch)', Accept: 'application/geo+json' };
const getJson = async (url, ms) => {
  const r = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(ms || 20000) });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const j = await r.json();
  if (j && j.error) throw new Error('service error ' + (j.error.code || ''));   // ArcGIS: HTTP 200 + {error}
  return j;
};
const soft = async (label, fn) => {
  try { return await fn(); } catch (e) { console.log('  (' + label + ' unavailable: ' + e.message + ')'); return null; }
};

// <<COMPOSE-START>>
// Pure message composition + de-dup key, kept in a marked block so it can be exercised without Node.
const fmtT = ms => {
  const d = new Date(ms), z = { timeZone: 'America/New_York' };
  return d.toLocaleDateString('en-US', Object.assign({ weekday: 'short' }, z)) + ' ' +
         d.toLocaleTimeString('en-US', Object.assign({ hour: 'numeric' }, z));
};
// ntfy treats a non-ASCII body as a file attachment; newer ICU also puts U+202F before AM/PM
const ascii = s => s.replace(new RegExp('[' + String.fromCharCode(0x202f, 0xa0) + ']', 'g'), ' ').replace(/[^\x20-\x7E]/g, '');
const TROPICAL_ALERT = /^(Hurricane|Tropical Storm|Storm Surge|Extreme Wind) (Warning|Watch)$/;
const ALERT_RANK = e => (/Warning/.test(e) ? 10 : 0) + (/^Hurricane|^Extreme/.test(e) ? 5 : /^Storm Surge/.test(e) ? 3 : 1);

// in:  { place, events: [NWS tropical event names in effect here], storm: {title, mph, mi, compass} | null,
//        level: 'far'|'near'|'threat'|'direct', inCone: bool|null, ca: {mi, t} | null }
// out: { key, text, urgent } or null when there is nothing worth a push.
function composeHurricane(x) {
  const events = (x.events || []).slice().sort((a, b) => ALERT_RANK(b) - ALERT_RANK(a));
  const lvl = x.level === 'direct' || x.level === 'threat' ? x.level : null;
  if (!events.length && !lvl) return null;
  const st = x.storm;
  const stormNow = st ? st.title + ' is ~' + Math.round(st.mi) + ' mi ' + st.compass + ' of ' + x.place + ', ' + st.mph + ' mph.' : '';
  const when = x.ca && x.ca.t ? ' around ' + fmtT(x.ca.t) : '';
  const close = x.ca ? ' (closest ~' + Math.round(x.ca.mi) + ' mi)' : '';
  let lead;
  if (lvl === 'direct') lead = (st ? st.title : 'A hurricane') + ': hurricane-force winds are forecast to reach ' + x.place + when + close + '.';
  else if (lvl === 'threat' && x.ts) lead = (st ? st.title : 'A tropical system') + ': tropical-storm-force winds are forecast to reach ' + x.place + when + close + '.';
  else if (lvl === 'threat') lead = x.place + ' is inside the NHC cone for ' + (st ? st.title : 'a tropical system') + ' (center passes ~' + (x.ca ? Math.round(x.ca.mi) : '?') + ' mi away' + when + ').';
  let msg;
  if (events.length) {
    const top = events.join(' + ') + ' in effect for ' + x.place + '.';
    msg = lead ? top + ' ' + lead : top + (stormNow ? ' ' + stormNow : '');
  } else {
    msg = lead;
  }
  if (lead && st) msg += ' (Now ' + Math.round(st.mi) + ' mi ' + st.compass + ', ' + st.mph + ' mph.)';
  // One key per distinct situation: which alerts are in effect + how serious the forecast is for this storm.
  const key = [events.join('+') || 'noww', lvl ? lvl + (x.ts ? '+winds' : '+cone') : 'nolvl', st ? st.title.replace(/\s+/g, '_') : 'nostorm'].join('|');
  return { key, text: ascii(msg), urgent: events.some(e => /Warning/.test(e)) || lvl === 'direct' };
}
// <<COMPOSE-END>>

const RANK = { direct: 3, threat: 2, near: 1, far: 0 };

// Active Atlantic storms from NHC's map service, each already assessed against HOME (same call the tab makes).
async function realStorms() {
  const L = core.hurrResolveLayers(await soft('layer list', () => getJson(core.HURR.svc + '?f=json', 15000)));
  const q = (id, extra) => getJson(core.HURR.svc + '/' + id + '/query?where=1%3D1&outFields=*&f=geojson&outSR=4326&geometryPrecision=3' + (extra || ''), 15000);
  const now = Date.now();
  const probes = await Promise.allSettled(core.HURR.bins.map(n => q(L[n].points)));
  if (probes.every(p => p.status === 'rejected')) throw new Error('NHC map service unreachable');
  const out = [];
  await Promise.all(core.HURR.bins.map(async (n, i) => {
    const pr = probes[i];
    if (pr.status !== 'fulfilled' || !pr.value.features || !pr.value.features.length) return;
    const l = L[n], opt = p => p.then(v => v, () => null);   // cone/radii are bonuses: missing ones just weaken the verdict
    const [cone, radii] = await Promise.all([
      opt(q(l.cone, '&maxAllowableOffset=0.02')),
      opt(getJson(core.HURR.svc + '/' + l.fcstRadii + '/query?where=1%3D1&outFields=radii,tau,ne,se,sw,nw&returnGeometry=false&f=json', 15000))
    ]);
    const s = core.hurrBuildStorm(n, { points: pr.value, cone, radii }, now);
    if (!s) return;
    const a = core.hurrAssess(s, HOME, false);   // text-only "region mentioned" can only reach 'near', which never alerts
    console.log('  ' + s.type + ' ' + s.name + ': ' + Math.round(a.distNow) + ' mi ' + a.compass + ', level=' + a.level +
      ', inCone=' + a.inCone + (a.ca ? ', closest ~' + Math.round(a.ca.mi) + ' mi' : ''));
    out.push({ title: (s.type ? s.type + ' ' : '') + s.name, mph: s.windMph, mi: a.distNow, compass: a.compass, level: a.level, inCone: a.inCone, ts: a.ts, ca: a.ca });
  }));
  return out;
}

// Tropical watches/warnings NWS has in effect for this exact point (land + coastal-water zones that cover it)
async function tropicalEvents() {
  const j = await getJson('https://api.weather.gov/alerts/active?point=' + LAT + ',' + LON);
  const ev = ((j && j.features) || []).map(f => f.properties && f.properties.event).filter(e => e && TROPICAL_ALERT.test(e));
  return Array.from(new Set(ev));
}

const SIM = {
  warning: { events: ['Tropical Storm Warning'], storm: { title: 'Hurricane Test', mph: 90, mi: 310, compass: 'SE' }, level: 'threat', inCone: true, ts: true, ca: { mi: 45, t: Date.now() + 30 * 3600e3 } },
  threat:  { events: [], storm: { title: 'Tropical Storm Test', mph: 60, mi: 420, compass: 'S' }, level: 'threat', inCone: true, ts: false, ca: { mi: 85, t: Date.now() + 40 * 3600e3 } },
  direct:  { events: ['Hurricane Watch'], storm: { title: 'Hurricane Test', mph: 115, mi: 300, compass: 'SE' }, level: 'direct', inCone: true, ca: { mi: 20, t: Date.now() + 28 * 3600e3 } }
};

// Keys already sent to this topic in the last 12 h (read back from ntfy; null = couldn't tell)
async function sentKeys() {
  const r = await fetch('https://ntfy.sh/' + TOPIC + '/json?poll=1&since=12h', { signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const keys = new Set();
  (await r.text()).split('\n').forEach(line => {
    try { const o = JSON.parse(line); const k = o.event === 'message' && o.click && /#k=(.+)$/.exec(o.click); if (k) keys.add(decodeURIComponent(k[1])); } catch (e) {}
  });
  return keys;
}

async function main() {
  let input;
  if (SIMULATE) {
    if (!SIM[SIMULATE]) { console.log('unknown SIMULATE value: ' + SIMULATE); return; }
    input = Object.assign({ place: PLACE_NAME }, SIM[SIMULATE]);
    console.log('SIMULATING "' + SIMULATE + '" (synthetic data, no NHC/NWS calls)');
  } else {
    const [storms, events] = await Promise.all([soft('NHC storms', realStorms), soft('NWS alerts', tropicalEvents)]);
    if (storms == null && events == null) { console.log('no tropical data available - cannot assess, skipping'); return; }
    const worst = (storms || []).slice().sort((a, b) => RANK[b.level] - RANK[a.level] || a.mi - b.mi)[0] || null;
    console.log('storms: ' + (storms ? storms.length : 'unknown') + ', tropical alerts here: ' + ((events || []).join(', ') || 'none'));
    input = { place: PLACE_NAME, events: events || [], storm: worst, level: worst ? worst.level : 'far', inCone: worst && worst.inCone, ts: worst && worst.ts, ca: worst && worst.ca };
  }

  const res = composeHurricane(input);
  if (!res) { console.log('no hurricane alert needed'); return; }
  const key = (SIMULATE ? 'TEST|' : '') + res.key;
  const text = (SIMULATE ? 'TEST - ' : '') + res.text;

  const seen = await soft('ntfy history', sentKeys);
  if (seen && seen.has(key)) { console.log('already sent in the last 12 h (' + key + ') - skipping: ' + text); return; }
  if (DRY_RUN === 'true') { console.log('DRY RUN - would send [' + key + ']: ' + text); return; }

  const r = await fetch('https://ntfy.sh/' + TOPIC, {
    method: 'POST', body: text,
    headers: { Title: 'StormWatch', Tags: res.urgent ? 'rotating_light' : 'cyclone', Priority: res.urgent ? '4' : '3', Click: SITE + '#k=' + encodeURIComponent(key) }
  });
  console.log('sent (HTTP ' + r.status + ') [' + key + ']: ' + text);
}

main().catch(e => { console.log('hurricane check failed (ignored): ' + e.message); }).then(() => process.exit(0));
