import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import type { Config } from "./config";

/**
 * Verifies the Cloudflare Access token on a request (NFR-S1). Access sits in
 * front of the Worker and adds this header; the Worker checks it again so a
 * request that reaches it by any other path is refused.
 */

const ACCESS_JWT_HEADER = "Cf-Access-Jwt-Assertion";
const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1"]);

export type AuthResult =
  | { ok: true; subject: string }
  | { ok: false; reason: string };

const keySets = new Map<string, JWTVerifyGetKey>();

function accessKeys(teamDomain: string): JWTVerifyGetKey {
  const cached = keySets.get(teamDomain);
  if (cached) return cached;
  const keys = createRemoteJWKSet(
    new URL(`https://${teamDomain}/cdn-cgi/access/certs`)
  );
  keySets.set(teamDomain, keys);
  return keys;
}

export async function authenticate(
  request: Request,
  config: Config,
  keys: JWTVerifyGetKey = accessKeys(config.ACCESS_TEAM_DOMAIN)
): Promise<AuthResult> {
  if (config.AUTH_MODE === "dev") {
    // The bypass exists for local development only.
    return LOCAL_HOSTNAMES.has(new URL(request.url).hostname)
      ? { ok: true, subject: "local-dev" }
      : { ok: false, reason: "dev auth mode is refused off localhost" };
  }

  const token = request.headers.get(ACCESS_JWT_HEADER);
  if (!token) return { ok: false, reason: "missing Access token" };

  try {
    const { payload } = await jwtVerify(token, keys, {
      issuer: `https://${config.ACCESS_TEAM_DOMAIN}`,
      audience: config.ACCESS_AUD
    });
    return { ok: true, subject: payload.sub || "service-token" };
  } catch {
    return { ok: false, reason: "invalid Access token" };
  }
}
