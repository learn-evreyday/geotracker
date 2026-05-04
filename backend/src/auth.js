import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { query } from './db.js';
import { audit } from './audit.js';

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change';
const ACCESS_EXPIRES = process.env.JWT_ACCESS_EXPIRES || '15m';
const REFRESH_DAYS = Number(process.env.REFRESH_TOKEN_DAYS) || 7;

const registerSchema = z.object({
  email: z.string().email().max(320),
  password: z.string().min(8).max(200),
});

const loginSchema = registerSchema;

const refreshSchema = z.object({
  refresh_token: z.string().min(32).max(512),
});

function hashToken(raw) {
  return crypto.createHash('sha256').update(raw, 'utf8').digest('hex');
}

function signAccessToken(user) {
  return jwt.sign(
    { sub: user.id, role: user.role, email: user.email, typ: 'access' },
    JWT_SECRET,
    { expiresIn: ACCESS_EXPIRES }
  );
}

async function storeRefreshToken(userId, rawToken) {
  const tokenHash = hashToken(rawToken);
  const expiresAt = new Date(Date.now() + REFRESH_DAYS * 86400000);
  await query(`INSERT INTO refresh_tokens(user_id, token_hash, expires_at) VALUES ($1, $2, $3)`, [
    userId,
    tokenHash,
    expiresAt,
  ]);
  return expiresAt;
}

async function issueTokenBundle(user) {
  const accessToken = signAccessToken(user);
  const refreshToken = crypto.randomBytes(48).toString('hex');
  await storeRefreshToken(user.id, refreshToken);
  const decoded = jwt.decode(accessToken);
  const expiresIn =
    decoded?.exp && decoded?.iat ? decoded.exp - decoded.iat : 900;
  return {
    accessToken,
    refreshToken,
    expiresIn,
    token: accessToken,
    user: safeUser(user),
  };
}

export async function register(req, res) {
  const parsed = registerSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_input', details: parsed.error.flatten() });

  const email = parsed.data.email.toLowerCase();
  const passwordHash = await bcrypt.hash(parsed.data.password, 12);

  try {
    const r = await query(
      `INSERT INTO users(email, password_hash, role, status)
       VALUES ($1, $2, 'user', 'active')
       RETURNING id, email, role, status, created_at`,
      [email, passwordHash]
    );
    const user = r.rows[0];
    await audit(req, 'register', 'user', user.id, user.id);
    const bundle = await issueTokenBundle(user);
    res.setHeader('X-Access-Expires-In', String(bundle.expiresIn));
    return res.json(bundle);
  } catch (e) {
    if (String(e?.message || '').includes('duplicate') || e?.code === '23505') {
      return res.status(409).json({ error: 'email_taken' });
    }
    console.error(e);
    return res.status(500).json({ error: 'server' });
  }
}

export async function login(req, res) {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_input', details: parsed.error.flatten() });

  const email = parsed.data.email.toLowerCase();
  const { rows } = await query(
    `SELECT id, email, password_hash, role, status, created_at
     FROM users
     WHERE email=$1
     LIMIT 1`,
    [email]
  );
  const u = rows[0];
  if (!u) return res.status(401).json({ error: 'invalid_credentials' });
  if (u.status !== 'active') return res.status(403).json({ error: 'account_disabled' });

  const ok = await bcrypt.compare(parsed.data.password, u.password_hash);
  if (!ok) return res.status(401).json({ error: 'invalid_credentials' });

  await audit(req, 'login', 'user', u.id, u.id);
  const bundle = await issueTokenBundle(u);
  res.setHeader('X-Access-Expires-In', String(bundle.expiresIn));
  return res.json(bundle);
}

export async function refresh(req, res) {
  const parsed = refreshSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_input' });

  const tokenHash = hashToken(parsed.data.refresh_token);
  const { rows } = await query(
    `DELETE FROM refresh_tokens
     WHERE token_hash=$1 AND expires_at > now()
     RETURNING user_id`,
    [tokenHash]
  );
  const userId = rows[0]?.user_id;
  if (!userId) return res.status(401).json({ error: 'invalid_refresh' });

  const ur = await query(
    `SELECT id, email, role, status, created_at FROM users WHERE id=$1 AND status='active'`,
    [userId]
  );
  const u = ur.rows[0];
  if (!u) return res.status(401).json({ error: 'invalid_refresh' });

  await audit(req, 'token_refresh', 'user', u.id, u.id);
  const bundle = await issueTokenBundle(u);
  res.setHeader('X-Access-Expires-In', String(bundle.expiresIn));
  return res.json({
    accessToken: bundle.accessToken,
    refreshToken: bundle.refreshToken,
    expiresIn: bundle.expiresIn,
    token: bundle.token,
    user: bundle.user,
  });
}

export function safeUser(u) {
  return {
    id: u.id,
    email: u.email,
    role: u.role,
    status: u.status,
    createdAt: u.created_at,
  };
}

const changePasswordSchema = z.object({
  old_password: z.string().min(1),
  new_password: z.string().min(8).max(200),
});

export async function changePassword(req, res) {
  const parsed = changePasswordSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_input' });

  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ error: 'unauthorized' });

  const { rows } = await query(`SELECT id, password_hash FROM users WHERE id=$1 LIMIT 1`, [userId]);
  const u = rows[0];
  if (!u) return res.status(404).json({ error: 'not_found' });

  const ok = await bcrypt.compare(parsed.data.old_password, u.password_hash);
  if (!ok) return res.status(401).json({ error: 'invalid_credentials' });

  const passwordHash = await bcrypt.hash(parsed.data.new_password, 12);
  await query(`UPDATE users SET password_hash=$1 WHERE id=$2`, [passwordHash, userId]);
  await query(`DELETE FROM refresh_tokens WHERE user_id=$1`, [userId]);
  await audit(req, 'password_changed', 'user', userId, userId);
  return res.json({ ok: true });
}
