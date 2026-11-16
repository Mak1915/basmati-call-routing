'use strict';

/*
 * Basmati Dental Clinic: call routing demo
 *
 * A caller rings the clinic number. Twilio asks this server what to do.
 * We ring person 1, then 2, then 3, then 4. Whoever is busy or does not
 * pick up is skipped. If nobody takes the call, the caller leaves a voicemail.
 * Every call is logged, answered calls and voicemails are recorded,
 * and the dashboard at "/" shows all of it.
 *
 * No npm packages needed. Run with:  node server.js
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

loadEnvFile(path.join(__dirname, '.env'));

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/+$/, '');
const TWILIO_SID = process.env.TWILIO_ACCOUNT_SID || '';
const TWILIO_TOKEN = process.env.TWILIO_AUTH_TOKEN || '';
const DASH_USER = process.env.DASHBOARD_USER || 'clinic';
const DASH_PASS = process.env.DASHBOARD_PASSWORD || '';
const TEST_CALLS = process.env.TEST_CALLS === '1';
const VERIFY_TWILIO = Boolean(PUBLIC_URL && TWILIO_TOKEN);

const config = loadConfig();
const users = config.users;

// ---------------------------------------------------------------- storage

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'calls.json');
const MAX_CALLS = 2000;

/** @type {Map<string, any>} */
const calls = new Map();
loadCalls();

function loadCalls() {
  try {
    for (const c of JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'))) calls.set(c.id, c);
  } catch (err) {
    if (err.code !== 'ENOENT') console.warn('Could not read saved calls:', err.message);
  }
}

let saveTimer = null;
function save() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      const list = [...calls.values()].slice(-MAX_CALLS);
      const tmp = DATA_FILE + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(list));
      fs.renameSync(tmp, DATA_FILE);
    } catch (err) {
      console.error('Could not save calls:', err.message);
    }
  }, 250);
}

const now = () => new Date().toISOString();

function ensureCall(p) {
  const id = p.CallSid;
  let call = calls.get(id);
  if (!call) {
    call = {
      id,
      from: p.From || '',
      to: p.To || '',
      fromCountry: p.FromCountry || '',
      startedAt: now(),
      endedAt: null,
      answeredBy: null,
      answeredAt: null,
      talkSeconds: null,
      totalSeconds: null,
      steps: [],
      recording: null,
      voicemail: null,
      test: String(id).startsWith('TEST'),
    };
    calls.set(id, call);
  }
  return call;
}

const isLive = (call) => !call.endedAt;
const lastStep = (call) => call.steps[call.steps.length - 1];

function stepFor(call, target) {
  for (let i = call.steps.length - 1; i >= 0; i--) {
    if (call.steps[i].target === target) return call.steps[i];
  }
  return null;
}

/** Is this person already ringing for, or talking on, another clinic call? */
function busyOnAnotherCall(userId, exceptCallId) {
  for (const call of calls.values()) {
    if (!isLive(call) || call.id === exceptCallId) continue;
    if (call.answeredBy === userId) return true;
    const step = lastStep(call);
    if (step && step.target === userId && step.result === 'ringing') return true;
  }
  return false;
}

function finish(call, totalSeconds) {
  if (!call.endedAt) call.endedAt = now();
  if (totalSeconds != null && totalSeconds !== '') call.totalSeconds = Number(totalSeconds) || 0;
  for (const step of call.steps) {
    if (step.endedAt) continue;
    step.endedAt = call.endedAt;
    if (step.result === 'ringing') {
      step.result = 'no-answer';
      step.note = 'Caller hung up';
    }
  }
  if (call.answeredBy && call.talkSeconds == null && call.answeredAt) {
    call.talkSeconds = Math.max(0, Math.round((Date.parse(call.endedAt) - Date.parse(call.answeredAt)) / 1000));
  }
  save();
}

