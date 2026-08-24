import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// Pinned scrcpy server version. Bumping it means re-validating the wire protocol
// in `scrcpy.ts` (the framing drifts between scrcpy majors).
export const SCRCPY_VERSION = "4.0";
export const SCRCPY_SERVER_SHA256 = "84924bd564a1eb6089c872c7521f968058977f91f5ff02514a8c74aff3210f3a";

const DOWNLOAD_URL = `https://github.com/Genymobile/scrcpy/releases/download/v${SCRCPY_VERSION}/scrcpy-server-v${SCRCPY_VERSION}`;

const here = dirname(fileURLToPath(import.meta.url));
// `src/scrcpy-server.ts` -> `<pkg>/vendor`; `dist/scrcpy-server.js` -> `<pkg>/vendor`.
const VENDOR_DIR = join(here, "..", "vendor");
export const SCRCPY_SERVER_PATH = join(VENDOR_DIR, `scrcpy-server-v${SCRCPY_VERSION}`);
let pendingEnsure: Promise<string> | null = null;

function sha256(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

export function verifyScrcpyServer(data: Uint8Array): void {
  const actual = sha256(data);
  if (actual !== SCRCPY_SERVER_SHA256) {
    throw new Error(
      `scrcpy-server v${SCRCPY_VERSION} checksum mismatch: expected ${SCRCPY_SERVER_SHA256}, got ${actual}`,
    );
  }
}

async function ensureScrcpyServerOnce(): Promise<string> {
  if (existsSync(SCRCPY_SERVER_PATH)) {
    const existing = await readFile(SCRCPY_SERVER_PATH);
    try {
      verifyScrcpyServer(existing);
      return SCRCPY_SERVER_PATH;
    } catch {
      console.warn(`Replacing scrcpy-server v${SCRCPY_VERSION} because its checksum is invalid.`);
    }
  }

  await mkdir(VENDOR_DIR, { recursive: true });
  console.log(`Downloading scrcpy-server v${SCRCPY_VERSION}…`);
  const res = await fetch(DOWNLOAD_URL);
  if (!res.ok) throw new Error(`Failed to download ${DOWNLOAD_URL}: ${res.status} ${res.statusText}`);
  const buf = new Uint8Array(await res.arrayBuffer());
  verifyScrcpyServer(buf);

  const temporaryPath = `${SCRCPY_SERVER_PATH}.${process.pid}.tmp`;
  try {
    await writeFile(temporaryPath, buf);
    await rename(temporaryPath, SCRCPY_SERVER_PATH);
  } finally {
    await rm(temporaryPath, { force: true });
  }
  console.log(`Saved ${SCRCPY_SERVER_PATH} (${buf.byteLength} bytes)`);
  return SCRCPY_SERVER_PATH;
}

export function ensureScrcpyServer(): Promise<string> {
  if (!pendingEnsure) {
    pendingEnsure = ensureScrcpyServerOnce().finally(() => {
      pendingEnsure = null;
    });
  }
  return pendingEnsure;
}
