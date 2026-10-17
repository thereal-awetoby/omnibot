// Wallet-name helpers (pure functions, no dependencies).

// 1-20 chars: letters, numbers, spaces, underscore, dot, dash.
const NAME_RE = /^[\p{L}\p{N} _.-]{1,20}$/u;

export const normalizeName = (raw) => String(raw).trim().replace(/\s+/g, ' ');
export const isValidName = (name) => NAME_RE.test(name);

// Next free default label: "Wallet N", skipping any name already taken (case-insensitive).
export function nextWalletLabel(existingLabels) {
  const taken = new Set(existingLabels.map((l) => String(l).toLowerCase()));
  let i = existingLabels.length + 1;
  while (taken.has(`wallet ${i}`)) i++;
  return `Wallet ${i}`;
}

// Escape text for Telegram parse_mode HTML.
export const esc = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