function outcome(call) {
  if (call.answeredBy) return isLive(call) ? 'in-call' : 'answered';
  if (call.voicemail) return 'voicemail';
  if (!isLive(call)) return 'missed';
  const step = lastStep(call);
  return step && step.target === 'voicemail' ? 'leaving-voicemail' : 'ringing';
}

// If Twilio never tells us a call ended (status callback not set up),
// do not leave people marked as busy forever.
setInterval(() => {
  const t = Date.now();
  const ringWindow = (users.length * config.ringSeconds + config.voicemailMaxSeconds + 120) * 1000;
  for (const call of calls.values()) {
    if (!isLive(call)) continue;
    const age = t - Date.parse(call.startedAt);
    if ((call.answeredBy && age > 4 * 3600 * 1000) || (!call.answeredBy && age > ringWindow)) finish(call);
  }
}, 30000).unref();

// ------------------------------------------------------------------ TwiML

const esc = (s) =>
  String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');

const xml = (body) => `<?xml version="1.0" encoding="UTF-8"?><Response>${body}</Response>`;

function say(text) {
  const voice = config.voice ? ` voice="${esc(config.voice)}"` : '';
  const lang = config.language ? ` language="${esc(config.language)}"` : '';
  return `<Say${voice}${lang}>${esc(text)}</Say>`;
}

/** Ring the next free person, starting at position `start`. Falls through to voicemail. */
function routeFrom(call, start) {
  let i = start;
  while (i < users.length && busyOnAnotherCall(users[i].id, call.id)) {
    const t = now();
    call.steps.push({ target: users[i].id, startedAt: t, endedAt: t, result: 'busy', note: 'On another clinic call' });
    i++;
  }
  if (i >= users.length) return voicemailTwiml(call);

  const user = users[i];
  call.steps.push({ target: user.id, startedAt: now(), endedAt: null, result: 'ringing' });
  save();

  const q = `call=${encodeURIComponent(call.id)}&i=${i}`;
  const record = config.recordCalls
    ? ` record="record-from-answer-dual" recordingStatusCallback="${esc(`/twilio/recording?${q}`)}" recordingStatusCallbackEvent="completed"`
    : '';
  const callerId = !config.showCallerNumber && call.to ? ` callerId="${esc(call.to)}"` : '';

  return xml(
    `<Dial timeout="${config.ringSeconds}" answerOnBridge="true" method="POST" action="${esc(`/twilio/after-dial?${q}`)}"${callerId}${record}>` +
      `<Number method="POST" url="${esc(`/twilio/screen?${q}`)}">${esc(user.phone)}</Number>` +
      `</Dial>`
  );
}

function voicemailTwiml(call) {
  call.steps.push({ target: 'voicemail', startedAt: now(), endedAt: null, result: 'recording' });
  save();
  const q = `call=${encodeURIComponent(call.id)}&kind=voicemail`;
  return xml(
    say(config.voicemailPrompt) +
      `<Record maxLength="${config.voicemailMaxSeconds}" timeout="5" playBeep="true" method="POST" action="/twilio/voicemail-done"` +
      ` recordingStatusCallback="${esc(`/twilio/recording?${q}`)}" recordingStatusCallbackEvent="completed"/>` +
      say('We did not receive a message. Goodbye.') +
      '<Hangup/>'
  );
}

function markAnswered(call, user) {
  if (call.answeredBy) return;
  call.answeredBy = user.id;
  call.answeredAt = now();
  const step = stepFor(call, user.id);
  if (step) step.result = 'answered';
  save();
}

// ------------------------------------------------------- Twilio webhooks
// Each handler gets the query string (q) and the form fields (p) and
// returns TwiML, or '' when Twilio is only reporting something.

