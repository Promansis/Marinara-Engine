import assert from "node:assert/strict";
import test from "node:test";
import {
  FULL_BACKUP_DATA_DIRS,
  PROFILE_EXPORT_ASSET_DIRS,
} from "../../../routes/backup.routes.js";

test("full backups include LTM while profile exports do not duplicate its private store", () => {
  assert(FULL_BACKUP_DATA_DIRS.includes("long-term-memory"));
  assert.equal(PROFILE_EXPORT_ASSET_DIRS.includes("long-term-memory"), false);
});
