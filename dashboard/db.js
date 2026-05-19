'use strict';
/**
 * Sentinel Database Layer
 * SQLite-based storage for multi-user self-hosted deployment
 */

const Database = require('better-sqlite3');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const os = require('os');

// DB path: configurable via env, defaults to ~/.sentinel/sentinel.db
const DB_PATH = process.env.DB_PATH || path.join(os.homedir(), '.sentinel', 'sentinel.db');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// === SCHEMA ===

db.exec(`
  CREATE TABLE IF NOT EXISTS admin_accounts (
    id TEXT PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT UNIQUE,
    name TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'developer',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS api_tokens (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash TEXT UNIQUE NOT NULL,
    token_prefix TEXT NOT NULL,
    name TEXT NOT NULL DEFAULT 'Default',
    last_used_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
    workspace TEXT,
    business_type TEXT,
    business_confidence INTEGER DEFAULT 0,
    status TEXT DEFAULT 'active',
    started_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    state_json TEXT DEFAULT '{}'
  );

  CREATE TABLE IF NOT EXISTS findings (
    id TEXT PRIMARY KEY,
    session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE,
    user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
    timestamp TEXT NOT NULL,
    probe_title TEXT,
    probe_question TEXT,
    response TEXT,
    score INTEGER,
    grade TEXT,
    severity TEXT,
    assessment TEXT,
    signals_json TEXT DEFAULT '[]',
    business_type TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_findings_session ON findings(session_id);
  CREATE INDEX IF NOT EXISTS idx_findings_score ON findings(score);
  CREATE INDEX IF NOT EXISTS idx_findings_timestamp ON findings(timestamp);
  CREATE INDEX IF NOT EXISTS idx_findings_user ON findings(user_id);
  CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
  CREATE INDEX IF NOT EXISTS idx_sessions_updated ON sessions(updated_at);
  CREATE INDEX IF NOT EXISTS idx_api_tokens_hash ON api_tokens(token_hash);
`);

// === TOKEN HELPERS ===

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function generateToken() {
  return 'sentinel_' + crypto.randomBytes(32).toString('hex');
}

// === ADMIN ACCOUNTS ===

const stmts = {
  adminCount: db.prepare('SELECT COUNT(*) as count FROM admin_accounts'),
  adminInsert: db.prepare('INSERT INTO admin_accounts (id, email, password_hash) VALUES (?, ?, ?)'),
  adminByEmail: db.prepare('SELECT * FROM admin_accounts WHERE email = ?'),
};

function isSetupDone() {
  return stmts.adminCount.get().count > 0;
}

async function createAdmin(email, password) {
  const id = uuidv4();
  const hash = await bcrypt.hash(password, 12);
  stmts.adminInsert.run(id, email, hash);
  return id;
}

async function verifyAdmin(email, password) {
  const admin = stmts.adminByEmail.get(email);
  if (!admin) return null;
  const ok = await bcrypt.compare(password, admin.password_hash);
  return ok ? admin : null;
}

// === USERS ===

const userStmts = {
  create: db.prepare('INSERT INTO users (id, email, name, role) VALUES (?, ?, ?, ?)'),
  byId: db.prepare('SELECT * FROM users WHERE id = ?'),
  byEmail: db.prepare('SELECT * FROM users WHERE email = ?'),
  list: db.prepare('SELECT id, email, name, role, created_at FROM users ORDER BY created_at DESC'),
};

function createUser(email, name, role = 'developer') {
  const id = uuidv4();
  userStmts.create.run(id, email || null, name, role);
  return id;
}

function getUserById(id) {
  return userStmts.byId.get(id);
}

function getUserByEmail(email) {
  return userStmts.byEmail.get(email);
}

function listUsers() {
  return userStmts.list.all();
}

// === API TOKENS ===

const tokenStmts = {
  create: db.prepare(
    'INSERT INTO api_tokens (id, user_id, token_hash, token_prefix, name) VALUES (?, ?, ?, ?, ?)'
  ),
  byHash: db.prepare(
    'SELECT t.*, u.role, u.email FROM api_tokens t JOIN users u ON t.user_id = u.id WHERE t.token_hash = ?'
  ),
  forUser: db.prepare(
    'SELECT id, name, token_prefix, last_used_at, created_at FROM api_tokens WHERE user_id = ? ORDER BY created_at DESC'
  ),
  all: db.prepare(
    `SELECT t.id, t.name, t.token_prefix, t.last_used_at, t.created_at,
            u.email AS user_email, u.name AS user_name
     FROM api_tokens t JOIN users u ON t.user_id = u.id
     ORDER BY t.created_at DESC`
  ),
  updateLastUsed: db.prepare("UPDATE api_tokens SET last_used_at = datetime('now') WHERE id = ?"),
  delete: db.prepare('DELETE FROM api_tokens WHERE id = ? AND user_id = ?'),
  deleteAdmin: db.prepare('DELETE FROM api_tokens WHERE id = ?'),
};

function createToken(userId, name = 'Default') {
  const id = uuidv4();
  const token = generateToken();
  const hash = hashToken(token);
  const prefix = token.substring(0, 16);
  tokenStmts.create.run(id, userId, hash, prefix, name);
  return { id, token }; // plain token returned only once
}

function findTokenByValue(token) {
  return tokenStmts.byHash.get(hashToken(token));
}

