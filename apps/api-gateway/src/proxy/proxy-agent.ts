import http from 'node:http';
import https from 'node:https';

export const DEFAULT_PROXY_TIMEOUT_MS = 15_000;

/**
 * Shared keep-alive HTTP/HTTPS agents prevent ephemeral socket exhaustion
 * (TIME_WAIT) when API Gateway proxies high-concurrency traffic to downstream
 * services.
 */
export const gatewayHttpAgent = new http.Agent({
  keepAlive: true,
  keepAliveMsecs: 15_000,
  maxSockets: 256,
  maxFreeSockets: 64,
});

export const gatewayHttpsAgent = new https.Agent({
  keepAlive: true,
  keepAliveMsecs: 15_000,
  maxSockets: 256,
  maxFreeSockets: 64,
});

export function resolveProxyAgent(target: string): http.Agent | https.Agent {
  return target.startsWith('https://') ? gatewayHttpsAgent : gatewayHttpAgent;
}
