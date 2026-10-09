'use strict';

/**
 * A guard against committing credentials. It flags:
 * - an env file (.env, .env.local, prod.env, ...; .env.example and other
 *   *.example / *.sample / *.template files are fine);
 * - a credential variable set to a real-looking value (BROKER_API_KEY=...,
 *   "BROKER_API_KEY": "...", *_USERNAME / API_KEY / SECRET / TOKEN / PASSWORD names),
 *   unless the value is an obvious placeholder (your-..., <...>, ${...},
 *   changeme, xxx, empty);
 * - a private key block.
 *
 * A line with `check-secrets: allow` is skipped: for a test's fake values, so
 * the exception is visible in review.
 *
 * Used by scripts/check-secrets.js (CI, and the optional git pre-commit hook).
 */

const path = require('path');

const ENV_FILE = /(^|\/)(\.env(\.[^/]+)?|[^/]+\.env)$/;
const TEMPLATE = /\.(example|sample|template|dist)$/;
const CRED_NAME = /([A-Z0-9]+_USERNAME|[A-Z0-9_]*(API_KEY|SECRET|TOKEN|PASSWORD|PASSWD))/;
// NAME=value, NAME: value, "NAME": "value" (quotes optional).
const ASSIGN = new RegExp(`["']?\\b${CRED_NAME.source}\\b["']?\\s*[:=]\\s*["']?([^"'\\s,}#]*)`, 'g');
const PLACEHOLDER = /^(|your[-_].*|<.*>|\$\{?[A-Za-z_][A-Za-z0-9_]*\}?|changeme|change-me|xxx+|\.\.\.|none|null|false|true|test|u|k|redacted|\*+|example.*|dummy.*|fake.*|placeholder.*)$/i;
const PRIVATE_KEY = /-----BEGIN [A-Z ]*PRIVATE KEY-----/;
const ALLOW = 'check-secrets: allow';

/** Is this path an env file that must never be committed? */
function isEnvFile(file) {
  const f = String(file).replace(/\\/g, '/');
  return ENV_FILE.test(f) && !TEMPLATE.test(f);
}

/** Findings in one file's text: [{ line, reason }]. Tests and docs are scanned too, placeholders aside. */
function scanText(text) {
  const out = [];
  String(text).split(/\r?\n/).forEach((line, i) => {
    // A fake value in a test says so on its line (visible in review).
    if (line.includes(ALLOW)) return;
    if (PRIVATE_KEY.test(line)) out.push({ line: i + 1, reason: 'a private key' });
    ASSIGN.lastIndex = 0;
    let m;
    while ((m = ASSIGN.exec(line))) {
      const name = m[1];
      const value = m[m.length - 1];
      if (!PLACEHOLDER.test(value) && value.length >= 8 && !/^(process\.env|env\.|cfg\.|opts\.)/.test(value)) {
        out.push({ line: i + 1, reason: `${name} set to a value (${value.slice(0, 2)}…${value.length} chars)` });
      }
    }
  });
  return out;
}

/** Findings for a set of files: [{ file, line?, reason }]. `read(file)` returns its text or null (binary, deleted). */
function scanFiles(files, read) {
  const findings = [];
  for (const file of files) {
    if (isEnvFile(file)) {
      findings.push({ file, reason: 'an env file (keep credentials in ~/.futures-trading-harness/.env; commit only .env.example)' });
      continue;
    }
    if (/\.(png|jpg|jpeg|gif|ico|pdf|zip|gz|tgz|parquet|xlsx|pkl|pt|zip)$/i.test(path.extname(file)) || /(^|\/)package-lock\.json$/.test(file)) continue;
    const text = read(file);
    if (text === null || text === undefined || text.includes('\u0000')) continue;
    for (const f of scanText(text)) findings.push({ file, ...f });
  }
  return findings;
}

module.exports = { isEnvFile, scanText, scanFiles };
