import { query } from './db.js';
import { computeLatestForDevice } from './telemetry.js';

async function canAccessCompany(user, companyId) {
  if (user.role === 'admin') return true;
  const r = await query(
    `SELECT 1 FROM company_users WHERE company_id=$1 AND user_id=$2 LIMIT 1`,
    [companyId, user.id]
  );
  return r.rows.length > 0;
}

export async function listCompanies(req, res) {
  const admin = req.user.role === 'admin';
  if (admin) {
    const r = await query(
      `SELECT id, name, slug::text AS slug, created_at FROM companies ORDER BY name`
    );
    return res.json({ companies: r.rows });
  }
  const r = await query(
    `SELECT c.id, c.name, c.slug::text AS slug, c.created_at
     FROM companies c
     INNER JOIN company_users cu ON cu.company_id = c.id AND cu.user_id = $1
     ORDER BY c.name`,
    [req.user.id]
  );
  return res.json({ companies: r.rows });
}

export async function getCompanySummary(req, res) {
  const companyId = req.params.id;
  if (!(await canAccessCompany(req.user, companyId))) {
    return res.status(403).json({ error: 'forbidden' });
  }

  const nameRow = await query(`SELECT id, name, slug::text AS slug FROM companies WHERE id=$1`, [companyId]);
  if (!nameRow.rows[0]) return res.status(404).json({ error: 'not_found' });

  const dr = await query(
    `SELECT d.id FROM devices d
     INNER JOIN company_devices cd ON cd.device_id = d.id AND cd.company_id = $1`,
    [companyId]
  );

  let total = 0;
  let online = 0;
  let offline = 0;
  let lowBattery = 0;

  for (const row of dr.rows) {
    total += 1;
    const latest = await computeLatestForDevice(row.id);
    if (latest.status === 'active') online += 1;
    else if (latest.status === 'offline') offline += 1;
    else if (latest.status === 'low') lowBattery += 1;
  }

  return res.json({
    company: {
      name: nameRow.rows[0].name,
      slug: nameRow.rows[0].slug,
    },
    total_trackers: total,
    online_trackers: online,
    offline_trackers: offline,
    low_battery_trackers: lowBattery,
  });
}

export async function getCompanyDevices(req, res) {
  const companyId = req.params.id;
  if (!(await canAccessCompany(req.user, companyId))) {
    return res.status(403).json({ error: 'forbidden' });
  }

  const isAdmin = req.user.role === 'admin';
  const r = isAdmin
    ? await query(
        `SELECT d.id, d.serial_number::text AS serial_number, d.name, d.created_at, u.email AS created_by_email
         FROM devices d
         JOIN users u ON u.id = d.created_by
         INNER JOIN company_devices cd ON cd.device_id = d.id AND cd.company_id = $1
         ORDER BY d.serial_number`,
        [companyId]
      )
    : await query(
        `SELECT d.id, d.serial_number::text AS serial_number, d.name, d.created_at, u.email AS created_by_email
         FROM devices d
         JOIN users u ON u.id = d.created_by
         INNER JOIN company_devices cd ON cd.device_id = d.id AND cd.company_id = $1
         INNER JOIN device_assignments da ON da.device_id = d.id AND da.user_id = $2
         ORDER BY d.serial_number`,
        [companyId, req.user.id]
      );

  return res.json({ devices: r.rows });
}
