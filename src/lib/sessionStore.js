'use strict';

const SESSION_TTL_MS = 15 * 60 * 1000;

const sessions = new Map();

function createSession(data) {
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  sessions.set(id, { ...data, id, expiresAt: Date.now() + SESSION_TTL_MS });
  return id;
}

function getSession(id) {
  const session = sessions.get(id);
  if (!session) return null;
  if (session.expiresAt < Date.now()) {
    sessions.delete(id);
    return null;
  }
  return session;
}

function deleteSession(id) {
  sessions.delete(id);
}

setInterval(() => {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (session.expiresAt < now) sessions.delete(id);
  }
}, 60 * 1000).unref();

module.exports = { createSession, getSession, deleteSession };
