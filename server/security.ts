import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';

/** Only browser clients on this exact local origin may read the API. */
export function installSecurity(app: FastifyInstance, options: { port: number; production: boolean }): { csrfToken: string } {
  const { port, production } = options;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid local server port');
  const csrfToken = randomBytes(32).toString('base64url');
  const csrfBytes = Buffer.from(csrfToken);
  const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  const mutationWindows = new Map<string, { start: number; count: number }>();
  let lastPrune = Date.now();
  const csp = [
    "default-src 'none'",
    `script-src 'self'${production ? '' : " 'unsafe-inline'"}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    `connect-src 'self'${production ? '' : ` ws://127.0.0.1:${port} ws://localhost:${port}`}`,
    "base-uri 'none'", "object-src 'none'", "form-action 'self'", "frame-ancestors 'none'",
  ].join('; ');

  app.addHook('onRequest', async (request, reply) => {
    const header = (name: string, value: string) => {
      reply.header(name, value);
      // SSE and Vite intentionally hijack the response. Fastify's pending
      // reply headers are not flushed on that path, so set the raw header too.
      reply.raw.setHeader(name, value);
    };
    header('Content-Security-Policy', csp);
    header('X-Content-Type-Options', 'nosniff');
    header('X-Frame-Options', 'DENY');
    header('Referrer-Policy', 'no-referrer');
    header('Cross-Origin-Resource-Policy', 'same-origin');
    header('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
    // Do not use request.hostname: a proxy configuration must never make an
    // attacker-controlled X-Forwarded-Host bypass the loopback Host check.
    const host = request.headers.host;
    if (typeof host !== 'string' || !allowedHosts.has(host)) {
      return reply.code(403).send({ error: '仅允许通过本机地址访问。' });
    }

    // Fastify decodes unreserved escapes before route matching. Classify the
    // matched route, not the raw URL (/%61pi/groups is still an API mutation).
    const path = request.routeOptions.url ?? (request.raw.url ?? '').split('?')[0];
    const isApi = path === '/api' || path.startsWith('/api/');
    if (!isApi) return;
    header('Cache-Control', 'no-store');

    const origin = request.headers.origin;
    if ((origin !== undefined && origin !== `http://${host}`) || request.headers['sec-fetch-site'] === 'cross-site') {
      return reply.code(403).send({ error: '拒绝跨来源的 API 请求。' });
    }
    // No Access-Control-Allow-Origin header is emitted. A local service is not
    // public just because it does not need a sign-in screen.
    if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method)) return;

    const supplied = request.headers['x-csrf-token'];
    const suppliedBytes = typeof supplied === 'string' ? Buffer.from(supplied) : Buffer.alloc(0);
    if (suppliedBytes.length !== csrfBytes.length || !timingSafeEqual(suppliedBytes, csrfBytes)) {
      return reply.code(403).send({ error: '请求令牌失效，请刷新页面后重试。' });
    }

    const now = Date.now();
    if (now - lastPrune >= 60_000) {
      for (const [key, value] of mutationWindows) if (now - value.start >= 60_000) mutationWindows.delete(key);
      lastPrune = now;
    }
    const key = request.ip;
    let window = mutationWindows.get(key);
    if (!window || now - window.start >= 60_000) {
      // Bound memory even if this code is inadvertently used with proxy trust.
      if (mutationWindows.size >= 4096 && !mutationWindows.has(key)) {
        return reply.header('Retry-After', '60').code(429).send({ error: '请求过于频繁，请稍后重试。' });
      }
      window = { start: now, count: 0 };
      mutationWindows.set(key, window);
    }
    window.count += 1;
    if (window.count > 120) {
      return reply.header('Retry-After', String(Math.max(1, Math.ceil((60_000 - now + window.start) / 1000))))
        .code(429).send({ error: '请求过于频繁，请稍后重试。' });
    }
  });
  return { csrfToken };
}
