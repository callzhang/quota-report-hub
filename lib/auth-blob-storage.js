import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

function localStorageRoot() {
  return process.env.AUTH_BLOB_STORAGE_DIR || "";
}

function tigrisConfigured() {
  return Boolean(
    process.env.TIGRIS_STORAGE_ACCESS_KEY_ID &&
    process.env.TIGRIS_STORAGE_SECRET_ACCESS_KEY &&
    process.env.TIGRIS_STORAGE_BUCKET
  );
}

export function authBlobStorageConfigured() {
  return Boolean(localStorageRoot()) || tigrisConfigured();
}

function encodeKeyPart(value) {
  return encodeURIComponent(String(value || "default"));
}

export function authBlobKey({ source, accountId, sessionId = "", digest }) {
  return [
    "auth-pool",
    encodeKeyPart(source),
    encodeKeyPart(accountId),
    encodeKeyPart(sessionId || "default"),
    `${encodeKeyPart(digest)}.json`,
  ].join("/");
}

async function writeLocalAuthBlob(key, envelope) {
  const path = join(localStorageRoot(), key);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(envelope), "utf8");
}

async function readLocalAuthBlob(key) {
  return JSON.parse(await readFile(join(localStorageRoot(), key), "utf8"));
}

async function tigrisClient() {
  return import("@tigrisdata/storage");
}

export async function writeAuthBlob(key, envelope) {
  if (localStorageRoot()) {
    await writeLocalAuthBlob(key, envelope);
    return { key, storage: "local" };
  }
  if (!tigrisConfigured()) {
    throw new Error("auth blob object storage is not configured");
  }
  const { put } = await tigrisClient();
  const result = await put(key, JSON.stringify(envelope), {
    access: "private",
    contentType: "application/json",
    allowOverwrite: true,
  });
  if (result.error) {
    throw result.error;
  }
  return { key, storage: "tigris" };
}

export async function readAuthBlob(key) {
  if (localStorageRoot()) {
    return readLocalAuthBlob(key);
  }
  if (!tigrisConfigured()) {
    throw new Error("auth blob object storage is not configured");
  }
  const { get } = await tigrisClient();
  const result = await get(key, "string");
  if (result.error) {
    throw result.error;
  }
  return JSON.parse(result.data);
}
