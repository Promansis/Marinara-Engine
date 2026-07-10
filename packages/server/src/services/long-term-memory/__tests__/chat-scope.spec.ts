import test from "node:test";
import assert from "node:assert/strict";
import { normalizeLtmChatCharacterIds, ltmModeForChatMode, resolveChatLtmScope } from "../chat-scope.js";

test("normalizeLtmChatCharacterIds — array input", () => {
  assert.deepEqual(normalizeLtmChatCharacterIds(["a", "b", "a"]), ["a", "b"]);
});

test("normalizeLtmChatCharacterIds — JSON string input", () => {
  assert.deepEqual(normalizeLtmChatCharacterIds('["a","b"]'), ["a", "b"]);
});

test("normalizeLtmChatCharacterIds — plain string", () => {
  assert.deepEqual(normalizeLtmChatCharacterIds("char_abc"), ["char_abc"]);
});

test("normalizeLtmChatCharacterIds — nullish returns []", () => {
  assert.deepEqual(normalizeLtmChatCharacterIds(null), []);
  assert.deepEqual(normalizeLtmChatCharacterIds(undefined), []);
});

test("normalizeLtmChatCharacterIds — empty array returns []", () => {
  assert.deepEqual(normalizeLtmChatCharacterIds([]), []);
});

test("ltmModeForChatMode — valid modes map correctly", () => {
  assert.equal(ltmModeForChatMode("roleplay"), "roleplay");
  assert.equal(ltmModeForChatMode("conversation"), "conversation");
  assert.equal(ltmModeForChatMode("game"), "game");
  assert.equal(ltmModeForChatMode("visual_novel"), "roleplay");
});

test("ltmModeForChatMode — invalid falls back to roleplay", () => {
  assert.equal(ltmModeForChatMode("invalid"), "roleplay");
  assert.equal(ltmModeForChatMode(undefined), "roleplay");
});

test("resolveChatLtmScope — with group and characters", () => {
  const scope = resolveChatLtmScope({ id: "chat_1", groupId: "group_1", characterIds: ["char_a", "char_b"] });
  assert.equal(scope.chatId, "chat_1");
  assert.equal(scope.groupId, "group_1");
  assert.ok(scope.characterIds?.includes("char_a"));
  assert.ok(scope.characterIds?.includes("char_b"));
});

test("resolveChatLtmScope — produces correct chatIds in scope links", () => {
  const scope = resolveChatLtmScope({ id: "chat_1" });
  assert.ok(scope.chatIds?.includes("chat_1"));
});

test("resolveChatLtmScope — without group", () => {
  const scope = resolveChatLtmScope({ id: "chat_1" });
  assert.equal(scope.chatId, "chat_1");
  assert.equal(scope.groupId, undefined);
});

test("resolveChatLtmScope — without characters", () => {
  const scope = resolveChatLtmScope({ id: "chat_1" });
  assert.equal(scope.characterIds, undefined);
});
