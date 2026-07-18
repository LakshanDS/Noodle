import { describe, it, expect } from "vitest";
import crypto from "node:crypto";
import { buildAppJwt, loadPrivateKey } from "../src/github/app-auth.js";

/** Generate a fresh RSA keypair (2048-bit) for these tests. */
function genKeyPair(): { publicKey: string; privateKey: string } {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  return { publicKey, privateKey };
}

function decodeJwtParts(jwt: string): { header: object; payload: object } {
  const [h, p] = jwt.split(".");
  const dec = (s: string) => JSON.parse(Buffer.from(s, "base64url").toString("utf8"));
  return { header: dec(h), payload: dec(p) };
}

describe("buildAppJwt", () => {
  it("produces a three-part JWT with RS256 header", () => {
    const { privateKey } = genKeyPair();
    const jwt = buildAppJwt("123456", privateKey, 1_700_000_000_000);
    expect(jwt.split(".")).toHaveLength(3);
    expect(decodeJwtParts(jwt).header).toEqual({ alg: "RS256", typ: "JWT" });
  });

  it("embeds iss/iat/exp claims with correct shape", () => {
    const { privateKey } = genKeyPair();
    const now = 1_700_000_000_000;
    const jwt = buildAppJwt("123456", privateKey, now);
    const { payload } = decodeJwtParts(jwt) as {
      payload: { iss: string; iat: number; exp: number };
    };
    expect(payload.iss).toBe("123456");
    // iat = now/1000 - 60 (skew tolerance), exp = now/1000 + 10min
    expect(payload.iat).toBe(Math.floor(now / 1000) - 60);
    expect(payload.exp).toBe(Math.floor(now / 1000) + 600);
  });

  it("produces a signature verifiable with the matching public key", () => {
    const { publicKey, privateKey } = genKeyPair();
    const jwt = buildAppJwt("123456", privateKey, 1_700_000_000_000);
    const [signingInput, signatureB64] = [jwt.slice(0, jwt.lastIndexOf(".")), jwt.slice(jwt.lastIndexOf(".") + 1)];
    const verifier = crypto.createVerify("RSA-SHA256");
    verifier.update(signingInput);
    expect(verifier.verify(publicKey, Buffer.from(signatureB64, "base64url"))).toBe(true);
  });

  it("rejects a signature verified against the wrong key", () => {
    const { privateKey } = genKeyPair();
    const { publicKey: otherPublic } = genKeyPair();
    const jwt = buildAppJwt("123456", privateKey, 1_700_000_000_000);
    const [signingInput, signatureB64] = [jwt.slice(0, jwt.lastIndexOf(".")), jwt.slice(jwt.lastIndexOf(".") + 1)];
    const verifier = crypto.createVerify("RSA-SHA256");
    verifier.update(signingInput);
    expect(verifier.verify(otherPublic, Buffer.from(signatureB64, "base64url"))).toBe(false);
  });
});

describe("loadPrivateKey", () => {
  it("unescapes literal \\n in the inline PEM", () => {
    const pem = "-----BEGIN PRIVATE KEY-----\\nABCD\\n-----END PRIVATE KEY-----";
    expect(loadPrivateKey(pem)).toBe(
      "-----BEGIN PRIVATE KEY-----\nABCD\n-----END PRIVATE KEY-----",
    );
  });

  it("throws when no key source is set", () => {
    delete process.env.GITHUB_PRIVATE_KEY_FILE;
    expect(() => loadPrivateKey(undefined)).toThrow(/not found/);
  });
});
