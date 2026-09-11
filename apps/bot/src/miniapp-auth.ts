import { createHmac, timingSafeEqual } from "node:crypto";

export interface MiniAppUser {
  id: number;
  firstName: string;
}

// initData is a short-lived bearer credential. Never persist or log it.
export function validateMiniAppData(
  data: string,
  token: string,
  now = Math.floor(Date.now() / 1000),
): MiniAppUser | null {
  if (!data || data.length > 8192 || !token) return null;
  const fields = new URLSearchParams(data);
  const keys = new Set<string>();
  for (const [key, value] of fields) {
    if (!/^[a-z_]+$/u.test(key) || keys.has(key) || /[\r\n]/u.test(value)) return null;
    keys.add(key);
  }
  const hash = fields.get("hash") ?? "";
  const date = fields.get("auth_date") ?? "";
  if (!/^[a-f0-9]{64}$/iu.test(hash) || !/^\d{1,12}$/u.test(date)) return null;
  const authDate = Number(date);
  if (authDate > now + 30 || now - authDate > 3600) return null;
  fields.delete("hash");
  fields.sort();
  // The HMAC includes signature when Telegram supplies it. Only Ed25519's
  // separate third-party validation scheme excludes both hash and signature.
  const check = [...fields].map(([key, value]) => `${key}=${value}`).join("\n");
  const secret = createHmac("sha256", "WebAppData").update(token).digest();
  const expected = createHmac("sha256", secret).update(check).digest();
  if (!timingSafeEqual(expected, Buffer.from(hash, "hex"))) return null;
  try {
    const user: unknown = JSON.parse(fields.get("user") ?? "null");
    if (!user || typeof user !== "object" || !("id" in user) || !("first_name" in user))
      return null;
    if (
      typeof user.id !== "number" ||
      !Number.isSafeInteger(user.id) ||
      user.id <= 0 ||
      typeof user.first_name !== "string" ||
      ("is_bot" in user && user.is_bot !== false)
    )
      return null;
    return { id: user.id, firstName: user.first_name.slice(0, 100) };
  } catch {
    return null;
  }
}
