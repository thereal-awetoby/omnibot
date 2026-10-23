// Calls made by a followed X account have a negative caller id (see xCallerId) and a name like "@handle".
// Telegram turns a plain "@handle" into a link to a Telegram user of that name, which is wrong for an X account,
// so those names are shown as a link to the X profile instead. Telegram people stay plain text.
const escHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
export const isXCaller = (callerId) => { try { return BigInt(callerId) < 0n; } catch { return false; } };

const POST = /^https:\/\/x\.com\/[A-Za-z0-9_]{1,15}\/status\/\d{5,25}$/;

// HTML for a caller name (already safe to put in a message). Returns '' when there is no name.
// For an X caller the link goes to the post the call came from (href) when we know it, else to their profile.
export function callerHtml(name, callerId, { at = true, max = 40, href = null } = {}) {
  const raw = String(name ?? '').replace(/^@/, '').slice(0, max);
  if (!raw) return '';
  const shown = `${at ? '@' : ''}${raw}`;
  if (isXCaller(callerId) && /^[A-Za-z0-9_]{1,15}$/.test(raw)) {
    const link = POST.test(String(href ?? '')) ? href : `https://x.com/${raw}`;
    return `<a href="${link}">${shown}</a>`;
  }
  return escHtml(shown);
}
