import { Request } from 'express';
import { DEFAULT_USER_ID } from '../db/seed.js';

/**
 * Extracts active user ID from request headers ('x-user-id') or query ('user_id'),
 * falling back to DEFAULT_USER_ID for seamless backward compatibility.
 */
export function getUserId(req: Request): string {
  const headerId = req.headers['x-user-id'];
  if (headerId && typeof headerId === 'string' && headerId.trim()) {
    return headerId.trim();
  }

  const queryId = req.query.user_id;
  if (queryId && typeof queryId === 'string' && queryId.trim()) {
    return queryId.trim();
  }

  return DEFAULT_USER_ID;
}
