'use strict';

/*
 * Starts a test call on a running server. No real phone call is made.
 *
 *   node simulate.js            (first busy, second no answer, third answers)
 *   node simulate.js first      (first person answers)
 *   node simulate.js voicemail  (nobody takes it, caller leaves a voicemail)
 *   node simulate.js missed     (caller hangs up while it is ringing)
 *
 * The server must be running with TEST_CALLS=1.
 */

const fs = require('fs');
const path = require('path');

const env = { ...readEnv(path.join(__dirname, '.env')), ...process.env };
const base = env.SIMULATE_URL || `http://localhost:${env.PORT || 3000}`;
const scenario = process.argv[2] || 'third';

const headers = {};
if (env.DASHBOARD_PASSWORD) {
  const login = `${env.DASHBOARD_USER || 'clinic'}:${env.DASHBOARD_PASSWORD}`;
  headers.Authorization = 'Basic ' + Buffer.from(login).toString('base64');
}

fetch(`${base}/api/test-call?scenario=${encodeURIComponent(scenario)}`, { method: 'POST', headers })
  .then(async (res) => {
    const text = await res.text();
    if (!res.ok) throw new Error(`${res.status} ${text}`);
    console.log(`Test call "${scenario}" started. Watch it on ${base}/`);
  })
  .catch((err) => {
    console.error('Could not start the test call:', err.message);
    console.error('Is the server running, and is TEST_CALLS=1 set?');
    process.exit(1);
  });

function readEnv(file) {
  const out = {};
  try {
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
      if (match && !line.trim().startsWith('#')) out[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
    }
  } catch {
    // no .env file, fine
  }
  return out;
}
