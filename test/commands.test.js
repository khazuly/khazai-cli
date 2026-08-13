import assert from "node:assert/strict";
import test from "node:test";
import { COMMANDS, canonicalCommand, formatCommandHelp, groupedCommands, visibleCommands } from "../ui/commands.js";

test("command reference and palette use the same grouped metadata", () => {
  const groups = groupedCommands();
  const help = formatCommandHelp();

  assert.deepEqual(groups.map(group => group.label), ["Session", "Workspace", "View", "Settings"]);
  assert.match(help, /\*\*Session\*\*[\s\S]*`\/sessions`/);
  assert.match(help, /\*\*Workspace\*\*[\s\S]*`\/mcp`/);
  assert.match(help, /\*\*View\*\*[\s\S]*`\/theme`/);
  assert.match(help, /\*\*Settings\*\*[\s\S]*`\/help`/);
  assert.match(help, /`\/exit` — Exit KhazAI/);
  assert.equal(canonicalCommand("/quit")?.name, "/exit");
  assert.equal(visibleCommands().some(command => command.name === "/connect"), true);
  assert.equal(visibleCommands().some(command => command.name === "/connections"), true);
  assert.equal(visibleCommands().some(command => command.name === "/quit"), false);
  assert.deepEqual(
    COMMANDS.find(command => command.name === "/sessions").sub.map(command => command.name),
    ["list", "resume", "delete", "clear"],
  );
  assert.equal(COMMANDS.find(command => command.name === "/init").sub, undefined);
  assert.equal(COMMANDS.some(command => command.name === "/plan"), false);
  assert.doesNotMatch(help, /\/plan (?:hide|show|toggle)/);
  assert.equal(groups.flatMap(group => group.commands).length, COMMANDS.length);
});
