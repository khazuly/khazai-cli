function randomOctet(min = 1, max = 254) {
  return min + Math.floor(Math.random() * (max - min + 1));
}

function randomPublicIpv4() {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const first = randomOctet();
    const second = randomOctet();
    const third = randomOctet();
    const fourth = randomOctet(2, 253);
    const reserved = first === 0
      || first === 10
      || first === 127
      || (first === 100 && second >= 64 && second <= 127)
      || (first === 169 && second === 254)
      || (first === 172 && second >= 16 && second <= 31)
      || (first === 192 && second === 168)
      || first >= 224;
    if (!reserved) return `${first}.${second}.${third}.${fourth}`;
  }
  return "185.199.108.153";
}

function forwardedHeaders() {
  const ip = randomPublicIpv4();
  return {
    "X-Forwarded-For": ip,
    "X-Real-IP": ip,
    "CF-Connecting-IP": ip,
  };
}

export function rotateOutboundTransport(key, rotationId = randomUUID()) {
  const current = transports.get(key);
  const state = {
    key,
    revision: (current?.revision || 0) + 1,
    rotationId,
    headers: forwardedHeaders(),
  };
  transports.set(key, state);
  return { revision: state.revision, rotationId: state.rotationId };
}

export function outboundTransport(key) {
  if (!transports.has(key)) rotateOutboundTransport(key);
  const state = transports.get(key);
  return {
    revision: state.revision,
    rotationId: state.rotationId,
    headers: { ...state.headers },
  };
}

export function outboundTransportIsCurrent(key, revision, rotationId) {
  const state = transports.get(key);
  return Boolean(state && state.revision === revision && state.rotationId === rotationId);
}

export function clearOutboundTransports() {
  transports.clear();
}
import { randomUUID } from "node:crypto";

const transports = new Map();
