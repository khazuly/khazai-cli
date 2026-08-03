import { randomUUID } from "node:crypto";
import { createAssistantTextGuard, sanitizeAssistantIdentity } from "./assistant-text.js";
import { validateToolSchemas, classifyProviderFailure } from "./provider-reliability.js";
import {
  canonicalToolText,
  createStreamNormalizer,
  translateLegacyEvent,
} from "./stream-normalizer.js";
import { countTokens } from "./tokens.js";
import { proseLooksIncomplete } from "./interactive-text.js";
const MESSAGE_FIELD_WHITELIST = ["role", "content", "name", "tool_call_id", "tool_calls"];
const toolSchemaCache = new WeakMap();
const messageConversionCache = new WeakMap();
const cleanMessageCache = new WeakMap();
function cleanMessage(message) {
  const cached = cleanMessageCache.get(message);
  if (cached) return cached;
  const output = {};
  for (const key of MESSAGE_FIELD_WHITELIST) {
    if (message[key] !== undefined) output[key] = message[key];
  }
  if (Array.isArray(output.tool_calls)) {
    output.tool_calls = output.tool_calls
      .filter(call => call && typeof call === "object")
      .map(call => ({
        id: String(call.id || `call_${randomUUID()}`),
        type: "function",
        function: {
          name: String(call.function?.name || call.name || ""),
          arguments: String(call.function?.arguments ?? call.arguments ?? "{}"),
        },
      }))
      .filter(call => call.function.name);
  }
  cleanMessageCache.set(message, output);
  return output;
}
function parsedSyntheticCalls(content) {
  try {
    const parsed = JSON.parse(String(content || ""));
    const list = Array.isArray(parsed) ? parsed : [parsed];
    if (!list.length || !list.every(item => item && typeof item.tool === "string" && item.args && typeof item.args === "object")) {
      return null;
    }
    return list.map(item => {
      const args = Object.fromEntries(Object.entries(item.args).filter(([key]) => !key.startsWith("_")));
      return {
        id: String(item.id || `call_${randomUUID()}`),
        type: "function",
        function: { name: item.tool, arguments: JSON.stringify(args) },
      };
    });
  } catch {
    return null;
  }
}

