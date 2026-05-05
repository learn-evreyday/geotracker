import { z } from 'zod';
import { query } from './db.js';
import { normalizeSerial } from './serial.js';
import { audit } from './audit.js';
import { computeLatestForDevice } from './telemetry.js';

/** Offline = last transmission older than 24h (see telemetry.computeLatestForDevice). */
export async function listOfflineDevices(req, res) {
  const isAdmin = req.user.role === 'admin';
  const r = isAdmin
    ? await query(
        `SELECT d.id, d.serial_number, d.name, u.email AS owner_email
         FROM devices d
         JOIN users u ON u.id = d.created_by
         ORDER BY u.email, d.serial_number`
      )
    : await query(
        `SELECT d.id, d.serial_number, d.name, u.email AS owner_email
         FROM devices d
         JOIN users u ON u.id = d.created_by
         INNER JOIN device_assignments da ON da.device_id = d.id AND da.user_id = $1
         ORDER BY d.serial_number`,
        [req.user.id]
      );

  const devices = [];
  for (const row of r.rows) {
    let latest;
    try {
      latest = await computeLatestForDevice(row.id);
    } catch {
      continue;
    }
    if (latest.status !== 'offline') continue;
    devices.push({
      device_id: row.id,
      serial_number: row.serial_number,
      name: row.name,
      owner_email: row.owner_email,
      last_seen: latest.time,
      last_known_latitude: latest.latitude,
      last_known_longitude: latest.longitude,
      battery_percent: latest.batteryPercent,
      offline_critical_battery: Boolean(latest.offlineCriticalBattery),
    });
  }

  return res.json({ devices });
}

const createDeviceSchema = z.object({
  name: z.string().min(2).max(120),
});

const registerBySerialSchema = z.object({
  serial_number: z.string().min(1).max(200),
  name: z.string().min(2).max(120).optional(),
});

export async function listDevices(req, res) {
  const isAdmin = req.user.role === 'admin';
  const companySel = `(
      SELECT c.name FROM company_devices cd
      INNER JOIN companies c ON c.id = cd.company_id
      WHERE cd.device_id = d.id
      ORDER BY c.name
      LIMIT 1
    ) AS company_name`;

  if (isAdmin) {
    const r = await query(
      `SELECT d.id, d.serial_number, d.name, d.created_at, d.created_by,
              u.email AS created_by_email,
              ${companySel}
       FROM devices d
       JOIN users u ON u.id = d.created_by
       ORDER BY d.created_at DESC`
    );
    return res.json({ devices: r.rows });
  }

  const r = await query(
    `SELECT d.id, d.serial_number, d.name, d.created_at, d.created_by,
            u.email AS created_by_email,
            ${companySel}
     FROM device_assignments da
     JOIN devices d ON d.id = da.device_id
     JOIN users u ON u.id = d.created_by
     WHERE da.user_id = $1
     ORDER BY d.created_at DESC`,
    [req.user.id]
  );
  return res.json({ devices: r.rows });
}

export async function createDevice(req, res) {
  const parsed = createDeviceSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_input' });

  return res
    .status(400)
    .json({ error: 'use_register_by_serial', message: 'Use POST /api/devices/register-by-serial' });
}

export async function getDevice(req, res) {
  const id = req.params.id;
  const isAdmin = req.user.role === 'admin';

  if (!isAdmin) {
    const owns = await query(
      `SELECT 1 FROM device_assignments WHERE device_id=$1 AND user_id=$2`,
      [id, req.user.id]
    );
    if (!owns.rows.length) return res.status(404).json({ error: 'not_found' });
  }

  const r = await query(
    `SELECT d.id, d.serial_number, d.name, d.created_at, d.created_by, u.email AS created_by_email
     FROM devices d
     JOIN users u ON u.id = d.created_by
     WHERE d.id=$1
     LIMIT 1`,
    [id]
  );
  if (!r.rows[0]) return res.status(404).json({ error: 'not_found' });
  return res.json({ device: r.rows[0] });
}

