// Calls made by a followed X account have a negative caller id (see xCallerId) and a name like "@handle".
// Telegram turns a plain "@handle" into a link to a Telegram user of that name, which is wrong for an X account,
// so those names are shown as a link to the X profile instead. Telegram people stay plain text.
const escHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
export const isXCaller = (callerId) => { try { return BigInt(callerId) < 0n; } catch { return false; } };

// HTML for a caller name (already safe to put in a message). Returns '' when there is no name.
export function callerHtml(name, callerId, { at = true, max = 40 } = {}) {
  const raw = String(name ?? '').replace(/^@/, '').slice(0, max);
  if (!raw) return '';
  if (isXCaller(callerId) && /^[A-Za-z0-9_]{1,15}$/.test(raw)) return `<a href="https://x.com/${raw}">${at ? '@' : ''}${raw}</a>`;
  return escHtml(`${at ? '@' : ''}${raw}`);
}
