import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { logger } from "../../lib/logger.js";
import { isEnoent } from "./ltm-utils.js";

const ATOMIC_RENAME_RETRY_DELAYS_MS = [10, 25, 50] as const;

async function fsyncPath(path: string) {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY);
    await handle.sync();
  } catch {
    // Best effort: Android/Termux and some network filesystems can reject
    // directory fsync even when file writes are otherwise durable.
  } finally {
    await handle?.close().catch(() => {});
  }
}

function isRetryableAtomicRenameError(err: unknown) {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return code === "EPERM" || code === "EACCES" || code === "EBUSY";
}

async function sleep(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export async function renameWithRetry(
  fromPath: string,
  toPath: string,
  renameFn: (from: string, to: string) => Promise<void> = rename,
) {
  let lastError: unknown;
  for (let attempt = 0; attempt <= ATOMIC_RENAME_RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      await renameFn(fromPath, toPath);
      return;
  } catch (err) {
    if (!isRetryableAtomicRenameError(err) || attempt === ATOMIC_RENAME_RETRY_DELAYS_MS.length) {
      if (!isRetryableAtomicRenameError(err)) {
        logger.warn(err, "Atomic rename non-retryable error from %s to %s", fromPath, toPath);
      }
      throw err;
    }
    lastError = err;
      const delayMs = ATOMIC_RENAME_RETRY_DELAYS_MS[attempt];
      if (delayMs === undefined) throw err;
      await sleep(delayMs);
    }
  }
  throw lastError;
}

export async function writeJsonAtomic(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true });
  const tmpPath = `${path}.tmp-${process.pid}-${Date.now()}-${randomUUID()}`;
  const content = `${JSON.stringify(value, null, 2)}\n`;
  let handle;
  try {
    handle = await open(tmpPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    await handle.writeFile(content, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await renameWithRetry(tmpPath, path);
    await fsyncPath(dirname(path));
  } catch (err) {
    await handle?.close().catch(() => {});
    await unlink(tmpPath).catch(() => {});
    throw err;
  }
}

export async function createJsonFileExclusive(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true });
  const tmpPath = `${path}.tmp-${process.pid}-${Date.now()}-${randomUUID()}`;
  const content = `${JSON.stringify(value, null, 2)}\n`;
  let handle;
  try {
    handle = await open(tmpPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    await handle.writeFile(content, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await link(tmpPath, path);
    await unlink(tmpPath);
    await fsyncPath(dirname(path));
  } catch (err) {
    await handle?.close().catch(() => {});
    await unlink(tmpPath).catch(() => {});
    throw err;
  }
}

export async function readJsonFile<T>(path: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch (err) {
    if (isEnoent(err)) return fallback;
    throw err;
  }
}

export async function appendJsonLineAtomic(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true });
  const line = `${JSON.stringify(value)}\n`;
  let handle;
  try {
    handle = await open(path, constants.O_CREAT | constants.O_APPEND | constants.O_WRONLY, 0o600);
    await handle.writeFile(line, "utf8");
    await handle.sync();
  } finally {
    await handle?.close().catch(() => {});
  }
}

export { fsyncPath };
