import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The project root (the directory holding the workspace Cargo.toml), found from this file. */
export function projectRoot(): string {
  let d = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(d, "Cargo.toml")) && existsSync(join(d, "contracts"))) return d;
    d = resolve(d, "..");
  }
  throw new Error("project root not found");
}

export const seedDir = (): string => join(projectRoot(), "data", "seed");
export const vectorsDir = (): string => join(projectRoot(), "contracts", "vectors");
