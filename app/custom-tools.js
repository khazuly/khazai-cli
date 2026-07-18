import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, extname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { z } from "zod";

const TOOL_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const cacheDirectory = join(homedir(), ".cache", "khazai-ai", "tools");

function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}

function directories(workspace, type) {
  const singular = type === "plugins" ? "plugin" : "tool";
  return [
    join(homedir(), ".config", "opencode", type),
    join(homedir(), ".config", "opencode", singular),
    join(homedir(), ".config", "khazai-ai", type),
    join(homedir(), ".config", "khazai-ai", singular),
    join(workspace, ".opencode", type),
    join(workspace, ".opencode", singular),
    join(workspace, ".khazai", type),
    join(workspace, ".khazai", singular),
  ];
}

function moduleFiles(workspace, type) {
  const files = [];
  for (const directory of directories(workspace, type)) {
    if (!existsSync(directory)) continue;
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isFile() || entry.isSymbolicLink() || !/\.(?:js|mjs|ts|mts)$/i.test(entry.name)) continue;
      files.push(join(directory, entry.name));
    }
  }
  return files;
}

async function compiledUrl(path) {
  const info = statSync(path);
  if (/\.mjs$/i.test(path)) {
    return `${pathToFileURL(path).href}?v=${info.mtimeMs}`;
  }
  mkdirSync(cacheDirectory, { recursive: true, mode: 0o700 });
  const output = join(cacheDirectory, `${hash(`${path}:${info.size}:${info.mtimeMs}:node${process.versions.node}`).slice(0, 32)}.mjs`);
  if (!existsSync(output)) {
    await build({
      entryPoints: [path],
      outfile: output,
      bundle: true,
      format: "esm",
      platform: "node",
      target: "node18",
      sourcemap: "inline",
      plugins: [{
        name: "khazai-opencode-tool-shim",
        setup(builder) {
          builder.onResolve({ filter: /^@opencode-ai\/plugin$/ }, () => ({
            path: "khazai:opencode-plugin",
            namespace: "khazai",
          }));
          builder.onLoad({ filter: /.*/, namespace: "khazai" }, () => ({
            loader: "js",
            contents: "import { z } from 'zod'; export const tool = Object.assign((value) => value, { schema: z });",
            resolveDir: process.cwd(),
          }));
        },
      }],
    });
    chmodSync(output, 0o600);
  }
  return pathToFileURL(output).href;
}

function jsonSchema(parameters) {
  if (!parameters) return { type: "object", properties: {} };
  if (parameters.type === "object") return parameters;
  if (typeof parameters.safeParse === "function") {
    try { return z.toJSONSchema(parameters); } catch {}
  }
  if (typeof parameters === "object" && !Array.isArray(parameters)) {
    try { return z.toJSONSchema(z.object(parameters)); } catch {}
  }
  return { type: "object", properties: {} };
}

function validator(parameters) {
  if (typeof parameters?.safeParse === "function") return value => parameters.safeParse(value);
  if (parameters && typeof parameters === "object" && !Array.isArray(parameters) && !parameters.type) {
    try {
      const schema = z.object(parameters);
      return value => schema.safeParse(value);
    } catch {}
  }
  return null;
}

function toolDefinition(id, value, source) {
  if (!TOOL_NAME.test(id) || !value || typeof value !== "object" || typeof value.execute !== "function") return null;
  const rawParameters = value.parameters || value.args;
  return {
    name: id,
    id,
    description: String(value.description || ""),
    parameters: jsonSchema(rawParameters),
    validate: validator(rawParameters),
    source,
    async execute(args, context) {
      const result = await value.execute(args, context);
      return result;
    },
  };
}

function moduleEntries(mod, path) {
  const fallback = basename(path, extname(path));
  const candidates = [];
  for (const [name, value] of Object.entries(mod)) {
    if (name === "default" && value && typeof value === "object" && typeof value.execute !== "function") {
      for (const [nestedName, nested] of Object.entries(value.tools || value.tool || {})) {
        candidates.push([nestedName, nested]);
      }
      continue;
    }
    if (name === "hooks" || name === "plugin") continue;
    candidates.push([name === "default" ? fallback : `${fallback}_${name}`, value]);
  }
  return candidates;
}

export async function discoverRuntimeExtensions(workspace) {
  const tools = [];
  const hooks = [];
  const errors = [];
  for (const path of moduleFiles(resolve(workspace), "tools")) {
    try {
      const mod = await import(await compiledUrl(path));
      for (const [id, value] of moduleEntries(mod, path)) {
        const definition = toolDefinition(id, value, path);
        if (definition) tools.push(definition);
      }
    } catch (error) {
      errors.push({ path, error: error?.message || String(error) });
    }
  }
  for (const path of moduleFiles(resolve(workspace), "plugins")) {
    try {
      const mod = await import(await compiledUrl(path));
      const plugin = mod.default || mod.plugin || mod;
      for (const [id, value] of Object.entries(plugin.tools || plugin.tool || {})) {
        const definition = toolDefinition(id, value, path);
        if (definition) tools.push(definition);
      }
      for (const [event, handler] of Object.entries(plugin.hooks || mod.hooks || {})) {
        if (typeof handler === "function") hooks.push({ event, handler, path });
        else if (Array.isArray(handler)) {
          for (const item of handler) if (typeof item === "function") hooks.push({ event, handler: item, path });
        }
      }
    } catch (error) {
      errors.push({ path, error: error?.message || String(error) });
    }
  }
  return { tools, hooks, errors };
}
