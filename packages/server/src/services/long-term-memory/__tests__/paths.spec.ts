import test from "node:test";
import assert from "node:assert/strict";
import { assertInsideDirectory, safeJoin } from "../paths.js";
import { ltmSafeRelativePathSchema } from "@marinara-engine/shared";

test("assertInsideDirectory — rejects parent traversal", () => {
  assert.throws(() => assertInsideDirectory("/root", "/root/../etc/passwd"), /Path escapes/);
});

test("assertInsideDirectory — rejects null-byte injection", () => {
  assert.throws(() => assertInsideDirectory("/root", "/root/file\0../../../etc/passwd"), /Path escapes/);
});

test("assertInsideDirectory — accepts paths inside root", () => {
  const result = assertInsideDirectory("/root", "/root/vault/note.json");
  assert.equal(result, "/root/vault/note.json");
});

test("assertInsideDirectory — rejects sibling directories", () => {
  assert.throws(() => assertInsideDirectory("/root/vault", "/root/other-dir/file"), /Path escapes/);
});

test("safeJoin — rejects backslash traversal on Windows-style paths", () => {
  assert.throws(() => safeJoin("/root", "..\\..\\etc\\passwd"), /Path must not contain/);
});

test("safeJoin — rejects non-relative absolute paths", () => {
  assert.throws(() => safeJoin("/root", "/etc/passwd"), /Path must be relative/);
});

test("safeJoin — accepts valid relative paths", () => {
  const result = safeJoin("/root", "vault/note.json");
  assert.ok(result.endsWith("vault/note.json"));
});

test("ltmSafeRelativePathSchema — rejects empty strings", () => {
  assert.throws(() => ltmSafeRelativePathSchema.parse(""));
});

test("ltmSafeRelativePathSchema — rejects absolute paths", () => {
  assert.throws(() => ltmSafeRelativePathSchema.parse("/etc/passwd"));
});

test("ltmSafeRelativePathSchema — rejects parent traversal", () => {
  assert.throws(() => ltmSafeRelativePathSchema.parse("../escape"));
});
