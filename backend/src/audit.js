import { query } from './db.js';

export async function audit(req, action, entityType = null, entityId = null, actorUserId = null) {
  const actor = actorUserId || req.user?.id || null;
  const ip =
    (req.headers['x-forwarded-for'] ? String(req.headers['x-forwarded-for']).split(',')[0] : null) ||
    req.socket?.remoteAddress ||
    null;
  const ua = req.headers['user-agent'] || null;

  try {
    await query(
      `INSERT INTO audit_logs(actor_user_id, action, entity_type, entity_id, ip, user_agent)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [actor, action, entityType, entityId, ip, ua]
    );
  } catch (e) {
    // don't break request path on audit failure
    console.warn('audit_log_failed', e?.code || '', e?.message || e);
  }
}

