import { z } from 'zod';
import { query } from './db.js';
import { queryFlux, bucket } from './influx.js';
import { writeDeviceTelemetryPoint } from './influx.js';
import { audit } from './audit.js';

const telemetrySchema = z.object({
  device_id: z.string().min(1),
  latitude: z.number(),
  longitude: z.number(),
  battery_percent: z.number(),
  timestamp: z.string().optional(),
});

function rangeStart(window) {
  const w = String(window || '5m');
  if (w === '1h' || w === '5m' || w === '15m' || w === '30m' || w === '24h' || w === '7d') return `-${w}`;
  return '-5m';
}

/** Shared Influx read for latest telemetry (no HTTP). */
export async function computeLatestForDevice(deviceId) {
  const flux = `
from(bucket: "${bucket}")
  |> range(start: -30d)
  |> filter(fn: (r) => r._measurement == "device_telemetry")
  |> filter(fn: (r) => r.device_id == "${deviceId}")
  |> filter(fn: (r) => r._field == "latitude" or r._field == "longitude" or r._field == "battery_percent")
  |> last()
`;
  const rows = await queryFlux(flux);
  const out = { deviceId, time: null, latitude: null, longitude: null, batteryPercent: null };
  for (const r of rows) {
    out.time = out.time || r._time;
    if (r._field === 'latitude') out.latitude = Number(r._value);
    if (r._field === 'longitude') out.longitude = Number(r._value);
    if (r._field === 'battery_percent') out.batteryPercent = Number(r._value);
  }
  const lastTime = out.time ? new Date(out.time).getTime() : 0;
  const ageMs = lastTime ? Date.now() - lastTime : Infinity;
  const active = lastTime > 0 && ageMs <= 24 * 60 * 60 * 1000;
  const low =
    active &&
    typeof out.batteryPercent === 'number' &&
    out.batteryPercent < 20;
  // Stale trackers are offline even if battery was low at last transmission.
  out.status = !active ? 'offline' : low ? 'low' : 'active';
  out.offlineCriticalBattery =
    !active &&
    typeof out.batteryPercent === 'number' &&
    out.batteryPercent >= 0 &&
    out.batteryPercent < 10;
  return out;
}

export async function postTelemetry(req, res) {
  const parsed = telemetrySchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_input' });

  // (Auth) For now: only allow writing for devices the user can access (or admin).
  // We check ownership in Postgres.
  const deviceId = parsed.data.device_id;
  const isAdmin = req.user?.role === 'admin';
  if (!isAdmin) {
    const owns = await query(
      `SELECT 1 FROM device_assignments WHERE device_id=$1 AND user_id=$2`,
      [deviceId, req.user.id]
    );
    if (!owns.rows.length) return res.status(404).json({ error: 'not_found' });
  }

  writeDeviceTelemetryPoint(
    deviceId,
    parsed.data.latitude,
    parsed.data.longitude,
    parsed.data.battery_percent,
    'api'
  );
  return res.status(202).json({ ok: true });
}

export async function getLatest(req, res) {
  const deviceId = req.params.id;
  const isAdmin = req.user.role === 'admin';
  if (!isAdmin) {
    const owns = await query(
      `SELECT 1 FROM device_assignments WHERE device_id=$1 AND user_id=$2`,
      [deviceId, req.user.id]
    );
    if (!owns.rows.length) return res.status(404).json({ error: 'not_found' });
  }

  const out = await computeLatestForDevice(deviceId);
  return res.json({ latest: out });
}

export async function getHistory(req, res) {
  const deviceId = req.params.id;
  const range = req.query.range || '5m';
  const r = rangeStart(range);

  const isAdmin = req.user.role === 'admin';
  if (!isAdmin) {
    const owns = await query(
      `SELECT 1 FROM device_assignments WHERE device_id=$1 AND user_id=$2`,
      [deviceId, req.user.id]
    );
    if (!owns.rows.length) return res.status(404).json({ error: 'not_found' });
  }

  await audit(req, 'history_viewed', 'device', deviceId);

  const flux = `
from(bucket: "${bucket}")
  |> range(start: ${r})
  |> filter(fn: (r) => r._measurement == "device_telemetry")
  |> filter(fn: (r) => r.device_id == "${deviceId}")
  |> filter(fn: (r) => r._field == "latitude" or r._field == "longitude" or r._field == "battery_percent")
  |> aggregateWindow(every: 5s, fn: last, createEmpty: false)
  |> pivot(rowKey: ["_time"], columnKey: ["_field"], valueColumn: "_value")
  |> keep(columns: ["_time","latitude","longitude","battery_percent"])
  |> sort(columns: ["_time"])
`;
  const rows = await queryFlux(flux);
  const points = rows
    .filter((x) => x._time)
    .map((x) => ({
      t: x._time,
      latitude: Number(x.latitude),
      longitude: Number(x.longitude),
      batteryPercent: Number(x.battery_percent),
    }));

  return res.json({ deviceId, range, points });
}

