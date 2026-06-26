import { describe, expect, it } from "vitest";
import {
  REDACTED_PASSWORD_PLACEHOLDER,
  redactConnectionString,
  redactCredentialsFromMessage,
  redactKeywordPassword,
  redactUrlPassword,
  redactUrlQueryPassword,
} from "../credential-redact.js";

describe("credential-redact", () => {
  describe("redactUrlPassword — userinfo form", () => {
    it("redacts the password in a postgres URL with userinfo", () => {
      const out = redactUrlPassword("postgresql://user:s3cr3t@host:5432/db");
      expect(out).toBe(`postgresql://user:${REDACTED_PASSWORD_PLACEHOLDER}@host:5432/db`);
      expect(out).not.toContain("s3cr3t");
    });

    it("leaves a URL with no password unchanged", () => {
      const url = "postgresql://user@host:5432/db";
      expect(redactUrlPassword(url)).toBe(url);
    });
  });

  describe("redactUrlQueryPassword — ?password= query-param form (review #22)", () => {
    it("redacts a leading ?password= query param", () => {
      const out = redactUrlQueryPassword("postgresql://host:5432/db?password=s3cr3t");
      expect(out).toBe(`postgresql://host:5432/db?password=${REDACTED_PASSWORD_PLACEHOLDER}`);
      expect(out).not.toContain("s3cr3t");
    });

    it("redacts a subsequent &password= query param while preserving other params", () => {
      const out = redactUrlQueryPassword(
        "postgresql://host:5432/db?sslmode=require&password=s3cr3t&application_name=fn",
      );
      expect(out).toBe(
        `postgresql://host:5432/db?sslmode=require&password=${REDACTED_PASSWORD_PLACEHOLDER}&application_name=fn`,
      );
      expect(out).not.toContain("s3cr3t");
      expect(out).toContain("sslmode=require");
      expect(out).toContain("application_name=fn");
    });

    it("redacts up to a fragment (#)", () => {
      const out = redactUrlQueryPassword("postgresql://host/db?password=secret#frag");
      expect(out).toBe(`postgresql://host/db?password=${REDACTED_PASSWORD_PLACEHOLDER}#frag`);
    });

    it("leaves a URL with no password query param unchanged", () => {
      const url = "postgresql://host:5432/db?sslmode=require";
      expect(redactUrlQueryPassword(url)).toBe(url);
    });
  });

  describe("redactUrlPassword also covers query-param passwords", () => {
    it("redacts both userinfo and query-param passwords when both present", () => {
      const out = redactUrlPassword("postgresql://user:ui-pass@host:5432/db?password=q-pass");
      expect(out).not.toContain("ui-pass");
      expect(out).not.toContain("q-pass");
      expect(out).toContain(REDACTED_PASSWORD_PLACEHOLDER);
    });
  });

  describe("redactConnectionString — dispatch", () => {
    it("redacts query-param password in URL form", () => {
      const out = redactConnectionString("postgresql://host:5432/db?password=s3cr3t");
      expect(out).not.toContain("s3cr3t");
    });

    it("redacts keyword/value password", () => {
      const out = redactKeywordPassword("host=localhost password=s3cr3t dbname=fusion");
      expect(out).toBe(`host=localhost password=${REDACTED_PASSWORD_PLACEHOLDER} dbname=fusion`);
    });
  });

  describe("redactCredentialsFromMessage — driver error fallback", () => {
    it("redacts query-param password embedded in an error message", () => {
      const msg = `connect ECONNREFUSED postgresql://host:5432/db?password=leaked`;
      const out = redactCredentialsFromMessage(msg);
      expect(out).not.toContain("leaked");
      expect(out).toContain(REDACTED_PASSWORD_PLACEHOLDER);
    });

    it("redacts userinfo password embedded in an error message", () => {
      const msg = `connect ECONNREFUSED postgresql://user:leaked@host:5432/db`;
      const out = redactCredentialsFromMessage(msg);
      expect(out).not.toContain("leaked");
    });
  });
});
