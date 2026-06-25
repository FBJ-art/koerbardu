// ferry-data.js — Netlify serverless function v3
// AIS via vesselfinder.com public API (no key, scrape-friendly REST endpoint)
// Fallback: barentswatch.no (Norwegian Coastal Administration — free REST API)

export default async (req) => {
  if (req.method !== 'GET') return new Response('Method not allowed', { status: 405 });

  const CORS = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json',
    'Cache-Control': 'public, max-age=30',
  };

  const FLEET = {
    219018172: { name: 'Express 2', maxCars: 411 },
    219022903: { name: 'Express 3', maxCars: 411 },
    219705000: { name: 'Express 4', maxCars: 425 },
  };

  const ODDEN = { lat: 55.9767, lon: 11.3647 };
  const SAIL_TIMES = { aarhus: 90, ebeltoft: 75 };
  const today = new Date().toISOString().slice(0, 10);

  // ── 1. Fetch Molslinjen schedule ─────────────────────────────
  let schedule = [];
  try {
    const r = await fetch(
      'https://new.api.molslinjen.dk/api/v1/ai/markup/data-catalog?language=da&line=0',
      { headers: { 'User-Agent': 'GnibenFaergeApp/4.0', Accept: 'application/json' }, signal: AbortSignal.timeout(8000) }
    );
    if (r.ok) {
      const data = await r.json();
      const items = data['@graph'] || data.departures || [];
      for (const item of items) {
        const dest = (item.arrivalStation || item.toHarbour || item.name || '').toLowerCase();
        if (!dest.includes('odden')) continue;
        const origin = (item.name || '').toLowerCase().includes('ebeltoft') ? 'ebeltoft' : 'aarhus';
        const sailMins = SAIL_TIMES[origin];
        let arrivalOdden = item.arrivalTime ? new Date(item.arrivalTime) : null;
        if (!arrivalOdden && item.departureTime) {
          arrivalOdden = new Date(new Date(item.departureTime).getTime() + sailMins * 60000);
        }
        if (!arrivalOdden || isNaN(arrivalOdden) || arrivalOdden.toISOString().slice(0,10) !== today) continue;
        const shipName = item.shipName || item.vesselName || extractShipName(item.name || '');
        const hour = arrivalOdden.getHours();
        const isWE = [0,6].includes(arrivalOdden.getDay());
        const maxCars = Object.values(FLEET).find(f => f.name === shipName)?.maxCars || 411;
        const estimatedCars = estimateCars(hour, isWE, maxCars);
        schedule.push({
          origin, shipName,
          arrivalOdden: arrivalOdden.toISOString(),
          scheduledArrival: arrivalOdden.toISOString(),
          source: 'schedule',
          estimatedCars,
          estimatedUnloadMins: 15 + Math.max(0, Math.round((estimatedCars - 150) / 50)),
          loadLevel: estimatedCars < 200 ? 'low' : estimatedCars < 300 ? 'moderate' : 'heavy',
        });
      }
      schedule.sort((a, b) => new Date(a.arrivalOdden) - new Date(b.arrivalOdden));
    }
  } catch (_) {}

  // ── 2. Fetch AIS via BarentsWatch (Norwegian Coast Guard — free REST) ──
  // Covers all of Scandinavia including Kattegat/Danish waters
  // Endpoint: https://www.barentswatch.no/bwapi/v2/latest/combined?mmsi=MMSI
  const vesselPositions = {};

  const aisPromises = Object.entries(FLEET).map(async ([mmsi, info]) => {
    try {
      const r = await fetch(
        `https://www.barentswatch.no/bwapi/v2/latest/combined?mmsi=${mmsi}`,
        {
          headers: {
            'User-Agent': 'GnibenFaergeApp/4.0',
            'Accept': 'application/json',
          },
          signal: AbortSignal.timeout(6000),
        }
      );
      if (!r.ok) return null;
      const data = await r.json();

      // BarentsWatch format: { mmsi, name, latitude, longitude, speedOverGround, courseOverGround, ... }
      const lat = data.latitude ?? data.lat;
      const lon = data.longitude ?? data.lon;
      const sog = data.speedOverGround ?? data.sog ?? 0;
      const cog = data.courseOverGround ?? data.cog ?? 0;
      const ts  = data.msgtime ?? data.timestamp ?? new Date().toISOString();

      if (lat == null || lon == null) return null;

      const distNm = haversineNm(lat, lon, ODDEN.lat, ODDEN.lon);
      let etaOdden = null;
      if (sog > 2 && distNm > 0.2) {
        etaOdden = new Date(Date.now() + (distNm / sog) * 60 * 60000).toISOString();
      }

      return {
        mmsi: Number(mmsi), name: info.name,
        lat, lon,
        sog: Math.round(sog * 10) / 10,
        cog, distNm: Math.round(distNm * 10) / 10,
        etaOdden, timestamp: ts,
        isMoving: sog > 2,
        isAtOdden: distNm < 0.5,
      };
    } catch (_) { return null; }
  });

  const aisResults = await Promise.all(aisPromises);
  for (const v of aisResults) {
    if (v) vesselPositions[v.mmsi] = v;
  }

  // ── 3. Enrich schedule with AIS ──────────────────────────────
  for (const dep of schedule) {
    if (!dep.shipName) continue;
    const match = Object.values(vesselPositions).find(v =>
      v.name.toLowerCase() === dep.shipName.toLowerCase()
    );
    if (!match || match.isAtOdden) continue;
    dep.aisPosition = { lat: match.lat, lon: match.lon, sog: match.sog, distNm: match.distNm };
    if (match.etaOdden) {
      const diff = Math.abs((new Date(match.etaOdden) - new Date(dep.scheduledArrival)) / 60000);
      if (diff > 2) {
        dep.arrivalOdden = match.etaOdden;
        dep.source = 'ais';
        dep.delayMins = Math.round((new Date(match.etaOdden) - new Date(dep.scheduledArrival)) / 60000);
      }
    }
  }

  const hasAIS = Object.keys(vesselPositions).length > 0;

  // ── 3. Fetch Molslinjen driftsstatus ─────────────────────────
  let driftsstatus = { isNormal: true, text: 'Normal drift', raw: '' };
  try {
    const r = await fetch('https://www.molslinjen.dk/driftsstatus', {
      headers: { 'User-Agent': 'GnibenFaergeApp/4.0', Accept: 'text/html' },
      signal: AbortSignal.timeout(6000),
    });
    if (r.ok) {
      const html = await r.text();
      // Extract status text between <h2> tags in main content
      const match = html.match(/##\s*Trafikinformation\s*\n+\*\*([^*]+)\*\*/);
      const rawMatch = html.match(/Normal drift|Aflyste afgange|Forsinkelse|Vejrforhold|omlagt/gi);
      const statusText = match ? match[1].trim() : (rawMatch ? rawMatch[0] : 'Normal drift');
      const isNormal = /normal drift/i.test(statusText);
      // Extract any additional info (cancellations etc)
      const infoMatch = html.match(/\*\*Normal drift\*\*\s*\n+([\s\S]{0,300}?)(?:\n\n|\!\[)/);
      const extraInfo = infoMatch ? infoMatch[1].trim().replace(/\n+/g, ' ') : '';
      driftsstatus = {
        isNormal,
        text: statusText,
        extra: extraInfo || null,
        raw: statusText,
      };
    }
  } catch (_) {}

  return new Response(JSON.stringify({
    ok: true,
    date: today,
    fetchedAt: new Date().toISOString(),
    source: hasAIS ? 'ais+schedule' : 'schedule',
    hasAIS,
    driftsstatus,
    departures: schedule,
    vessels: Object.values(vesselPositions),
  }), { status: 200, headers: CORS });
};

function haversineNm(lat1, lon1, lat2, lon2) {
  const R = 3440.065;
  const dLat = (lat2-lat1)*Math.PI/180;
  const dLon = (lon2-lon1)*Math.PI/180;
  const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLon/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

function extractShipName(str) {
  const m = str.match(/express\s*\d/i);
  return m ? m[0].replace(/\s+/,' ').replace(/^\w/, c => c.toUpperCase()) : null;
}

function estimateCars(hour, isWE, maxCars) {
  const peaks = { 7:.85, 8:.95, 9:.90, 12:.88, 13:.85, 16:.92, 17:.95, 18:.88 };
  const base = isWE ? 0.72 : 0.58;
  return Math.round(maxCars * (peaks[hour] || base) * (0.85 + Math.random()*0.15));
}

export const config = { path: '/api/ferry-data' };
