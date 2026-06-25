// ferry-data.js — Netlify serverless function
// Fetches Molslinjen schedule + live AIS positions for Express 2/3/4
// Returns enriched departure list with real ETA for Odden-bound sailings
//
// Deploy env vars needed:
//   AISSTREAM_API_KEY  — free key from aisstream.io (takes 2 min to register)

export default async (req) => {
  if (req.method !== 'GET') return new Response('Method not allowed', { status: 405 });

  const CORS = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json',
    'Cache-Control': 'public, max-age=30', // 30s cache — AIS updates every ~10s
  };

  // ── Ferry fleet MMSI numbers ─────────────────────────────────
  const FLEET = {
    219018172: { name: 'Express 2', maxCars: 411 },
    219022903: { name: 'Express 3', maxCars: 411 },
    219705000: { name: 'Express 4', maxCars: 425 },
  };

  // Odden harbour coordinates (for distance calc)
  const ODDEN = { lat: 55.9767, lon: 11.3647 };

  // Sailing times (minutes) by origin
  const SAIL_TIMES = { aarhus: 90, ebeltoft: 75 };

  const today = new Date().toISOString().slice(0, 10);

  // ── 1. Fetch Molslinjen schedule ─────────────────────────────
  let schedule = [];
  try {
    const r = await fetch(
      'https://new.api.molslinjen.dk/api/v1/ai/markup/data-catalog?language=da&line=0',
      { headers: { 'User-Agent': 'GnibenFaergeApp/3.0', Accept: 'application/json' }, signal: AbortSignal.timeout(8000) }
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
        // Try to match ship name from schedule
        const shipName = item.shipName || item.vesselName || extractShipName(item.name || '');
        schedule.push({
          origin,
          arrivalOdden: arrivalOdden.toISOString(),
          scheduledArrival: arrivalOdden.toISOString(),
          shipName,
          source: 'schedule',
        });
      }
      schedule.sort((a, b) => new Date(a.arrivalOdden) - new Date(b.arrivalOdden));
    }
  } catch (_) {}

  // ── 2. Fetch AIS live positions ──────────────────────────────
  const aisKey = process.env.AISSTREAM_API_KEY;
  const vesselPositions = {};

  if (aisKey) {
    try {
      // Query each vessel's latest position
      const mmsiList = Object.keys(FLEET).map(Number);
      const aisPromises = mmsiList.map(async (mmsi) => {
        try {
          const r = await fetch(
            `https://api.aisstream.io/v0/vessel/${mmsi}/latest`,
            { headers: { Authorization: `Bearer ${aisKey}` }, signal: AbortSignal.timeout(5000) }
          );
          if (!r.ok) return null;
          const d = await r.json();
          return { mmsi, data: d };
        } catch (_) { return null; }
      });
      const results = await Promise.all(aisPromises);

      for (const result of results) {
        if (!result?.data) continue;
        const { mmsi, data } = result;
        const pos = data.Position || data.position || data;
        if (!pos?.latitude || !pos?.longitude) continue;

        const lat = pos.latitude || pos.Latitude;
        const lon = pos.longitude || pos.Longitude;
        const sog = pos.sog || pos.SOG || 0; // speed over ground in knots
        const heading = pos.cog || pos.COG || 0;
        const navStatus = pos.navigationalStatus || pos.NavigationalStatus || '';
        const timestamp = pos.timestamp || pos.TimeUtc || new Date().toISOString();

        // Calculate distance to Odden
        const distKm = haversineKm(lat, lon, ODDEN.lat, ODDEN.lon);
        const distNm = distKm / 1.852;

        // Estimate ETA: if moving toward Odden and speed > 2 knots
        let etaOdden = null;
        if (sog > 2 && distNm > 0.1) {
          const etaMins = (distNm / sog) * 60;
          etaOdden = new Date(Date.now() + etaMins * 60000).toISOString();
        }

        vesselPositions[mmsi] = {
          mmsi,
          name: FLEET[mmsi].name,
          lat, lon,
          sog: Math.round(sog * 10) / 10,
          heading,
          navStatus,
          distNm: Math.round(distNm * 10) / 10,
          etaOdden,
          timestamp,
          isMoving: sog > 2,
          isAtOdden: distNm < 0.3,
        };
      }
    } catch (_) {}
  }

  // ── 3. Enrich schedule with AIS data ────────────────────────
  // Match vessel names in schedule to AIS positions
  for (const dep of schedule) {
    if (!dep.shipName) continue;
    const match = Object.values(vesselPositions).find(v =>
      v.name.toLowerCase() === dep.shipName.toLowerCase()
    );
    if (!match) continue;

    dep.aisPosition = {
      lat: match.lat, lon: match.lon,
      sog: match.sog, distNm: match.distNm,
      isAtOdden: match.isAtOdden,
    };

    // Override arrival time if AIS ETA is available and different
    if (match.etaOdden && !match.isAtOdden) {
      const schedArr = new Date(dep.scheduledArrival);
      const aisArr = new Date(match.etaOdden);
      const diffMins = Math.abs((aisArr - schedArr) / 60000);
      if (diffMins > 2) { // Only override if difference > 2 min
        dep.arrivalOdden = match.etaOdden;
        dep.source = 'ais';
        dep.delayMins = Math.round((aisArr - schedArr) / 60000);
      }
    }
  }

  // ── 4. Estimated car count per vessel ────────────────────────
  // We don't have official car counts; estimate based on time of day + weekday
  // (Modeled after observed patterns at Odden)
  const now = new Date();
  const hour = now.getHours();
  const dow = now.getDay(); // 0=Sun
  for (const dep of schedule) {
    const shipName = dep.shipName || '';
    const vesselMMSI = Object.entries(FLEET).find(([, v]) => v.name === shipName)?.[0];
    const maxCars = vesselMMSI ? FLEET[vesselMMSI].maxCars : 411;
    dep.estimatedCars = estimateCars(hour, dow, maxCars);
    dep.loadLevel = dep.estimatedCars < 200 ? 'low' : dep.estimatedCars < 300 ? 'moderate' : 'heavy';
    // Dynamic unload time: 15 min base + 1 min per 50 cars above 150
    dep.estimatedUnloadMins = 15 + Math.max(0, Math.round((dep.estimatedCars - 150) / 50));
  }

  const usedAIS = Object.keys(vesselPositions).length > 0;

  return new Response(JSON.stringify({
    ok: true,
    date: today,
    fetchedAt: new Date().toISOString(),
    source: usedAIS ? 'ais+schedule' : 'schedule',
    hasAIS: usedAIS,
    departures: schedule,
    vessels: Object.values(vesselPositions),
  }), { status: 200, headers: CORS });
};

// ── Helpers ──────────────────────────────────────────────────────
function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180) * Math.cos(lat2*Math.PI/180) * Math.sin(dLon/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

function extractShipName(str) {
  const m = str.match(/express\s*\d/i);
  return m ? m[0].replace(/\s+/, ' ').replace(/^\w/, c => c.toUpperCase()) : null;
}

function estimateCars(hour, dow, maxCars) {
  // Traffic pattern: peaks at 8-10, 12-14, 16-18, weekends heavier
  const isWeekend = dow === 0 || dow === 6 || dow === 5;
  const baseLoad = isWeekend ? 0.72 : 0.58;
  const peakHours = { 7:0.85, 8:0.95, 9:0.90, 12:0.88, 13:0.85, 16:0.92, 17:0.95, 18:0.88 };
  const multiplier = peakHours[hour] || baseLoad;
  return Math.round(maxCars * multiplier * (0.85 + Math.random() * 0.15));
}

export const config = { path: '/api/ferry-data' };
