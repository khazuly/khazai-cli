import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { randomBytes, webcrypto } from "node:crypto";
import { platform } from "node:os";
import { saveProviderAuth } from "./auth.js";

export const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
export const CODEX_ISSUER = "https://auth.openai.com";
export const CODEX_OAUTH_PORT = 1455;

function base64Url(value) {
  return Buffer.from(value).toString("base64url");
}

async function createPkce() {
  const verifier = base64Url(randomBytes(48));
  const digest = await webcrypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return { verifier, challenge: base64Url(digest) };
}

export function parseCodexClaims(token) {
  try {
    return JSON.parse(Buffer.from(String(token).split(".")[1], "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

export function codexAccountId(tokens) {
  for (const token of [tokens.id_token, tokens.access_token]) {
    const claims = parseCodexClaims(token);
    const accountId = claims?.chatgpt_account_id
      || claims?.["https://api.openai.com/auth"]?.chatgpt_account_id
      || claims?.organizations?.[0]?.id;
    if (accountId) return accountId;
  }
  return "";
}

function authorizeURL(redirectURI, pkce, state) {
  const query = new URLSearchParams({
    response_type: "code",
    client_id: CODEX_CLIENT_ID,
    redirect_uri: redirectURI,
    scope: "openid profile email offline_access",
    code_challenge: pkce.challenge,
    code_challenge_method: "S256",
    id_token_add_organizations: "true",
    codex_cli_simplified_flow: "true",
    state,
    originator: "opencode",
  });
  return `${CODEX_ISSUER}/oauth/authorize?${query}`;
}

async function exchangeCode(code, redirectURI, verifier) {
  const response = await fetch(`${CODEX_ISSUER}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectURI,
      client_id: CODEX_CLIENT_ID,
      code_verifier: verifier,
    }),
  });
  if (!response.ok) throw new Error(`Codex token exchange failed with HTTP ${response.status}.`);
  return response.json();
}

export async function refreshCodexAuth(auth) {
  if (!auth?.refresh) throw new Error("Codex login is required. Run: khazai-ai auth login codex");
  const response = await fetch(`${CODEX_ISSUER}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: auth.refresh,
      client_id: CODEX_CLIENT_ID,
    }),
  });
  if (!response.ok) throw new Error(`Codex token refresh failed with HTTP ${response.status}. Please sign in again.`);
  const tokens = await response.json();
  return {
    type: "oauth",
    access: tokens.access_token,
    refresh: tokens.refresh_token || auth.refresh,
    expires: Date.now() + Number(tokens.expires_in || 3600) * 1000,
    accountId: codexAccountId(tokens) || auth.accountId || "",
  };
}

function openBrowser(url) {
  const command = platform() === "darwin" ? "open" : platform() === "win32" ? "cmd" : "xdg-open";
  const args = platform() === "win32" ? ["/c", "start", "", url] : [url];
  execFile(command, args, () => {});
}

export async function loginCodex({ open = openBrowser, onAuthorize, timeoutMs = 300_000 } = {}) {
  const redirectURI = `http://localhost:${CODEX_OAUTH_PORT}/auth/callback`;
  const pkce = await createPkce();
  const state = base64Url(randomBytes(32));
  const url = authorizeURL(redirectURI, pkce, state);
  let server;
  const tokens = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Codex OAuth callback timed out.")), timeoutMs);
    server = createServer(async (request, response) => {
      const requestURL = new URL(request.url || "/", redirectURI);
      if (requestURL.pathname !== "/auth/callback") {
        response.writeHead(404).end("Not found");
        return;
      }
      const error = requestURL.searchParams.get("error");
      const code = requestURL.searchParams.get("code");
      if (error || !code || requestURL.searchParams.get("state") !== state) {
        response.writeHead(400, { "Content-Type": "text/html; charset=utf-8" }).end("Codex authorization failed. You may close this page.");
        clearTimeout(timer);
        reject(new Error(error || "Invalid Codex OAuth callback."));
        return;
      }
      try {
        const value = await exchangeCode(code, redirectURI, pkce.verifier);
        response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end("Codex connected. You may close this page.");
        clearTimeout(timer);
        resolve(value);
      } catch (caught) {
        response.writeHead(500, { "Content-Type": "text/html; charset=utf-8" }).end("Codex authorization failed. You may close this page.");
        clearTimeout(timer);
        reject(caught);
      }
    }).once("error", reject).listen(CODEX_OAUTH_PORT);
    onAuthorize?.(url);
    open(url);
  }).finally(() => server?.close());
  const auth = {
    type: "oauth",
    access: tokens.access_token,
    refresh: tokens.refresh_token,
    expires: Date.now() + Number(tokens.expires_in || 3600) * 1000,
    accountId: codexAccountId(tokens),
  };
  saveProviderAuth("codex", auth);
  return { url, auth };
}
