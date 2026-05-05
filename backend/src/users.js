import { query } from './db.js';

export async function listUsers(_req, res) {
  const r = await query(
    `SELECT u.id, u.email, u.role, u.status, u.created_at,
            COALESCE(COUNT(da.device_id), 0) AS tracker_count
     FROM users u
     LEFT JOIN device_assignments da ON da.user_id = u.id
     GROUP BY u.id
     ORDER BY u.created_at DESC`
  );
  return res.json({
    users: r.rows.map((u) => ({
      id: u.id,
      email: u.email,
      role: u.role,
      status: u.status,
      createdAt: u.created_at,
      trackerCount: Number(u.tracker_count) || 0,
    })),
  });
}

