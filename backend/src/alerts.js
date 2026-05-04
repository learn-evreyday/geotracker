import { query } from './db.js';
import { computeLatestForDevice } from './telemetry.js';

/** Ensure no duplicate unread alerts per device + type */
async function maybeInsertAlert(deviceId, type, serial, latest) {
  const dup = await query(
    `SELECT id FROM alerts WHERE device_id=$1 AND type=$2 AND is_read=false LIMIT 1`,
    [deviceId, type]
  );
  if (dup.rows.length) return;

  const severity = type === 'offline' ? 'high' : 'medium';
  let message;
  if (type === 'offline') {
    message = `Tracker ${serial} is offline (no transmission in the last 24 hours).`;
  } else {
    const bat =
      typeof latest?.batteryPercent === 'number' ? Math.round(latest.batteryPercent) : '?';
    message = `Tracker ${serial} has low battery (${bat}%).`;
  }

  await query(
    `INSERT INTO alerts(device_id, type, severity, message) VALUES ($1, $2, $3, $4)`,
    [deviceId, type, severity, message]
  );
}

export async function syncAlertsFromTelemetry() {
  const { rows } = await query(`SELECT id, serial_number::text AS serial_number FROM devices`);
  for (const d of rows) {
    let latest;
    try {
      latest = await computeLatestForDevice(d.id);
    } catch {
      continue;
    }
    const serial = d.serial_number || d.id;

    if (latest.status === 'offline') {
      await maybeInsertAlert(d.id, 'offline', serial, latest);
    }
    if (latest.status === 'low') {
      await maybeInsertAlert(d.id, 'low_battery', serial, latest);
    }
  }
}

export async function listAlerts(req, res) {
  const admin = req.user.role === 'admin';
  const sql = admin
    ? `SELECT a.id, a.device_id, a.type, a.severity, a.message, a.is_read, a.created_at,
              d.serial_number::text AS serial_number
       FROM alerts a
       JOIN devices d ON d.id = a.device_id
       ORDER BY a.created_at DESC
       LIMIT 200`
    : `SELECT a.id, a.device_id, a.type, a.severity, a.message, a.is_read, a.created_at,
              d.serial_number::text AS serial_number
       FROM alerts a
       JOIN devices d ON d.id = a.device_id
       INNER JOIN device_assignments da ON da.device_id = d.id AND da.user_id = $1
       ORDER BY a.created_at DESC
       LIMIT 200`;
  const params = admin ? [] : [req.user.id];
  const { rows } = await query(sql, params);
  return res.json({ alerts: rows });
}

export async function getUnreadAlertCount(req, res) {
  const admin = req.user.role === 'admin';
  const sql = admin
    ? `SELECT COUNT(*)::int AS n FROM alerts WHERE is_read = false`
    : `SELECT COUNT(*)::int AS n
       FROM alerts a
       JOIN devices d ON d.id = a.device_id
       INNER JOIN device_assignments da ON da.device_id = d.id AND da.user_id = $1
       WHERE a.is_read = false`;
  const params = admin ? [] : [req.user.id];
  const { rows } = await query(sql, params);
  return res.json({ count: rows[0]?.n ?? 0 });
}

export async function markAlertRead(req, res) {
  const id = req.params.id;
  const admin = req.user.role === 'admin';

  if (admin) {
    const { rows } = await query(`UPDATE alerts SET is_read = true WHERE id = $1 RETURNING id`, [id]);
    if (!rows.length) return res.status(404).json({ error: 'not_found' });
    return res.json({ ok: true });
  }

  const { rows } = await query(
    `UPDATE alerts a SET is_read = true
     FROM device_assignments da
     WHERE a.id = $1 AND da.device_id = a.device_id AND da.user_id = $2
     RETURNING a.id`,
    [id, req.user.id]
  );
  if (!rows.length) return res.status(404).json({ error: 'not_found' });
  return res.json({ ok: true });
}

export async function markAllAlertsRead(req, res) {
  const admin = req.user.role === 'admin';

  if (admin) {
    await query(`UPDATE alerts SET is_read = true WHERE is_read = false`);
    return res.json({ ok: true });
  }

  await query(
    `UPDATE alerts a SET is_read = true
     FROM device_assignments da
     WHERE a.device_id = da.device_id AND da.user_id = $1 AND a.is_read = false`,
    [req.user.id]
  );
  return res.json({ ok: true });
}
