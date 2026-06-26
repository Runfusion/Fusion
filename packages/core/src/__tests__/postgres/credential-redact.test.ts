import { describe, it, expect } from "vitest";
import {
  redactUrlPassword,
  redactKeywordPassword,
  redactConnectionString,
  redactCredentialsFromMessage,
  REDACTED_PASSWORD_PLACEHOLDER,
} from "../../postgres/credential-redact.js";

describe("credential-redact: redactUrlPassword", () => {
  it("redacts the password from a postgresql:// URL with userinfo", () => {
    const url = "postgresql://fusion:s3cr3tP@ss@localhost:5432/fusion";
    const redacted = redactUrlPassword(url);
    expect(redacted).not.toContain("s3cr3tP@ss");
    expect(redacted).toContain(REDACTED_PASSWORD_PLACEHOLDER);
    expect(redacted).toContain("localhost:5432");
    expect(redacted).toContain("/fusion");
    expect(redacted).toContain("fusion:"); // username preserved
  });

  it("preserves host, port, database, and query params", () => {
    const url = "postgres://user:pw@db.example.com:6543/prod?sslmode=require";
    const redacted = redactUrlPassword(url);
    expect(redacted).toContain("db.example.com:6543");
    expect(redacted).toContain("/prod");
    expect(redacted).toContain("sslmode=require");
    expect(redacted).not.toContain(":pw@");
  });

  it("returns unchanged when no userinfo password is present", () => {
    const url = "postgresql://user@localhost:5432/fusion";
    expect(redactUrlPassword(url)).toBe(url);
  });

  it("returns unchanged when there is no userinfo at all", () => {
    const url = "postgresql://localhost:5432/fusion";
    expect(redactUrlPassword(url)).toBe(url);
  });

  it("handles passwords with special characters", () => {
    const url = "postgresql://user:p@$$w0rd!@localhost:5432/db";
    const redacted = redactUrlPassword(url);
    expect(redacted).not.toContain("p@$$w0rd!");
    expect(redacted).toContain(REDACTED_PASSWORD_PLACEHOLDER);
  });
});

describe("credential-redact: redactKeywordPassword", () => {
  it("redacts password= in a keyword/value connection string", () => {
    const connStr = "host=localhost password=s3cr3t port=5432 dbname=fusion";
    const redacted = redactKeywordPassword(connStr);
    expect(redacted).not.toContain("s3cr3t");
    expect(redacted).toContain("password=********");
    expect(redacted).toContain("host=localhost");
    expect(redacted).toContain("dbname=fusion");
  });

  it("handles quoted passwords", () => {
    const connStr = 'host=h password="my secret" dbname=db';
    const redacted = redactKeywordPassword(connStr);
    expect(redacted).not.toContain("my secret");
    expect(redacted).toContain("password=********");
  });

  it("returns unchanged when no password keyword is present", () => {
    const connStr = "host=localhost port=5432 dbname=fusion";
    expect(redactKeywordPassword(connStr)).toBe(connStr);
  });
});

describe("credential-redact: redactConnectionString (dispatch)", () => {
  it("dispatches to URL form for postgresql:// strings", () => {
    const url = "postgresql://user:pass@host/db";
    const redacted = redactConnectionString(url);
    expect(redacted).not.toContain(":pass@");
    expect(redacted).toContain(REDACTED_PASSWORD_PLACEHOLDER);
  });

  it("dispatches to keyword form for key=value strings", () => {
    const connStr = "host=localhost password=secret dbname=db";
    const redacted = redactConnectionString(connStr);
    expect(redacted).not.toContain("secret");
    expect(redacted).toContain(REDACTED_PASSWORD_PLACEHOLDER);
  });

  it("handles strings with leading whitespace", () => {
    const url = "  postgres://user:pw@host/db";
    const redacted = redactConnectionString(url);
    expect(redacted).not.toContain(":pw@");
  });
});

describe("credential-redact: redactCredentialsFromMessage", () => {
  it("redacts URL passwords embedded in error messages", () => {
    const msg = `Connection failed: postgresql://admin:hunter2@10.0.0.1:5432/db timed out`;
    const redacted = redactCredentialsFromMessage(msg);
    expect(redacted).not.toContain("hunter2");
    expect(redacted).toContain(REDACTED_PASSWORD_PLACEHOLDER);
    expect(redacted).toContain("10.0.0.1:5432");
  });

  it("redacts keyword passwords embedded in error messages", () => {
    const msg = `Connection string host=h password=topsecret port=5432 failed`;
    const redacted = redactCredentialsFromMessage(msg);
    expect(redacted).not.toContain("topsecret");
    expect(redacted).toContain(REDACTED_PASSWORD_PLACEHOLDER);
  });

  it("handles messages with no credentials unchanged", () => {
    const msg = "Connection refused at localhost:5432";
    expect(redactCredentialsFromMessage(msg)).toBe(msg);
  });
});
