const GITHUB_API = "https://api.github.com";
const MAX_TREE_ENTRIES = 500;
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_OUTPUT_CHARS = 30000;
const MAX_README_CHARS = 12000;
const USER_AGENT = "khazai-ai repository inspector";

export function parseGitHubRepository(value) {
  try {
    const url = new URL(String(value));
    if (!/(?:^|\.)github\.com$/i.test(url.hostname)) return null;
    const segments = url.pathname.split("/").filter(Boolean);
    if (segments.length < 2) return null;
    const owner = segments[0];
    const repo = segments[1].replace(/\.git$/i, "");
    if (![owner, repo].every(part => /^[a-z0-9_.-]+$/i.test(part))) return null;
    let path = "";
    if (["blob", "tree"].includes(segments[2]) && segments.length > 4) {
      path = segments.slice(4).map(decodeURIComponent).join("/");
    }
    return { owner, repo, path };
  } catch {
    return null;
  }
}

function normalizePath(value) {
  const path = String(value || "").replace(/^\/+|\/+$/g, "");
  const segments = path.split("/").filter(Boolean);
  if (segments.some(segment => segment === "." || segment === "..")) {
    throw new Error("Repository path cannot contain . or .. segments");
  }
  return segments.join("/");
}

function githubHeaders(accept = "application/vnd.github+json") {
  return {
    Accept: accept,
    "User-Agent": USER_AGENT,
    "X-GitHub-Api-Version": "2022-11-28",
    ...(process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}),
  };
}

