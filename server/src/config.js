import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

const env = process.env;
const clean = (value, fallback = "") => String(value ?? "").replace(/[\r\n]+/g, " ").trim() || fallback;

export const ENV = {
  port: Number(env.PORT) || 4400,
  dataDir: resolve(clean(env.DATA_DIR, "./.data")),
  webDir: resolve(clean(env.WEB_DIR, "../web/out")),
  adminSecret: clean(env.ADMIN_SECRET),
  /** Optional JSON file with initial settings, used when settings.json does not exist yet. */
  seedFile: clean(env.SETTINGS_SEED),
};

mkdirSync(ENV.dataDir, { recursive: true });
