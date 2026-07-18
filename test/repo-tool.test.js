import assert from "node:assert/strict";
import test from "node:test";
import { parseGitHubRepository, repoTool } from "../tools/repo.js";

test("repo tool parses GitHub repository and blob URLs", () => {
  assert.deepEqual(parseGitHubRepository("https://github.com/WhiskeySockets/Baileys"), {
    owner: "WhiskeySockets", repo: "Baileys", path: "",
  });
  assert.deepEqual(parseGitHubRepository("https://github.com/WhiskeySockets/Baileys/blob/main/src/index.ts"), {
    owner: "WhiskeySockets", repo: "Baileys", path: "src/index.ts",
  });
  assert.equal(parseGitHubRepository("https://gitlab.com/owner/repo"), null);
});

test("repo overview returns metadata, recursive tree, and README", async () => {
  const originalFetch = global.fetch;
  global.fetch = async value => {
    const url = String(value);
    if (url === "https://api.github.com/repos/Fixture/repo-tool") {
      return Response.json({
        full_name: "Fixture/repo-tool",
        description: "Repository fixture",
        default_branch: "main",
        language: "TypeScript",
        license: { spdx_id: "MIT" },
        stargazers_count: 42,
        updated_at: "2026-07-14T00:00:00Z",
      });
    }
    if (url.includes("/git/trees/main?recursive=1")) {
      return Response.json({ tree: [
        { type: "tree", path: "src" },
        { type: "blob", path: "src/index.ts" },
        { type: "blob", path: "README.md" },
      ] });
    }
    if (url.includes("/readme?ref=main")) {
      return Response.json({ path: "README.md", encoding: "base64", content: Buffer.from("# Fixture\n\nUsage docs.").toString("base64") });
    }
    return new Response("not found", { status: 404, statusText: "Not Found" });
  };
  try {
    const result = await repoTool.execute({ url: "https://github.com/Fixture/repo-tool" });
    assert.match(result, /Repository: Fixture\/repo-tool/);
    assert.match(result, /file  src\/index\.ts/);
    assert.match(result, /README:\n# Fixture/);
    assert.doesNotMatch(result, /^Error:/);
  } finally {
    global.fetch = originalFetch;
  }
});

test("repo tool reads a requested source file without cloning", async () => {
  const originalFetch = global.fetch;
  global.fetch = async value => {
    const url = String(value);
    if (url === "https://api.github.com/repos/Fixture/file-tool") {
      return Response.json({ default_branch: "main" });
    }
    if (url.includes("/contents/src/index.ts?ref=main")) {
      const source = "export const pairing = true;\n";
      return Response.json({
        type: "file", path: "src/index.ts", size: Buffer.byteLength(source),
        encoding: "base64", content: Buffer.from(source).toString("base64"),
      });
    }
    return new Response("not found", { status: 404, statusText: "Not Found" });
  };
  try {
    const result = await repoTool.execute({
      url: "https://github.com/Fixture/file-tool",
      path: "src/index.ts",
    });
    assert.match(result, /File: src\/index\.ts/);
    assert.match(result, /export const pairing = true/);
  } finally {
    global.fetch = originalFetch;
  }
});
