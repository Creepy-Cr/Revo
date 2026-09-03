import { afterEach, describe, expect, it } from "vitest";
import { allowedOrigins } from "./auth";

const originalEnv = {
  NODE_ENV: process.env.NODE_ENV,
  APP_ORIGINS: process.env.APP_ORIGINS,
  REPLIT_DOMAINS: process.env.REPLIT_DOMAINS,
  REPLIT_DEV_DOMAIN: process.env.REPLIT_DEV_DOMAIN,
};

function restoreEnv(key: keyof typeof originalEnv): void {
  const value = originalEnv[key];
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}

afterEach(() => {
  restoreEnv("NODE_ENV");
  restoreEnv("APP_ORIGINS");
  restoreEnv("REPLIT_DOMAINS");
  restoreEnv("REPLIT_DEV_DOMAIN");
});

describe("allowedOrigins", () => {
  it("trusts validated Replit preview domains during development", () => {
    process.env.NODE_ENV = "development";
    process.env.APP_ORIGINS = "";
    process.env.REPLIT_DOMAINS = "primary-preview.replit.dev";
    process.env.REPLIT_DEV_DOMAIN = "fallback-preview.replit.dev";

    expect(allowedOrigins()).toEqual(
      expect.arrayContaining([
        "https://primary-preview.replit.dev",
        "https://fallback-preview.replit.dev",
        "http://localhost",
        "http://127.0.0.1",
      ]),
    );
  });

  it("rejects wildcard, URL-shaped, and path-bearing Replit domain values", () => {
    process.env.NODE_ENV = "development";
    process.env.APP_ORIGINS = "";
    process.env.REPLIT_DOMAINS =
      "*.replit.dev,https://scheme.replit.dev,path.replit.dev/console,-invalid.replit.dev";
    process.env.REPLIT_DEV_DOMAIN = "";

    const origins = allowedOrigins();

    expect(origins).not.toContain("https://*.replit.dev");
    expect(origins).not.toContain("https://scheme.replit.dev");
    expect(origins).not.toContain("https://path.replit.dev");
    expect(origins).not.toContain("https://-invalid.replit.dev");
  });

  it("keeps configured application and Replit deployment origins in production", () => {
    process.env.NODE_ENV = "production";
    process.env.APP_ORIGINS = "https://therevo.xyz/console";
    process.env.REPLIT_DOMAINS = "revo-production.replit.app";
    process.env.REPLIT_DEV_DOMAIN = "preview-only.replit.dev";

    const origins = allowedOrigins();

    expect(origins).toContain("https://therevo.xyz");
    expect(origins).toContain("https://revo-production.replit.app");
    expect(origins).not.toContain("https://preview-only.replit.dev");
    expect(origins).not.toContain("http://localhost");
  });
});