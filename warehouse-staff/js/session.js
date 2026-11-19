const KEY = 'rabel_session_warehouse';
export function getSession() { try { return JSON.parse(localStorage.getItem(KEY) || 'null'); } catch { return null; } }
export function setSession(s) { try { if (s) localStorage.setItem(KEY, JSON.stringify(s)); else localStorage.removeItem(KEY); } catch { /* storage blocked */ } }
export const isAuthed = () => !!getSession();
