import { randomUUID } from "node:crypto";
import { redactSecrets } from "./secrets.js";

const HEALTH_COOLDOWN_MS = 60_000;
const FAILURE_THRESHOLD = 3;
const routes = new Map();

function routeKey(provider, model, endpoint = "") {
  return `${provider || "unknown"}:${model || "unknown"}:${endpoint || "default"}`;
}

function routeState(provider, model, endpoint) {
  const key = routeKey(provider, model, endpoint);
  if (!routes.has(key)) {
    routes.set(key, {
      consecutiveFailures: 0,
      unhealthyUntil: 0,
      plainSuccessAt: 0,
      toolSuccessAt: 0,
      toolIncompatibleUntil: 0,
    });
  }
  return routes.get(key);
}

function providerMessage(error) {
  return `${error?.providerDetail || ""}\n${error?.message || error || ""}`;
}

export function classifyProviderFailure(error, { toolCount = 0, plainRouteHealthy = false } = {}) {
  const status = Number(error?.status)
    || Number(/^HTTP\s+(\d{3})/i.exec(String(error?.message || error))?.[1]);
  const code = String(error?.code || error?.cause?.code || "").toUpperCase();
  const detail = providerMessage(error);
  if (
    code === "INVALID_TOOL_SCHEMA"
    || /invalid\s+(?:tool|function)\s+schema|tools?\.\d+|function\.parameters/i.test(detail)
  ) return "invalid_tool_schema";
  if (
    /unsupported|unknown|unrecognized|not\s+allowed|extra\s+field|unexpected\s+parameter/i.test(detail)
    && /parameter|field|temperature|top_p|max_tokens|stream_options|tool_choice|parallel/i.test(detail)
  ) return "unsupported_parameter";
  if (
    status === 400
    || /malformed\s+(?:request|payload)|invalid_request|invalid\s+messages?|json\s+(?:parse|decode)/i.test(detail)
  ) return "malformed_payload";
  if (/model.+(?:unsupported|unavailable|not found)|unsupported.+model/i.test(detail)) {
    return "unhealthy_model_route";
  }
  if (
    code === "PREMATURE_STREAM"
    || /premature stream|stream ended before completion|terminated unexpectedly/i.test(detail)
  ) return "premature_stream";
  if (status === 500 && toolCount > 0 && plainRouteHealthy) return "unhealthy_tool_route";
  if ([500, 502, 503, 504].includes(status)) return "provider_infrastructure";
  if (["ECONNRESET", "EPIPE", "UND_ERR_SOCKET"].includes(code)) return "provider_infrastructure";
  if (/connection reset|socket hang up/i.test(detail)) return "provider_infrastructure";
  return "provider_error";
}

export function isRetryableFailure(failureClass) {
  return ["provider_infrastructure", "premature_stream"].includes(failureClass);
}

export function isFallbackEligibleFailure(failureClass) {
  return isRetryableFailure(failureClass) || failureClass === "unhealthy_model_route";
}

export function routeAvailability(provider, model, endpoint, toolCount = 0, now = Date.now()) {
  const state = routeState(provider, model, endpoint);
  if (state.unhealthyUntil > now) {
    return { available: false, failureClass: "unhealthy_model_route", retryAt: state.unhealthyUntil };
  }
  if (toolCount > 0 && state.toolIncompatibleUntil > now) {
    return { available: false, failureClass: "unhealthy_tool_route", retryAt: state.toolIncompatibleUntil };
  }
  return { available: true };
}

export function recordRouteSuccess(provider, model, endpoint, toolCount = 0, now = Date.now()) {
  const state = routeState(provider, model, endpoint);
  state.consecutiveFailures = 0;
  state.unhealthyUntil = 0;
  if (toolCount > 0) {
    state.toolSuccessAt = now;
    state.toolIncompatibleUntil = 0;
  } else {
    state.plainSuccessAt = now;
  }
}

export function recordRouteFailure(provider, model, endpoint, failureClass, toolCount = 0, now = Date.now()) {
  const state = routeState(provider, model, endpoint);
  state.consecutiveFailures++;
  if (failureClass === "unhealthy_tool_route") {
    state.toolIncompatibleUntil = now + HEALTH_COOLDOWN_MS;
  }
  if (
    ["provider_infrastructure", "unhealthy_model_route"].includes(failureClass)
    && state.consecutiveFailures >= FAILURE_THRESHOLD
  ) {
    state.unhealthyUntil = now + HEALTH_COOLDOWN_MS;
  }
  return { ...state };
}

export function plainRouteHealthy(provider, model, endpoint) {
  return routeState(provider, model, endpoint).plainSuccessAt > 0;
}

export function validateToolSchemas(tools = []) {
  const names = new Set();
  for (const entry of tools) {
    const fn = entry?.type === "function" ? entry.function : null;
    if (
      !fn
      || typeof fn.name !== "string"
      || !/^[A-Za-z0-9_-]{1,128}$/.test(fn.name)
      || !fn.parameters
      || typeof fn.parameters !== "object"
      || Array.isArray(fn.parameters)
      || fn.parameters.type !== "object"
      || (fn.parameters.properties !== undefined
        && (!fn.parameters.properties || typeof fn.parameters.properties !== "object"
          || Array.isArray(fn.parameters.properties)))
      || (fn.parameters.required !== undefined
        && (!Array.isArray(fn.parameters.required)
          || fn.parameters.required.some(name => typeof name !== "string")))
      || names.has(fn.name)
    ) {
      const error = new Error("A tool definition contains an invalid JSON schema.");
      error.code = "INVALID_TOOL_SCHEMA";
      error.failureClass = "invalid_tool_schema";
      throw error;
    }
    names.add(fn.name);
  }
  return tools;
}

export function providerAttemptId(baseRequestId, attempt) {
  return attempt === 0 && baseRequestId ? baseRequestId : randomUUID();
}

export function providerDiagnostic(provider, options, error, attempt, failureClass, retryDelayMs = null) {
  return {
    requestId: options.requestId || error?.requestId || "",
    provider: provider.id || "unknown",
    model: options.model || "",
    endpoint: error?.endpoint || provider.chatURL?.() || "",
    attempt,
    responseStatus: Number(error?.status) || null,
    redactedResponseBody: redactSecrets(String(error?.providerDetail || "")).slice(0, 1_000),
    messageCount: Number(error?.messageCount) || 0,
    toolCount: Number(error?.toolCount ?? options.tools?.length) || 0,
    streaming: error?.streaming !== false,
    failureClass,
    payloadFields: Array.isArray(error?.payloadFields) ? error.payloadFields : [],
    retryDelayMs,
    runId: options.runId || "",
    turnId: options.turnId || "",
    taskEpoch: options.taskEpoch ?? null,
  };
}

export function debugProviderDiagnostic(diagnostic) {
  if (!process.env.KHAZAI_DEBUG) return;
  console.error(`[khazai debug] provider ${JSON.stringify(diagnostic)}`);
}

export function resetProviderHealth() {
  routes.clear();
}
