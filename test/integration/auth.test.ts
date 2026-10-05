import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from "jose";
import { beforeAll, describe, expect, it } from "vitest";
import { authenticate } from "../../src/auth";
import type { Config } from "../../src/config";

const TEAM = "team.cloudflareaccess.com";
const AUD = "a".repeat(64);

const config: Config = {
  CF_ACCOUNT_ID: "0".repeat(32),
  CF_API_TOKEN: "test-token-not-a-real-credential",
  DAILY_NEURON_BUDGET: 10_000,
  SMOKE_DAILY_NEURON_BUDGET: 1_000,
  ENVIRONMENT: "production",
  ACCESS_TEAM_DOMAIN: TEAM,
  ACCESS_AUD: AUD,
  AUTH_MODE: "access"
};

let keys: ReturnType<typeof createLocalJWKSet>;
let sign: (claims: {
  iss?: string;
  aud?: string;
  sub?: string;
  expiresIn?: string;
}) => Promise<string>;
let foreignToken: string;

beforeAll(async () => {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const jwk = { ...(await exportJWK(publicKey)), kid: "k1", alg: "RS256" };
  keys = createLocalJWKSet({ keys: [jwk] });
  sign = ({
    iss = `https://${TEAM}`,
    aud = AUD,
    sub = "user-1",
    expiresIn = "5m"
  }) =>
    new SignJWT({})
      .setProtectedHeader({ alg: "RS256", kid: "k1" })
      .setIssuer(iss)
      .setAudience(aud)
      .setSubject(sub)
      .setIssuedAt()
      .setExpirationTime(expiresIn)
      .sign(privateKey);

  const other = await generateKeyPair("RS256");
  foreignToken = await new SignJWT({})
    .setProtectedHeader({ alg: "RS256", kid: "k1" })
    .setIssuer(`https://${TEAM}`)
    .setAudience(AUD)
    .setExpirationTime("5m")
    .sign(other.privateKey);
});

function requestWith(token?: string, url = "https://app.example.workers.dev/") {
  return new Request(url, {
    headers: token ? { "Cf-Access-Jwt-Assertion": token } : {}
  });
}

describe("authenticate (NFR-S1)", () => {
  it("accepts a valid Access token", async () => {
    const result = await authenticate(
      requestWith(await sign({})),
      config,
      keys
    );
    expect(result).toEqual({ ok: true, subject: "user-1" });
  });

  it("accepts a service token, which has an empty subject", async () => {
    const token = await sign({ sub: "" });
    const result = await authenticate(requestWith(token), config, keys);
    expect(result).toEqual({ ok: true, subject: "service-token" });
  });

  it("refuses a request with no token", async () => {
    const result = await authenticate(requestWith(), config, keys);
    expect(result).toEqual({ ok: false, reason: "missing Access token" });
  });

  it("refuses a token for another audience", async () => {
    const token = await sign({ aud: "b".repeat(64) });
    expect((await authenticate(requestWith(token), config, keys)).ok).toBe(
      false
    );
  });

  it("refuses a token from another issuer", async () => {
    const token = await sign({ iss: "https://evil.cloudflareaccess.com" });
    expect((await authenticate(requestWith(token), config, keys)).ok).toBe(
      false
    );
  });

  it("refuses an expired token", async () => {
    const token = await sign({ expiresIn: "-1m" });
    expect((await authenticate(requestWith(token), config, keys)).ok).toBe(
      false
    );
  });

  it("refuses a token signed with another key", async () => {
    const result = await authenticate(requestWith(foreignToken), config, keys);
    expect(result).toEqual({ ok: false, reason: "invalid Access token" });
  });

  it("refuses a malformed token", async () => {
    const result = await authenticate(requestWith("not.a.jwt"), config, keys);
    expect(result.ok).toBe(false);
  });
});

describe("dev auth mode", () => {
  const dev: Config = { ...config, AUTH_MODE: "dev" };

  it("is allowed on localhost", async () => {
    const result = await authenticate(
      requestWith(undefined, "http://localhost:5173/"),
      dev
    );
    expect(result.ok).toBe(true);
  });

  it("is refused on any other hostname", async () => {
    const result = await authenticate(requestWith(), dev);
    expect(result).toEqual({
      ok: false,
      reason: "dev auth mode is refused off localhost"
    });
  });
});