async function githubResponse(url, accept) {
  const response = await fetch(url, {
    headers: githubHeaders(accept),
    signal: AbortSignal.timeout(20000),
    redirect: "follow",
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    let detail = body.slice(0, 300);
    try { detail = JSON.parse(body).message || detail; } catch {}
    throw new Error(`GitHub HTTP ${response.status} ${response.statusText}${detail ? ` — ${detail}` : ""}`);
  }
  return response;
}

async function githubJson(url) {
  return (await githubResponse(url)).json();
}

function decodeContent(value) {
  return Buffer.from(String(value || "").replace(/\s+/g, ""), "base64");
}

function textFromBuffer(buffer, path) {
  if (buffer.includes(0)) throw new Error(`Repository file is binary: ${path}`);
  return buffer.toString("utf8");
}

function truncate(text) {
  const value = String(text);
  return value.length > MAX_OUTPUT_CHARS
    ? value.slice(0, MAX_OUTPUT_CHARS) + `\n\n... ${value.length - MAX_OUTPUT_CHARS} chars hidden`
    : value;
}

async function readRepositoryPath(repository, ref, path) {
  const encodedPath = path.split("/").map(encodeURIComponent).join("/");
  const url = `${GITHUB_API}/repos/${repository.owner}/${repository.repo}/contents/${encodedPath}?ref=${encodeURIComponent(ref)}`;
  const content = await githubJson(url);
  if (Array.isArray(content)) {
    const entries = content
      .slice(0, MAX_TREE_ENTRIES)
      .map(item => `${item.type === "dir" ? "dir " : "file"}  ${item.path}`);
    return [
      `Repository: ${repository.owner}/${repository.repo}`,
      `Ref: ${ref}`,
      `Directory: ${path}`,
      `Entries: ${content.length}`,
      "",
      ...entries,
      ...(content.length > entries.length ? [`... ${content.length - entries.length} entries hidden`] : []),
    ].join("\n");
  }
  if (content.type !== "file") throw new Error(`Unsupported repository object type: ${content.type || "unknown"}`);
  if (Number(content.size || 0) > MAX_FILE_BYTES) throw new Error(`Repository file exceeds ${MAX_FILE_BYTES} byte limit: ${path}`);

  let buffer;
  if (content.encoding === "base64" && content.content) {
    buffer = decodeContent(content.content);
  } else if (content.download_url) {
    const response = await githubResponse(content.download_url, "text/plain,application/octet-stream");
    buffer = Buffer.from(await response.arrayBuffer());
  } else {
    throw new Error(`GitHub did not provide content for ${path}`);
  }
  if (buffer.length > MAX_FILE_BYTES) throw new Error(`Repository file exceeds ${MAX_FILE_BYTES} byte limit: ${path}`);
  const text = textFromBuffer(buffer, path);
  return truncate([
    `Repository: ${repository.owner}/${repository.repo}`,
    `Ref: ${ref}`,
    `File: ${path}`,
    `Bytes: ${buffer.length}`,
    `Lines: ${text.split("\n").length}`,
    "",
    text,
  ].join("\n"));
}

async function inspectRepository(repository, requestedRef) {
  const base = `${GITHUB_API}/repos/${repository.owner}/${repository.repo}`;
  const metadata = await githubJson(base);
  const ref = requestedRef || metadata.default_branch || "HEAD";
  const [treeResult, readmeResult] = await Promise.allSettled([
    githubJson(`${base}/git/trees/${encodeURIComponent(ref)}?recursive=1`),
    githubJson(`${base}/readme?ref=${encodeURIComponent(ref)}`),
  ]);
  const tree = treeResult.status === "fulfilled" && Array.isArray(treeResult.value.tree)
    ? treeResult.value.tree.filter(item => ["blob", "tree"].includes(item.type))
    : [];
  const shown = tree.slice(0, MAX_TREE_ENTRIES);
  let readme = "";
  if (readmeResult.status === "fulfilled" && readmeResult.value.content) {
    const buffer = decodeContent(readmeResult.value.content);
    if (buffer.length <= MAX_FILE_BYTES) readme = textFromBuffer(buffer, readmeResult.value.path || "README.md");
  }
  const readmePreview = readme.length > MAX_README_CHARS
    ? readme.slice(0, MAX_README_CHARS) + `\n\n... ${readme.length - MAX_README_CHARS} README chars hidden`
    : readme;

  const lines = [
    `Repository: ${metadata.full_name || `${repository.owner}/${repository.repo}`}`,
    `Description: ${metadata.description || "No description"}`,
    `Default branch: ${metadata.default_branch || ref}`,
    `Ref: ${ref}`,
    ...(metadata.language ? [`Language: ${metadata.language}`] : []),
    ...(metadata.license?.spdx_id ? [`License: ${metadata.license.spdx_id}`] : []),
    `Stars: ${metadata.stargazers_count ?? 0}`,
    `Updated: ${metadata.updated_at || "unknown"}`,
    `Files: ${tree.filter(item => item.type === "blob").length}`,
    "",
    readmePreview ? "README:" : "README: unavailable",
    ...(readmePreview ? [readmePreview] : []),
    ...(readmeResult.status === "rejected" ? [`README error: ${readmeResult.reason.message}`] : []),
    "",
    `Tree (${tree.length} entries, showing ${shown.length}):`,
    ...shown.map(item => `${item.type === "tree" ? "dir " : "file"}  ${item.path}`),
    ...(tree.length > shown.length ? [`... ${tree.length - shown.length} entries hidden`] : []),
    ...(treeResult.status === "rejected" ? ["", `Tree unavailable: ${treeResult.reason.message}`] : []),
  ];
  return truncate(lines.join("\n"));
}

export const repoTool = {
  name: "repo",
  description: "Inspect a public GitHub repository without cloning into the workspace. Returns repository metadata, README, recursive file tree, directory entries, or a requested file's content.",
  parameters: {
    type: "object",
    properties: {
      url: { type: "string", description: "GitHub repository URL" },
      path: { type: "string", description: "Optional repository-relative file or directory path" },
      ref: { type: "string", description: "Optional branch, tag, or commit; defaults to the repository default branch" },
    },
    required: ["url"],
  },
  async execute({ url, path = "", ref = "" }) {
    try {
      const repository = parseGitHubRepository(url);
      if (!repository) return "Error: repo supports public github.com repository URLs only";
      const requestedPath = normalizePath(path || repository.path);
      let resolvedRef = String(ref || "").trim();
      if (requestedPath && !resolvedRef) {
        const metadata = await githubJson(`${GITHUB_API}/repos/${repository.owner}/${repository.repo}`);
        resolvedRef = metadata.default_branch || "HEAD";
      }
      return requestedPath
        ? await readRepositoryPath(repository, resolvedRef || "HEAD", requestedPath)
        : await inspectRepository(repository, resolvedRef);
    } catch (error) {
      if (error.name === "TimeoutError") return "Error: GitHub request timed out after 20s";
      return `Error: ${error.message}`;
    }
  },
};
