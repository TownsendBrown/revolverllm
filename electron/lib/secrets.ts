import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "fs";
import { join } from "path";
import { getDataDir } from "./config";

const SECRETS_FILE = "secrets.json";

export interface SecretsFile {
  hfTokenEnc?: string;
}

let electronDecrypt: ((enc: string) => string) | null = null;
let electronEncrypt: ((plain: string) => string) | null = null;

/** Electron main registers safeStorage encrypt/decrypt. */
export function setElectronSecretHooks(hooks: {
  encrypt: (plain: string) => string;
  decrypt: (enc: string) => string;
}): void {
  electronEncrypt = hooks.encrypt;
  electronDecrypt = hooks.decrypt;
}

function secretsPath(): string {
  return join(getDataDir(), SECRETS_FILE);
}

function readSecretsFile(): SecretsFile {
  const path = secretsPath();
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8")) as SecretsFile;
  } catch {
    return {};
  }
}

function writeSecretsFile(data: SecretsFile): void {
  mkdirSync(getDataDir(), { recursive: true });
  const path = secretsPath();
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    /* windows */
  }
}

export function isHfTokenSet(): boolean {
  if (process.env.HF_TOKEN?.trim() || process.env.HUGGING_FACE_HUB_TOKEN?.trim()) return true;
  const file = readSecretsFile();
  return Boolean(file.hfTokenEnc);
}

export function getHfToken(): string | null {
  const env = process.env.HF_TOKEN?.trim() || process.env.HUGGING_FACE_HUB_TOKEN?.trim();
  if (env) return env;
  const file = readSecretsFile();
  if (!file.hfTokenEnc) return null;
  if (electronDecrypt) {
    try {
      return electronDecrypt(file.hfTokenEnc);
    } catch {
      return null;
    }
  }
  return null;
}

export function setHfToken(token: string): void {
  const trimmed = token.trim();
  if (!trimmed) {
    clearHfToken();
    return;
  }
  process.env.HF_TOKEN = trimmed;
  process.env.HUGGING_FACE_HUB_TOKEN = trimmed;
  const file: SecretsFile = {};
  if (electronEncrypt) {
    file.hfTokenEnc = electronEncrypt(trimmed);
  } else {
    file.hfTokenEnc = Buffer.from(trimmed, "utf8").toString("base64");
  }
  writeSecretsFile(file);
}

export function clearHfToken(): void {
  delete process.env.HF_TOKEN;
  delete process.env.HUGGING_FACE_HUB_TOKEN;
  writeSecretsFile({});
}

/** Load persisted HF token into process.env at boot. */
export function bootstrapHfToken(): void {
  const token = getHfToken();
  if (token) {
    process.env.HF_TOKEN = token;
    process.env.HUGGING_FACE_HUB_TOKEN = token;
  }
}
