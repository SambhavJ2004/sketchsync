// Deterministic per-user colour derived from the userId, so the same person is
// the same colour for everyone with no coordination. Hash -> hue, fixed
// saturation/lightness for good contrast on the light canvas.

function hashString(s: string): number {
  let h = 2166136261; // FNV-1a
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function userHue(userId: string): number {
  return hashString(userId) % 360;
}

export function userColor(userId: string): string {
  return `hsl(${userHue(userId)}, 70%, 45%)`;
}

/** First 1–2 letters for an avatar chip. */
export function userInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return (parts[0] ?? "?").slice(0, 2).toUpperCase();
  return ((parts[0]?.[0] ?? "") + (parts[1]?.[0] ?? "")).toUpperCase();
}