function isToolLikeFragment(text) {
  const source = String(text || "");
  if (!source.trim()) return false;
  if (source.trim() === "{}" || source.trim() === "[]") return true;
  try { JSON.parse(source); return false; } catch {}
  const toolLike = /["']tool["']\s*:/.test(source)
    || /["'](?:tool_calls|function_calls|tool_use)["']\s*:/.test(source)
    || /<\s*(?:invoke|tool_call|function_call)\b/i.test(source);
  return toolLike && (proseLooksIncomplete(source) || /[\[{]\s*$/.test(source.trimEnd()));
}

function sanitizeToolJsonSchema(schema, compatibility = {}) {
  const allowed = new Set([
    "type", "properties", "required", "items", "enum", "description", "title",
    "minimum", "maximum", "minItems", "maxItems", "pattern", "format",
    "minLength", "maxLength", "uniqueItems", "oneOf", "anyOf", "allOf",
    "not", "const", "default", "examples", "additionalProperties",
    ...(Array.isArray(compatibility.schemaKeywords) ? compatibility.schemaKeywords : []),
  ]);
  for (const keyword of compatibility.stripSchemaKeywords || []) allowed.delete(keyword);
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return schema;
  const output = {};
  for (const [key, value] of Object.entries(schema)) {
    if (!allowed.has(key)) continue;
    if (key === "properties" && value && typeof value === "object") {
      output.properties = {};
      for (const [name, property] of Object.entries(value)) {
        output.properties[name] = sanitizeToolJsonSchema(property, compatibility);
      }
    } else if ((key === "items" || key === "additionalProperties") && value && typeof value === "object") {
      output[key] = sanitizeToolJsonSchema(value, compatibility);
    } else if (["oneOf", "anyOf", "allOf"].includes(key) && Array.isArray(value)) {
      output[key] = value.map(entry => sanitizeToolJsonSchema(entry, compatibility));
    } else {
      output[key] = value;
    }
  }
  return output;
}

export function normalizeMessages(messages, capabilities = {}, compatibility = {}) {
  const cacheKey = JSON.stringify({ roles: capabilities.supportedRoles || null, compatibility });
  const cached = messageConversionCache.get(messages)?.get(cacheKey);
  if (cached) return cached;
  const output = [];
  const pendingCallIds = new Set();
  const resolvedCallIds = new Set();
  const emittedResults = new Set();
  const supported = Array.isArray(capabilities.supportedRoles)
    ? capabilities.supportedRoles
    : ["system", "user", "assistant", "tool"];

  const emitToolResult = (toolCallId, name, content) => {
    if (!toolCallId || emittedResults.has(toolCallId)) return false;
    emittedResults.add(toolCallId);
    output.push({ role: "tool", tool_call_id: toolCallId, name: name || "", content: String(content ?? "") });
    return true;
  };

  const rememberCalls = calls => {
    for (const call of calls) {
      if (call.id) pendingCallIds.add(call.id);
    }
  };

  const legacyResultCounts = new Array(messages.length).fill(0);
  let legacyResults = 0;
  for (let index = messages.length - 1; index >= 0; index--) {
    const candidate = messages[index];
    if (candidate?.role === "user" && /^---TOOL (?:RESULT|ERROR):/i.test(String(candidate.content || ""))) legacyResults++;
    legacyResultCounts[index] = legacyResults;
    if (candidate?.role === "assistant") legacyResults = 0;
  }
  for (let index = 0; index < messages.length; index++) {
    const raw = messages[index];
    if (!raw || typeof raw !== "object") continue;
    const message = cleanMessage(raw);
    if (!supported.includes(message.role)) continue;
    if (message.role === "tool") {
      const id = String(message.tool_call_id || "");
      if (!pendingCallIds.has(id)) continue;
      if (emittedResults.has(id)) continue;
      emitToolResult(id, message.name, message.content);
      resolvedCallIds.add(id);
      continue;
    }
    if (message.role === "assistant") {
      if (Array.isArray(message.tool_calls) && message.tool_calls.length) {
        const calls = message.tool_calls.filter(call => {
          if (!call.id || resolvedCallIds.has(call.id)) return false;
          try {
            JSON.parse(call.function.arguments || "{}");
            return true;
          } catch {
            return false;
          }
        });
        if (!calls.length && !message.content) continue;
        const assistant = {
          role: "assistant",
          content: message.content ?? null,
          ...(calls.length ? { tool_calls: calls } : {}),
        };
        if (calls.length) rememberCalls(calls);
        output.push(assistant);
        continue;
      }
      const synthetic = parsedSyntheticCalls(message.content);
      if (synthetic) {
        const results = legacyResultCounts[index];
        if (results >= synthetic.length) {
          rememberCalls(synthetic);
          output.push({ role: "assistant", content: null, tool_calls: synthetic });
          continue;
        }
      }
      if (isToolLikeFragment(message.content)) continue;
      if (!message.content && !message.tool_calls?.length) continue;
      output.push({ role: "assistant", content: String(message.content ?? "") });
      continue;
    }
    if (message.role === "user") {
      const result = /^---TOOL (RESULT|ERROR):\s*(.+?)---\n?([\s\S]*)$/i.exec(String(message.content || ""));
      if (result) {
        const id = [...pendingCallIds].find(callId => !resolvedCallIds.has(callId));
        if (!id) continue;
        emitToolResult(id, result[2].trim(), result[3]);
        resolvedCallIds.add(id);
        continue;
      }
      output.push({ role: "user", content: String(message.content ?? "") });
      continue;
    }
    output.push({ role: message.role, content: String(message.content ?? "") });
  }
  if (messages && typeof messages === "object") {
    const entries = messageConversionCache.get(messages) || new Map();
    entries.set(cacheKey, output);
    messageConversionCache.set(messages, entries);
  }
  return output;
}

export function normalizeTools(tools, capabilities = {}, compatibility = {}) {
  const cacheKey = JSON.stringify({
    tools: capabilities.supportsToolCalling !== false,
    compatibility,
  });
  const cached = toolSchemaCache.get(tools)?.get(cacheKey);
  if (cached) return cached;
  const validated = validateToolSchemas(tools);
  if (validated.length > 0 && capabilities.supportsToolCalling === false) {
    const error = new Error("The resolved model route does not support tool calling.");
    error.code = "UNSUPPORTED_TOOLS";
    error.failureClass = "unhealthy_tool_route";
    throw error;
  }
  if (capabilities.supportsToolCalling === false) return [];
  const normalized = validated.map(tool => ({
    type: "function",
    function: {
      name: tool.function.name,
      description: String(tool.function.description || ""),
      parameters: sanitizeToolJsonSchema(tool.function.parameters, compatibility),
    },
  }));
  if (tools && typeof tools === "object") {
    const entries = toolSchemaCache.get(tools) || new Map();
    entries.set(cacheKey, normalized);
    toolSchemaCache.set(tools, entries);
  }
  return normalized;
}

export function filterRequestOptions(options = {}, capabilities = {}) {
  const output = { ...options };
  if (options.temperature !== undefined && capabilities.supportsTemperature === false) {
    delete output.temperature;
  }
  if (options.topP !== undefined && capabilities.supportsTopP === false) {
    delete output.topP;
  }
  if (options.maxTokens !== undefined && capabilities.supportsMaxTokens === false) {
    delete output.maxTokens;
  }
  if (options.reasoningEffort !== undefined && capabilities.supportsReasoningEffort === false) {
    delete output.reasoningEffort;
  }
  if (options.responseFormat !== undefined && capabilities.supportsResponseFormat === false) {
    delete output.responseFormat;
  }
  if (options.includeUsage === true && capabilities.supportsStreamOptions === false) {
    delete output.includeUsage;
  }
  if (options.parallelToolCalls !== undefined && capabilities.supportsParallelTools !== true) {
    delete output.parallelToolCalls;
  }
  if (options.toolChoice !== undefined && capabilities.supportsToolChoice === false) {
    delete output.toolChoice;
  }
  return output;
}

export function buildChatRequestBody({
  model,
  messages,
  tools = [],
  options = {},
  capabilities = {},
  compatibility = {},
}) {
  const body = {
    model,
    messages,
    stream: capabilities.supportsStreaming !== false,
    ...(options.includeUsage === true && capabilities.supportsStreamOptions !== false
      ? { stream_options: { include_usage: true } }
      : {}),
    ...(Number.isFinite(options.maxTokens) && capabilities.supportsMaxTokens !== false
      ? { max_tokens: options.maxTokens }
      : {}),
    ...(options.temperature !== undefined && capabilities.supportsTemperature !== false
      ? { temperature: options.temperature }
      : {}),
    ...(options.topP !== undefined && capabilities.supportsTopP !== false ? { top_p: options.topP } : {}),
    ...(options.reasoningEffort !== undefined && capabilities.supportsReasoningEffort !== false
      ? { reasoning_effort: options.reasoningEffort }
      : {}),
    ...(options.responseFormat !== undefined && capabilities.supportsResponseFormat !== false
      ? { response_format: options.responseFormat }
      : {}),
    ...(tools.length ? {
      tools,
      ...(options.toolChoice && capabilities.supportsToolChoice !== false
        ? { tool_choice: options.toolChoice }
        : {}),
      ...(options.parallelToolCalls !== undefined && capabilities.supportsParallelTools
        ? { parallel_tool_calls: Boolean(options.parallelToolCalls) }
        : {}),
    } : {}),
    ...(compatibility.requestBody || {}),
  };
  return body;
}

function parseSseEvent(event) {
  const payload = event
    .split("\n")
    .filter(line => line.startsWith("data:"))
    .map(line => line.slice(5).trimStart())
    .join("\n");
  if (!payload || payload === "[DONE]") return { done: payload === "[DONE]", data: null };
  try {
    return { done: false, data: JSON.parse(payload) };
  } catch {
    return { done: false, data: null };
  }
}

async function readSse(body, onChunk, onFirstChunk) {
  const decoder = new TextDecoder();
  let buffer = "";
  let completed = false;
  let firstChunk = true;
  for await (const chunk of body) {
    if (firstChunk) {
      firstChunk = false;
      onFirstChunk?.();
    }
    buffer += decoder.decode(chunk, { stream: true });
    buffer = buffer.replace(/\r\n/g, "\n");
    let boundary;
    while ((boundary = buffer.indexOf("\n\n")) !== -1) {
      const event = parseSseEvent(buffer.slice(0, boundary));
      buffer = buffer.slice(boundary + 2);
      if (event.data) {
        onChunk(event.data);
        if (event.data.choices?.some?.(choice => choice.finish_reason)) completed = true;
      }
      if (event.done) {
        completed = true;
        break;
      }
    }
    if (completed) break;
  }
  buffer += decoder.decode();
  if (!completed && buffer.trim()) {
    const event = parseSseEvent(buffer.replace(/\r\n/g, "\n"));
    if (event.data) {
      onChunk(event.data);
      if (event.data.choices?.some?.(choice => choice.finish_reason)) completed = true;
    }
    if (event.done) completed = true;
  }
  return completed;
}

function stripThinking(text) {
  return String(text || "")
    .replace(/<think>[\s\S]*?<\/think>\s*/gi, "")
    .replace(/<think>[\s\S]*$/gi, "");
}

export function normalizeUsage(payload, model) {
  return {
    inputTokens: payload?.prompt_tokens ?? payload?.input_tokens ?? null,
    outputTokens: payload?.completion_tokens ?? payload?.output_tokens ?? null,
    model: payload?.model || model || null,
    contextLimit: payload?.context_limit ?? payload?.context_window ?? null,
  };
}

export function classifyError(error, context = {}) {
  if (!error.failureClass) {
    error.failureClass = classifyProviderFailure(error, {
      toolCount: context.toolCount || 0,
      plainRouteHealthy: Boolean(context.plainRouteHealthy),
    });
  }
  return error.failureClass;
}

export async function parseOpenAIStream(response, {
  onEvent,
  onToken,
  model,
  requestId = "",
  runId = "",
  includeUsage = false,
  normalizeChunk = chunk => chunk,
} = {}) {
  const normalizer = createStreamNormalizer({ requestId, runId });
  const guard = createAssistantTextGuard(text => sanitizeAssistantIdentity(stripThinking(text)));
  let raw = "";
  let streamError = null;

  const emitLegacy = event => {
    const legacy = translateLegacyEvent(event);
    if (!legacy) return;
    if (legacy.type === "text-delta") {
      raw += legacy.text;
      const safe = guard.push(legacy.text);
      if (safe) {
        if (onEvent) onEvent({ type: "text-delta", text: safe });
        else onToken?.(safe);
      }
      return;
    }
    if (legacy.type === "usage") {
      if (includeUsage) onEvent?.(legacy);
      return;
    }
    onEvent?.(legacy);
  };

  let completed = false;
  try {
    completed = await readSse(
      response.body,
      chunk => {
        for (const event of normalizer.handleChunk(normalizeChunk(chunk))) emitLegacy(event);
      },
      () => onEvent?.({ type: "first-byte" }),
    );
  } catch (error) {
    streamError = error;
    streamError.code ||= "PREMATURE_STREAM";
    streamError.streamPhase ||= "stream";
  }

  const calls = normalizer.toolCalls();
  if (streamError) {
    for (const event of normalizer.fail(streamError)) emitLegacy(event);
    throw streamError;
  }
  if (calls.length > 0) {
    const completed = guard.finish(raw);
    if (completed.output) {
      if (onEvent) onEvent({ type: "text-delta", text: completed.output });
      else onToken?.(completed.output);
    }
    for (const event of normalizer.complete({ reason: "tool-calls" })) emitLegacy(event);
    return { text: canonicalToolText(calls), reason: "tool-calls" };
  }
  if (!completed) {
    const error = new Error("Provider stream ended before completion.");
    error.code = "PREMATURE_STREAM";
    error.streamPhase = "stream";
    streamError = error;
    for (const event of normalizer.fail(streamError)) emitLegacy(event);
    throw streamError;
  }
  const completedText = guard.finish(raw);
  if (completedText.output) {
    if (onEvent) onEvent({ type: "text-delta", text: completedText.output });
    else onToken?.(completedText.output);
  }
  for (const event of normalizer.complete({ reason: "stop", output: completedText.output })) emitLegacy(event);
  return { text: completedText.text.trim(), reason: "stop" };
}

export function estimateNormalizedMessages(messages, capabilities = {}, compatibility = {}) {
  try {
    return countTokens(JSON.stringify(normalizeMessages(messages, capabilities, compatibility)));
  } catch {
    return countTokens(JSON.stringify(messages || []));
  }
}

export function createOpenAICompatibleAdapter({
  id,
  baseURL,
  apiKey = "",
  headers = {},
  rotateSessionAffinity = false,
  compatibility = {},
} = {}) {
  const endpoint = String(baseURL || "").replace(/\/+$/, "");
  const chatURL = () => (/\/chat\/completions$/i.test(endpoint) ? endpoint : `${endpoint}/chat/completions`);
  return {
    adapterId: "openai-compatible",
    id,
    baseURL: endpoint,
    compatibility,
    chatURL,
    normalizeMessages: (messages, capabilities) => normalizeMessages(messages, capabilities, compatibility),
    normalizeTools: (tools, capabilities) => normalizeTools(tools, capabilities, compatibility),
    buildRequest: payload => buildChatRequestBody({ ...payload, compatibility }),
    normalizeResponseMessage: message => message,
    parseStream: (response, callbacks, options = {}) => parseOpenAIStream(response, { ...callbacks, ...options }),
    normalizeUsage,
    classifyError,
    canonicalToolText,
    estimate: (messages, capabilities) => estimateNormalizedMessages(messages, capabilities, compatibility),
  };
}

export { sanitizeToolJsonSchema, isToolLikeFragment, cleanMessage, canonicalToolText };