const webhooks = {
  // A caller has dialled the clinic number.
  voice(q, p) {
    const call = ensureCall(p);
    save();
    console.log(`Incoming call ${call.id} from ${call.from || 'hidden number'}`);
    return xml(say(config.greeting) + '<Redirect method="POST">/twilio/next?i=0</Redirect>');
  },

  next(q, p) {
    return routeFrom(ensureCall(p), Number(q.i) || 0);
  },

  // The person we rang has picked up. The caller is still hearing ringing.
  screen(q) {
    const call = calls.get(q.call);
    const user = users[Number(q.i)];
    if (!call || !user) return xml('<Hangup/>');
    if (!config.screenCalls) {
      markAnswered(call, user);
      return xml('');
    }
    const next = `/twilio/screen-result?call=${encodeURIComponent(call.id)}&i=${Number(q.i)}`;
    return xml(
      `<Gather numDigits="1" timeout="6" method="POST" action="${esc(next)}">${say(config.screenPrompt)}</Gather><Hangup/>`
    );
  },

  'screen-result'(q, p) {
    const call = calls.get(q.call);
    const user = users[Number(q.i)];
    if (!call || !user || p.Digits !== '1') return xml('<Hangup/>');
    markAnswered(call, user);
    return xml(say('Connecting.'));
  },

  // The attempt to reach one person is over: either the conversation ended,
  // or they were busy, did not pick up, or did not accept.
  'after-dial'(q, p) {
    const call = ensureCall(p);
    const i = Number(q.i) || 0;
    const user = users[i];
    if (!user) return voicemailTwiml(call);

    const status = p.DialCallStatus || '';
    if (!config.screenCalls && status === 'completed') markAnswered(call, user);

    const step = stepFor(call, user.id);
    if (call.answeredBy === user.id) {
      if (p.DialCallDuration) call.talkSeconds = Number(p.DialCallDuration) || 0;
      finish(call);
      return xml('<Hangup/>');
    }

    if (step && !step.endedAt) {
      step.endedAt = now();
      step.result =
        { busy: 'busy', 'no-answer': 'no-answer', canceled: 'no-answer', failed: 'failed' }[status] ||
        (status === 'completed' || status === 'answered' ? 'declined' : 'no-answer');
    }
    save();

    if (p.CallStatus === 'completed' || !isLive(call)) {
      finish(call);
      return xml('<Hangup/>');
    }
    return routeFrom(call, i + 1);
  },

  'voicemail-done'(q, p) {
    const call = ensureCall(p);
    const seconds = Number(p.RecordingDuration) || 0;
    if (p.RecordingUrl && seconds > 0) {
      call.voicemail = { sid: p.RecordingSid || null, url: p.RecordingUrl, seconds };
    } else if (call.test && seconds > 0) {
      call.voicemail = { sid: null, url: null, seconds };
    }
    const step = stepFor(call, 'voicemail');
    if (step) {
      step.endedAt = now();
      step.result = call.voicemail ? 'left-message' : 'no-message';
    }
    save();
    return xml(say('Thank you. Goodbye.') + '<Hangup/>');
  },

  // A recording has finished processing and can be played.
  recording(q, p) {
    const call = calls.get(q.call || p.CallSid);
    if (!call || !p.RecordingUrl) return '';
    if (p.RecordingStatus && p.RecordingStatus !== 'completed') return '';
    const rec = { sid: p.RecordingSid || null, url: p.RecordingUrl, seconds: Number(p.RecordingDuration) || 0 };
    if (q.kind === 'voicemail') {
      if (rec.seconds > 0) call.voicemail = rec;
    } else {
      call.recording = rec;
    }
    save();
    return '';
  },

  // The call itself is over (set as "Call status changes" on the Twilio number).
  status(q, p) {
    const call = calls.get(p.CallSid);
    if (!call) return '';
    if (['completed', 'busy', 'failed', 'no-answer', 'canceled'].includes(p.CallStatus)) {
      finish(call, p.CallDuration);
    }
    return '';
  },
};

// ---------------------------------------------------------- test calls
// Walks a fake call through the same handlers Twilio would hit, so the
// routing and the dashboard can be checked without a phone. No audio.

