import { describe, it, expect } from "vitest";
import {
  verifyPassword,
  signToken,
  verifyToken,
  loginCookieValue,
  clearCookieValue,
  COOKIE_NAME,
} from "../src/server/ui-auth.js";

/**
 * Auth primitives: password comparison is constant-time and length-safe;
 * the signed cookie token round-trips, rejects tampering/expiry/wrong-secret,
 * and the cookie header strings carry the right attributes.
 */

const SECRET = "correct-horse-battery-staple";

describe("verifyPassword", () => {
  it("accepts the correct password", () => {
    expect(verifyPassword("hunter2", "hunter2")).toBe(true);
  });

  it("rejects a wrong password", () => {
    expect(verifyPassword("wrong", "hunter2")).toBe(false);
  });

  it("rejects empty guess against non-empty expected", () => {
    expect(verifyPassword("", "hunter2")).toBe(false);
  });

  it("handles equal-length-but-wrong guesses (no false positive)", () => {
    expect(verifyPassword("hunter3", "hunter2")).toBe(false);
    expect(verifyPassword("hunter1", "hunter2")).toBe(false);
  });
});

describe("signToken / verifyToken", () => {
  it("round-trips: a freshly signed token verifies", () => {
    const token = signToken(SECRET);
    expect(verifyToken(token, SECRET)).toBe(true);
  });

  it("rejects a token verified with the wrong secret", () => {
    const token = signToken(SECRET);
    expect(verifyToken(token, "different-secret")).toBe(false);
  });

  it("rejects a tampered token (signature no longer matches)", () => {
    const token = signToken(SECRET);
    const tampered = token.slice(0, -2) + "XX";
    expect(verifyToken(tampered, SECRET)).toBe(false);
  });

  it("rejects an expired token", () => {
    // Sign in the past, verify at "now" — already expired.
    const expiredAt = Date.now() - 1000;
    const pastSignTime = expiredAt - 7 * 24 * 60 * 60 * 1000;
    const token = signToken(SECRET, pastSignTime);
    expect(verifyToken(token, SECRET, expiredAt)).toBe(false);
  });

  it("accepts a token that is still valid (exp just ahead)", () => {
    const now = 1_000_000;
    const token = signToken(SECRET, now); // exp = now + 7d
    expect(verifyToken(token, SECRET, now + 1000)).toBe(true);
  });

  it("rejects undefined / malformed tokens", () => {
    expect(verifyToken(undefined, SECRET)).toBe(false);
    expect(verifyToken("", SECRET)).toBe(false);
    expect(verifyToken("no-dot-here", SECRET)).toBe(false);
    expect(verifyToken("a.b.c", SECRET)).toBe(false);
  });

  it("rejects a token whose payload is not valid JSON", () => {
    const encoded = Buffer.from("not json", "utf8").toString("base64url");
    const sig = "deadbeef";
    expect(verifyToken(`${encoded}.${sig}`, SECRET)).toBe(false);
  });
});

describe("cookie header strings", () => {
  it("loginCookieValue carries name, HttpOnly, SameSite=Strict, Max-Age, Path", () => {
    const val = loginCookieValue(SECRET);
    expect(val.startsWith(`${COOKIE_NAME}=`)).toBe(true);
    expect(val).toContain("HttpOnly");
    expect(val).toContain("SameSite=Strict");
    expect(val).toContain("Path=/");
    expect(val).toContain("Max-Age=");
    // The value portion is a verifiable token.
    const tokenVal = val.slice(`${COOKIE_NAME}=`.length).split(";")[0];
    expect(verifyToken(tokenVal, SECRET)).toBe(true);
  });

  it("clearCookieValue sets Max-Age=0 to delete the cookie", () => {
    const val = clearCookieValue();
    expect(val).toContain(`${COOKIE_NAME}=`);
    expect(val).toContain("Max-Age=0");
    expect(val).toContain("HttpOnly");
  });
});
