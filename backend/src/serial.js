import { z } from 'zod';

export const serialSchema = z
  .string()
  .transform((s) => s.trim().toUpperCase())
  .refine((s) => s.length >= 3 && s.length <= 64, { message: 'length' })
  .refine((s) => /^[A-Z0-9-]+$/.test(s), { message: 'invalid_chars' });

export function normalizeSerial(input) {
  const r = serialSchema.safeParse(input);
  if (!r.success) return null;
  return r.data;
}

