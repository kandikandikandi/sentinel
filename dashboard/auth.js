'use strict';
/**
 * Sentinel Auth Middleware
 * Validates Bearer tokens on protected API routes
 */

const { findTokenByValue, updateTokenLastUsed } = require('./db');

function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;

  // Also accept token as a query param (for direct browser downloads like CSV export)
  let token;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.substring(7);
  } else if (req.query && req.query.token) {
    token = req.query.token;
  } else {
    return res.status(401).json({ error: 'Missing or invalid authorization header' });
  }
  const record = findTokenByValue(token);

  if (!record) {
    return res.status(401).json({ error: 'Invalid API token' });
  }

  // Fire-and-forget last-used update
  setImmediate(() => updateTokenLastUsed(record.id));

  req.user = {
    id: record.user_id,
    email: record.email,
    role: record.role,
    tokenId: record.id,
  };

  next();
}

function requireAdmin(req, res, next) {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}

module.exports = { authMiddleware, requireAdmin };