const SCENARIOS = {
  first: { label: 'First person answers', plan: ['answer'] },
  third: { label: 'First is busy, second does not pick up, third answers', plan: ['busy', 'no-answer', 'answer'] },
  voicemail: { label: 'Nobody takes it, caller leaves a voicemail', plan: ['busy', 'no-answer', 'no-answer', 'busy'], voicemail: true },
  missed: { label: 'Caller hangs up while it is ringing', plan: ['no-answer', 'hangup'] },
};

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function runTestCall(name) {
  const scenario = SCENARIOS[name];
  if (!scenario) throw new Error('Unknown scenario');
  const id = 'TEST' + crypto.randomBytes(8).toString('hex');
  const base = {
    CallSid: id,
    From: '+9665' + String(Math.floor(10000000 + Math.random() * 89999999)),
    To: config.clinicNumber || '+966120000000',
    FromCountry: 'SA',
  };
  const started = Date.now();
  const elapsed = () => String(Math.round((Date.now() - started) / 1000));
  const end = () => webhooks.status({}, { ...base, CallStatus: 'completed', CallDuration: elapsed() });

  webhooks.voice({}, base);
  await wait(1500);
  let doc = webhooks.next({ i: '0' }, base);

  for (let guard = 0; guard < 20; guard++) {
    const match = /after-dial\?call=[^"]*?i=(\d+)/.exec(doc);
    if (!match) break; // routed to voicemail
    const i = match[1];
    const what = scenario.plan[Number(i)] || 'no-answer';
    const q = { call: id, i };

    if (what === 'answer') {
      await wait(2500);
      webhooks.screen(q, {});
      if (config.screenCalls) {
        await wait(1500);
        webhooks['screen-result'](q, { Digits: '1' });
      }
      await wait(9000);
      webhooks['after-dial'](q, { ...base, DialCallStatus: 'completed', DialCallDuration: '9' });
      return end();
    }
    if (what === 'hangup') {
      await wait(2500);
      return end();
    }
    await wait(what === 'busy' ? 1200 : 4000);
    doc = webhooks['after-dial'](q, { ...base, DialCallStatus: what });
  }

  if (scenario.voicemail) {
    await wait(6000);
    webhooks['voicemail-done']({}, { ...base, RecordingDuration: '6' });
  } else {
    await wait(2000);
  }
  end();
}

// ------------------------------------------------------------- HTTP server

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    const route = url.pathname;

    if (route === '/healthz') return send(res, 200, 'ok', 'text/plain');

    if (route.startsWith('/twilio/')) {
      if (req.method !== 'POST') return send(res, 405, 'Method not allowed', 'text/plain');
      const handler = webhooks[route.slice('/twilio/'.length)];
      if (!handler) return send(res, 404, 'Not found', 'text/plain');
      const body = await readBody(req);
      const p = Object.fromEntries(new URLSearchParams(body));
      if (VERIFY_TWILIO && !validTwilioSignature(req, p)) {
        console.warn(`Rejected ${route}: Twilio signature did not match. Check PUBLIC_URL and TWILIO_AUTH_TOKEN.`);
        return send(res, 403, 'Forbidden', 'text/plain');
      }
      const out = handler(Object.fromEntries(url.searchParams), p);
      return send(res, 200, out || xml(''), 'text/xml');
    }

    if (!dashboardAuthOk(req)) {
      res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Clinic phone desk"', 'Content-Type': 'text/plain' });
      return res.end('Login needed');
    }

    if (route === '/' && req.method === 'GET') {
      const html = fs.readFileSync(path.join(__dirname, 'public', 'index.html'));
      return send(res, 200, html, 'text/html; charset=utf-8', { 'Cache-Control': 'no-store' });
    }

    if (route === '/api/state' && req.method === 'GET') {
      return send(res, 200, JSON.stringify(stateForDashboard()), 'application/json', { 'Cache-Control': 'no-store' });
    }

    const rec = /^\/api\/recording\/([^/]+)\/(call|voicemail)$/.exec(route);
    if (rec && req.method === 'GET') return streamRecording(req, res, decodeURIComponent(rec[1]), rec[2]);

    if (route === '/api/test-call' && req.method === 'POST') {
      if (!TEST_CALLS) return send(res, 403, JSON.stringify({ error: 'Test calls are switched off.' }), 'application/json');
      const name = url.searchParams.get('scenario') || 'third';
      if (!SCENARIOS[name]) return send(res, 400, JSON.stringify({ error: 'Unknown scenario.' }), 'application/json');
      runTestCall(name).catch((err) => console.error('Test call failed:', err));
      return send(res, 202, JSON.stringify({ started: name }), 'application/json');
    }

    if (route === '/api/test-calls' && req.method === 'DELETE') {
      for (const [id, call] of calls) if (call.test) calls.delete(id);
      save();
      return send(res, 200, JSON.stringify({ ok: true }), 'application/json');
    }

    send(res, 404, 'Not found', 'text/plain');
  } catch (err) {
    console.error(err);
    if (!res.headersSent) send(res, 500, 'Server error', 'text/plain');
    else res.end();
  }
});