export async function registerBySerial(req, res) {
  const parsed = registerBySerialSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_input' });

  const serial = normalizeSerial(parsed.data.serial_number);
  if (!serial) return res.status(400).json({ error: 'invalid_serial' });
  const name = parsed.data.name?.trim() || 'Tracker';

  const existing = await query(
    `SELECT id, serial_number, name, created_by, created_at FROM devices WHERE serial_number=$1 LIMIT 1`,
    [serial]
  );

  let device = existing.rows[0];
  if (!device) {
    const created = await query(
      `INSERT INTO devices(serial_number, name, created_by)
       VALUES ($1, $2, $3)
       RETURNING id, serial_number, name, created_by, created_at`,
      [serial, name, req.user.id]
    );
    device = created.rows[0];
    await audit(req, 'tracker_created', 'device', device.id);
  }

  const assigned = await query(
    `INSERT INTO device_assignments(device_id, user_id)
     VALUES ($1, $2)
     ON CONFLICT DO NOTHING`,
    [device.id, req.user.id]
  );

  const already = assigned.rowCount === 0;
  await audit(req, 'tracker_associated', 'device', device.id);
  return res.status(200).json({
    device,
    associated: !already,
    message: already ? 'tracker_already_associated' : 'tracker_associated',
  });
}

export async function getDeviceBySerial(req, res) {
  const serial = normalizeSerial(String(req.params.serialNumber || ''));
  if (!serial) return res.status(400).json({ error: 'invalid_serial' });

  const r = await query(
    `SELECT d.id, d.serial_number, d.name, d.created_at, d.created_by, u.email AS created_by_email
     FROM devices d
     JOIN users u ON u.id = d.created_by
     WHERE d.serial_number=$1
     LIMIT 1`,
    [serial]
  );
  const device = r.rows[0];
  if (!device) return res.status(404).json({ error: 'not_found' });

  const isAdmin = req.user.role === 'admin';
  if (!isAdmin) {
    const owns = await query(
      `SELECT 1 FROM device_assignments WHERE device_id=$1 AND user_id=$2`,
      [device.id, req.user.id]
    );
    if (!owns.rows.length) {
      return res.status(403).json({ error: 'forbidden', canRegister: true });
    }
  }

  return res.json({ device });
}

export async function unassignFromMe(req, res) {
  const deviceId = req.params.id;
  const { rowCount } = await query(
    `DELETE FROM device_assignments WHERE device_id=$1 AND user_id=$2`,
    [deviceId, req.user.id]
  );
  if (!rowCount) return res.status(404).json({ error: 'not_found' });
  await audit(req, 'tracker_unassigned', 'device', deviceId);
  return res.json({ ok: true });
}

export async function adminDeleteDevice(req, res) {
  const deviceId = req.params.id;
  const { rowCount } = await query(`DELETE FROM devices WHERE id=$1`, [deviceId]);
  if (!rowCount) return res.status(404).json({ error: 'not_found' });
  await audit(req, 'tracker_deleted', 'device', deviceId);
  return res.json({ ok: true });
}

export async function listAdminDevices(req, res) {
  const r = await query(
    `SELECT d.id, d.serial_number, d.name, d.created_at, d.created_by, u.email AS created_by_email,
            COALESCE(
              json_agg(
                json_build_object(
                  'user_id', du.id,
                  'email', du.email,
                  'assigned_at', da.assigned_at
                )
                ORDER BY da.assigned_at ASC
              ) FILTER (WHERE du.id IS NOT NULL),
              '[]'::json
            ) AS assignees
     FROM devices d
     JOIN users u ON u.id = d.created_by
     LEFT JOIN device_assignments da ON da.device_id = d.id
     LEFT JOIN users du ON du.id = da.user_id
     GROUP BY d.id, u.email
     ORDER BY d.created_at DESC`
  );

  const rows = [];
  for (const row of r.rows) {
    let latest = null;
    try {
      latest = await computeLatestForDevice(row.id);
    } catch {
      latest = null;
    }
    rows.push({
      ...row,
      latest,
      lastSeen: latest?.time || null,
    });
  }

  return res.json({ devices: rows });
}

