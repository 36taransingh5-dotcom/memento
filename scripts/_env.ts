import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Minimal .env loader for CLI scripts.
 *
 * Next.js loads .env.local automatically for the app; `tsx scripts/*.ts` does
 * not, and pulling in a dependency for twenty lines of parsing is not worth it.
 * Precedence matches Next: real environment > .env.local > .env.
 */

const FILES = [".env.local", ".env"] as const;

export function loadEnv(): void {
  for (const file of FILES) {
    const path = resolve(process.cwd(), file);
    if (!existsSync(path)) continue;

    for (const rawLine of readFileSync(path, "utf8").split("\n")) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;

      const eq = line.indexOf("=");
      if (eq === -1) continue;

      const key = line.slice(0, eq).trim();
      if (!key || key in process.env) continue;

      let value = line.slice(eq + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      process.env[key] = value;
    }
  }

  // Local docker-compose default, so a fresh clone runs with zero configuration.
  process.env["DATABASE_URL"] ??=
    "postgresql://root@localhost:26257/memento?sslmode=disable";
}

export const GREEN = "\u001b[32m";
export const YELLOW = "\u001b[33m";
export const RED = "\u001b[31m";
export const DIM = "\u001b[2m";
export const BOLD = "\u001b[1m";
export const RESET = "\u001b[0m";

export function ok(message: string): void {
  console.log(`${GREEN}✓${RESET} ${message}`);
}
export function warn(message: string): void {
  console.log(`${YELLOW}!${RESET} ${message}`);
}
export function fail(message: string): void {
  console.log(`${RED}✗${RESET} ${message}`);
}
export function info(message: string): void {
  console.log(`${DIM}·${RESET} ${message}`);
}
export function heading(message: string): void {
  console.log(`\n${BOLD}${message}${RESET}`);
}