function updateTokenLastUsed(id) {
  tokenStmts.updateLastUsed.run(id);
}

function listTokensForUser(userId) {
  return tokenStmts.forUser.all(userId);
}

function listAllTokens() {
  return tokenStmts.all.all();
}

function revokeToken(id, userId) {
  return tokenStmts.delete.run(id, userId);
}

function revokeTokenAdmin(id) {
  return tokenStmts.deleteAdmin.run(id);
}

// === SESSIONS ===

const sessionStmts = {
  upsert: db.prepare(`
    INSERT INTO sessions (id, user_id, workspace, business_type, business_confidence, started_at, state_json)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      business_type = CASE WHEN excluded.business_type IS NOT NULL THEN excluded.business_type ELSE sessions.business_type END,
      business_confidence = CASE WHEN excluded.business_confidence > 0 THEN excluded.business_confidence ELSE sessions.business_confidence END,
      updated_at = datetime('now'),
      state_json = excluded.state_json
  `),
  byId: db.prepare(`
    SELECT s.*,
           s.id AS session_id,
           s.updated_at AS lastUpdate,
           (SELECT COUNT(*) FROM findings f WHERE f.session_id = s.id) AS probes_completed
    FROM sessions s WHERE s.id = ?
  `),
  all: db.prepare(`
    SELECT s.*,
           s.id AS session_id,
           s.updated_at AS lastUpdate,
           u.email AS user_email, u.name AS user_name,
           (SELECT COUNT(*) FROM findings f WHERE f.session_id = s.id) AS probes_completed
    FROM sessions s LEFT JOIN users u ON s.user_id = u.id
    ORDER BY s.updated_at DESC LIMIT 200
  `),
  forUser: db.prepare(`
    SELECT s.*,
           s.id AS session_id,
           s.updated_at AS lastUpdate,
           u.email AS user_email, u.name AS user_name,
           (SELECT COUNT(*) FROM findings f WHERE f.session_id = s.id) AS probes_completed
    FROM sessions s LEFT JOIN users u ON s.user_id = u.id
    WHERE s.user_id = ? ORDER BY s.updated_at DESC LIMIT 100
  `),
  updateState: db.prepare("UPDATE sessions SET state_json = ?, updated_at = datetime('now') WHERE id = ?"),
};

function upsertSession(id, userId, workspace, businessType, businessConfidence, startedAt, stateJson) {
  sessionStmts.upsert.run(
    id,
    userId || null,
    workspace || null,
    businessType || null,
    businessConfidence || 0,
    startedAt || new Date().toISOString(),
    JSON.stringify(stateJson || {})
  );
}

function getSession(id) {
  return sessionStmts.byId.get(id);
}

function listSessions(userId, isAdmin) {
  if (isAdmin) return sessionStmts.all.all();
  return sessionStmts.forUser.all(userId);
}

function updateSessionState(id, stateJson) {
  sessionStmts.updateState.run(JSON.stringify(stateJson), id);
}

// === FINDINGS ===

const findingStmts = {
  create: db.prepare(`
    INSERT INTO findings
      (id, session_id, user_id, timestamp, probe_title, probe_question, response, score, grade, severity, assessment, signals_json, business_type)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `),
  all: db.prepare('SELECT * FROM findings ORDER BY timestamp DESC LIMIT 500'),
  forUser: db.prepare('SELECT * FROM findings WHERE user_id = ? ORDER BY timestamp DESC LIMIT 200'),
  forSession: db.prepare('SELECT * FROM findings WHERE session_id = ? ORDER BY timestamp ASC'),
  alerts: db.prepare('SELECT * FROM findings WHERE score < 50 ORDER BY timestamp DESC LIMIT 20'),
  alertsForUser: db.prepare(
    'SELECT * FROM findings WHERE user_id = ? AND score < 50 ORDER BY timestamp DESC LIMIT 20'
  ),
};

function createFinding(finding) {
  const id = uuidv4();
  findingStmts.create.run(
    id,
    finding.session_id,
    finding.user_id || null,
    finding.timestamp || new Date().toISOString(),
    finding.probe_title || (finding.probe && finding.probe.title) || '',
    finding.probe_question || (finding.probe && finding.probe.question) || '',
    finding.response || '',
    finding.score,
    finding.grade,
    finding.severity || (finding.probe && finding.probe.severity) || '',
    finding.assessment || '',
    JSON.stringify(finding.signals || []),
    finding.business_type || ''
  );
  return id;
}

function listFindings(userId, isAdmin) {
  if (isAdmin) return findingStmts.all.all();
  return findingStmts.forUser.all(userId);
}

function listFindingsForSession(sessionId) {
  return findingStmts.forSession.all(sessionId);
}

function getAlerts(userId, isAdmin) {
  if (isAdmin) return findingStmts.alerts.all();
  return findingStmts.alertsForUser.all(userId);
}

module.exports = {
  isSetupDone,
  createAdmin,
  verifyAdmin,
  createUser,
  getUserById,
  getUserByEmail,
  listUsers,
  createToken,
  findTokenByValue,
  updateTokenLastUsed,
  listTokensForUser,
  listAllTokens,
  revokeToken,
  revokeTokenAdmin,
  upsertSession,
  getSession,
  listSessions,
  updateSessionState,
  createFinding,
  listFindings,
  listFindingsForSession,
  getAlerts,
};
