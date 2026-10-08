'use strict';

/**
 * HTTP front for the simulated broker: the ProjectX Gateway REST surface
 * (POST /api/..., JSON in and out, Bearer token after login), listening on
 * loopback only. projectx-mcp and the runner's REST client talk to it exactly
 * as they talk to api.topstepx.com. Credentials sent to it are ignored and
 * never logged. The market hub (quotes) is not simulated: its URL answers
 * 404, so get_quote reports no quote and the agents use bars.
 */

const http = require('http');

const MAX_BODY = 1024 * 1024;

function createSimServer(broker, { onCall = () => {} } = {}) {
  const server = http.createServer((req, res) => {
    const send = (status, body) => {
      const text = JSON.stringify(body);
      res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) });
      res.end(text);
    };
    const url = new URL(req.url, 'http://127.0.0.1');
    if (req.method !== 'POST' || !url.pathname.startsWith('/api/')) return send(404, { error: 'not found' });
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', chunk => {
      raw += chunk;
      if (raw.length > MAX_BODY) req.destroy();
    });
    req.on('end', () => {
      const isLogin = url.pathname === '/api/Auth/loginKey';
      if (!isLogin && !/^Bearer \S+/.test(String(req.headers.authorization || ''))) return send(401, { error: 'unauthorized' });
      let body;
      try {
        body = raw ? JSON.parse(raw) : {};
      } catch (_err) {
        return send(400, { error: 'invalid JSON' });
      }
      let out;
      try {
        out = broker.handle(url.pathname, body);
      } catch (err) {
        return send(500, { success: false, errorCode: 7, errorMessage: err.message });
      }
      if (out === null) return send(404, { error: `unknown endpoint ${url.pathname}` });
      onCall(url.pathname, isLogin ? {} : body, out);
      return send(200, out);
    });
    return undefined;
  });
  return {
    /** Listen on 127.0.0.1 (random port by default). Resolves the base URL. */
    listen(port = 0) {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`));
      });
    },
    close() {
      return new Promise(resolve => server.close(() => resolve()));
    },
  };
}

module.exports = { createSimServer };
