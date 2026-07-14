import { randomUUID } from "node:crypto";
import { mkdir, rename } from "node:fs/promises";
import { dirname, relative } from "node:path";
import { isEnoent } from "./ltm-utils.js";
import { getLongTermMemoryDirectories, safeJoin } from "./paths.js";

function indexArtifactRelativePath(root: string, path: string) {
  const indexes = getLongTermMemoryDirectories(root).indexes;
  const artifactPath = relative(indexes, path).split(/[\\/]+/).join("/");
  if (!artifactPath || artifactPath === ".." || artifactPath.startsWith("../")) {
    throw new Error(`Index artifact is outside the long-term memory index directory: ${path}`);
  }
  return artifactPath;
}

export async function quarantineLtmIndexArtifact(root: string, path: string) {
  const dirs = getLongTermMemoryDirectories(root);
  const artifactPath = indexArtifactRelativePath(root, path);
  const quarantinePath = safeJoin(
    dirs.root,
    `quarantine/indexes/${Date.now()}-${randomUUID()}/${artifactPath}`,
  );
  try {
    await mkdir(dirname(quarantinePath), { recursive: true });
    await rename(path, quarantinePath);
    return quarantinePath;
  } catch (err) {
    if (isEnoent(err)) return null;
    throw err;
  }
}