function send(res, status, body, type, extra) {
  res.writeHead(status, { 'Content-Type': type, ...(extra || {}) });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 100000) {
        reject(new Error('Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/** Twilio signs each webhook: base64(HMAC-SHA1(auth token, full URL + sorted form fields)). */
function validTwilioSignature(req, params) {
  const given = req.headers['x-twilio-signature'];
  if (!given) return false;
  let data = PUBLIC_URL + req.url;
  for (const key of Object.keys(params).sort()) data += key + params[key];
  const expected = crypto.createHmac('sha1', TWILIO_TOKEN).update(Buffer.from(data, 'utf8')).digest('base64');
  return safeEqual(given, expected);
}

function dashboardAuthOk(req) {
  if (!DASH_PASS) return true;
  const header = req.headers.authorization || '';
  if (!header.startsWith('Basic ')) return false;
  const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
  const split = decoded.indexOf(':');
  if (split < 0) return false;
  return safeEqual(decoded.slice(0, split), DASH_USER) && safeEqual(decoded.slice(split + 1), DASH_PASS);
}

function stateForDashboard() {
  const list = [...calls.values()]
    .sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1))
    .slice(0, 300)
    .map((call) => ({
      id: call.id,
      from: call.from,
      startedAt: call.startedAt,
      endedAt: call.endedAt,
      outcome: outcome(call),
      answeredBy: call.answeredBy,
      talkSeconds: call.talkSeconds,
      totalSeconds: call.totalSeconds,
      steps: call.steps,
      hasRecording: Boolean(call.recording && call.recording.url),
      voicemailSeconds: call.voicemail ? call.voicemail.seconds : null,
      hasVoicemailAudio: Boolean(call.voicemail && call.voicemail.url),
      test: call.test,
    }));
  return {
    clinicName: config.clinicName,
    clinicNumber: config.clinicNumber,
    timezone: config.timezone,
    ringSeconds: config.ringSeconds,
    recordCalls: config.recordCalls,
    users: users.map(({ id, name, place, phone }) => ({ id, name, place, phone })),
    testCalls: TEST_CALLS,
    scenarios: TEST_CALLS ? Object.entries(SCENARIOS).map(([id, s]) => ({ id, label: s.label })) : [],
    calls: list,
  };
}

/** Recordings live at Twilio. Fetch with our credentials so the browser never sees them. */
async function streamRecording(req, res, callId, kind) {
  const call = calls.get(callId);
  const rec = call && (kind === 'voicemail' ? call.voicemail : call.recording);
  if (!rec || !rec.url) return send(res, 404, 'No recording for this call', 'text/plain');

  let target;
  try {
    target = new URL(rec.url);
  } catch {
    return send(res, 404, 'No recording for this call', 'text/plain');
  }
  if (target.protocol !== 'https:' || !/(^|\.)twilio\.com$/.test(target.hostname)) {
    return send(res, 400, 'Recording address is not a Twilio address', 'text/plain');
  }
  if (!TWILIO_SID || !TWILIO_TOKEN) {
    return send(res, 503, 'Add TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN to play recordings', 'text/plain');
  }

  const upstream = await fetch(target.href.replace(/\.(mp3|wav)$/, '') + '.mp3', {
    headers: { Authorization: 'Basic ' + Buffer.from(`${TWILIO_SID}:${TWILIO_TOKEN}`).toString('base64') },
  });
  if (!upstream.ok) return send(res, 502, `Twilio answered ${upstream.status} for this recording`, 'text/plain');
  const audio = Buffer.from(await upstream.arrayBuffer());

  const headers = { 'Content-Type': 'audio/mpeg', 'Accept-Ranges': 'bytes', 'Cache-Control': 'private, max-age=3600' };
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
  if (range && (range[1] || range[2])) {
    let start = range[1] ? Number(range[1]) : Math.max(0, audio.length - Number(range[2]));
    let end = range[1] && range[2] ? Math.min(Number(range[2]), audio.length - 1) : audio.length - 1;
    if (start > end || start >= audio.length) {
      res.writeHead(416, { 'Content-Range': `bytes */${audio.length}` });
      return res.end();
    }
    res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${audio.length}`, 'Content-Length': end - start + 1 });
    return res.end(audio.subarray(start, end + 1));
  }
  res.writeHead(200, { ...headers, 'Content-Length': audio.length });
  res.end(audio);
}

// ------------------------------------------------------------------ setup

function loadEnvFile(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return;
  }
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!match || line.trim().startsWith('#')) continue;
    const value = match[2].replace(/^(['"])(.*)\1$/, '$2');
    if (process.env[match[1]] === undefined) process.env[match[1]] = value;
  }
}

function loadConfig() {
  const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
  if (!Array.isArray(cfg.users) || cfg.users.length === 0) throw new Error('config.json needs at least one user');
  const seen = new Set();
  for (const user of cfg.users) {
    if (!user.id || !user.name || !user.phone) throw new Error('Each user in config.json needs id, name and phone');
    if (user.id === 'voicemail' || seen.has(user.id)) throw new Error(`User id "${user.id}" is not allowed or is repeated`);
    if (!/^\+[1-9]\d{6,14}$/.test(user.phone)) throw new Error(`Phone for ${user.name} must look like +9665XXXXXXXX`);
    seen.add(user.id);
  }
  cfg.ringSeconds = Math.min(60, Math.max(5, Number(cfg.ringSeconds) || 15));
  cfg.voicemailMaxSeconds = Math.min(600, Math.max(10, Number(cfg.voicemailMaxSeconds) || 120));
  cfg.timezone = cfg.timezone || 'Asia/Riyadh';
  return cfg;
}

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`${config.clinicName} phone desk is running on port ${PORT}`);
    console.log(`Rings in order: ${users.map((u) => u.name).join(' > ')} > voicemail (${config.ringSeconds}s each)`);
    if (users.some((u) => /^\+96650000000\d$/.test(u.phone))) {
      console.warn('! config.json still has placeholder phone numbers. Put the real ones in before a live call.');
    }
    if (!DASH_PASS) console.warn('! DASHBOARD_PASSWORD is empty: anyone with the link can open the dashboard.');
    if (!VERIFY_TWILIO) console.warn('! PUBLIC_URL or TWILIO_AUTH_TOKEN is empty: webhooks are not checked for a Twilio signature.');
    if (TEST_CALLS) console.log('Test calls are on (TEST_CALLS=1).');
  });
}

module.exports = { server, webhooks, calls, config };
