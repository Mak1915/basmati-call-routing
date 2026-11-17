'use strict';

/*
 * End-to-end check with pretend versions of Google AI, Twilio and the Google Sheet.
 *   TMPDIR=/some/folder node test/e2e.js
 *
 * It starts the real server, drives it with the same webhooks Twilio sends, and checks the
 * sheet rows, the WhatsApp messages and the reminders. It cannot say whether Google or
 * Twilio accept our requests in real life, only that we build and read them consistently.
 */

const http = require('http');
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { createFakeSheets } = require('./fake-sheets');
const util = require('../lib/util');

const root = path.join(__dirname, '..');
const code = fs.readFileSync(path.join(root, 'apps-script', 'Code.gs'), 'utf8').replace('PASTE_SECRET_HERE', 'test-secret');
const fake = createFakeSheets(code);

const tomorrow = util.addDays(util.todayYmd(), 1);
const dayAfter = util.addDays(util.todayYmd(), 2);
const ext = (o) => () => ({
  language: 'en', summary: 'x', wantsAppointment: false, booked: false, patientName: '', patientPhone: '', date: '', time: '',
  treatment: '', confidence: 'high', notes: '', ...o,
});

const SCRIPTS = {
  book_en: { text: 'Caller: I would like an appointment tomorrow at four thirty.\nClinic: Booked. Name?\nCaller: Omar Al-Harbi.',
    ext: ext({ summary: 'Omar booked a cleaning.', wantsAppointment: true, booked: true, patientName: 'Omar Al-Harbi', date: tomorrow, time: '16:30', treatment: 'Cleaning' }) },
  book_ar: { text: 'Caller: السلام عليكم، أبغى موعد بعد بكرة الساعة 11.\nClinic: تمام، الاسم؟\nCaller: خالد الغامدي.',
    ext: ext({ language: 'ar', summary: 'Khalid booked.', wantsAppointment: true, booked: true, patientName: 'خالد الغامدي', date: dayAfter, time: '11:00', treatment: 'تنظيف الأسنان' }) },
  inquiry: { text: 'Caller: How much is whitening?\nClinic: The dentist has to see you first.\nCaller: OK thanks.', ext: ext({ summary: 'Price question.' }) },
  unclear: { text: 'Caller: I need an appointment next week.\nClinic: We will call you back.', ext: ext({ summary: 'Wants a slot.', wantsAppointment: true, patientName: 'Sara', confidence: 'medium' }) },
  badtime: { text: 'Caller: Book me tomorrow some time.\nClinic: Sure, noted.', ext: ext({ summary: 'Booked without a time.', wantsAppointment: true, booked: true, patientName: 'Nasser', date: tomorrow, time: '' }) },
  lowconf: { text: 'Caller: Tomorrow at five.\nClinic: Booked.', ext: ext({ summary: 'AM or PM unclear.', wantsAppointment: true, booked: true, patientName: 'Huda', date: tomorrow, time: '05:00', confidence: 'low' }) },
  past: { text: 'Caller: Yesterday at ten.\nClinic: Booked.', ext: ext({ summary: 'Date in the past.', wantsAppointment: true, booked: true, patientName: 'Old', date: util.addDays(util.todayYmd(), -3), time: '10:00', confidence: 'high' }) },
};
const alias = { retry: 'book_en', nomodel: 'book_en', shorttx: 'book_en', overload: 'book_en', overload2: 'book_en' };
const down = new Set(); // models the mock reports as overloaded

const counters = { transcribe: 0, extract: 0, fallback: 0, retryHits: 0 };
const sent = [];
const whatsappFrom = 'whatsapp:+14155238886';

const readBody = (req) => new Promise((resolve) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => resolve(b)); });

const mock = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const body = await readBody(req);
  const json = (status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };

  if (url.pathname === '/sheet') return json(200, fake.doPost(body));

  const g = /^\/v1beta\/models\/([^:]+):generateContent$/.exec(url.pathname);
  if (g) {
    if (req.headers['x-goog-api-key'] !== 'k') return json(403, { error: { message: 'bad key' } });
    const model = g[1];
    if (down.has(model)) return json(503, { error: { message: 'This model is currently experiencing high demand.' } });
    const parts = JSON.parse(body).contents[0].parts;
    const audio = parts.find((p) => p.inlineData);
    const textPart = parts.find((p) => p.text);
    if (audio) {
      assert.strictEqual(audio.inlineData.mimeType, 'audio/mpeg');
      const scenario = Buffer.from(audio.inlineData.data, 'base64').toString().replace('SCENARIO:', '');
      const key = alias[scenario] || scenario;
      if (/transcribe/.test(model)) {
        counters.transcribe++;
        if (scenario === 'nomodel') return json(404, { error: { message: 'models/gemini-3.5-transcribe is not found' } });
        if (scenario === 'retry' && ++counters.retryHits === 1) return json(429, { error: { message: 'quota' } });
        if (scenario === 'silence') return json(200, { candidates: [{ content: { parts: [] }, finishReason: 'STOP' }] });
        if (scenario === 'shorttx') return json(200, { candidates: [{ content: { parts: [{ text: 'Hi.' }] } }] });
      } else {
        counters.fallback++;
        assert.ok(textPart && /Transcribe/.test(textPart.text), 'fallback prompt');
        if (scenario === 'silence') return json(200, { candidates: [{ content: { parts: [] }, finishReason: 'STOP' }] });
      }
      return json(200, { candidates: [{ content: { parts: [{ text: `${SCRIPTS[key].text} [#${key}#]` }] } }] });
    }
    counters.extract++;
    assert.strictEqual(JSON.parse(body).generationConfig.responseMimeType, 'application/json');
    assert.ok(/Today is \w+ \d{4}-\d{2}-\d{2}/.test(textPart.text), 'prompt carries today');
    const key = /\[#(\w+)#\]/.exec(textPart.text)[1];
    return json(200, { candidates: [{ content: { parts: [{ text: JSON.stringify(SCRIPTS[key].ext()) }] } }] });
  }

  if (url.pathname === '/2010-04-01/Accounts/ACtest/Recordings.json') {
    const ago = (ms) => new Date(Date.now() - ms).toISOString();
    const base = '/2010-04-01/Accounts/ACtest/Recordings/';
    return json(200, { recordings: [
      { sid: 'RErec1', call_sid: 'CAREC', source: 'DialVerb', status: 'completed', duration: '85', date_created: ago(60000), uri: base + 'RE_book_en.json' },
      { sid: 'REold', call_sid: 'CAOLD', source: 'DialVerb', status: 'completed', duration: '85', date_created: ago(5 * 86400000), uri: base + 'RE_book_en.json' },
      { sid: 'REtiny', call_sid: 'CATINY', source: 'DialVerb', status: 'completed', duration: '0', date_created: ago(60000), uri: base + 'RE_book_en.json' },
    ] });
  }
  if (url.pathname === '/2010-04-01/Accounts/ACtest/Calls/CAREC.json') {
    return json(200, { from: '+966556667788', to: '+12174961882', start_time: new Date(Date.now() - 150000).toISOString(), duration: '100' });
  }

  const rec = /^\/2010-04-01\/Accounts\/ACtest\/Recordings\/RE_(\w+)\.mp3$/.exec(url.pathname);
  if (rec) {
    assert.strictEqual(req.headers.authorization, 'Basic ' + Buffer.from('ACtest:tok').toString('base64'));
    res.writeHead(200, { 'Content-Type': 'audio/mpeg' });
    return res.end(`SCENARIO:${rec[1]}`);
  }

  if (url.pathname === '/2010-04-01/Accounts/ACtest/Messages.json' && req.method === 'POST') {
    const f = Object.fromEntries(new URLSearchParams(body));
    sent.push({ from: f.From, to: f.To, body: f.Body });
    if (f.To === 'whatsapp:+966555000000') return json(400, { code: 63015, message: 'Channel Sandbox can only send messages to phone numbers that have joined the Sandbox' });
    return json(201, { sid: 'SM' + sent.length, status: 'queued' });
  }
  json(404, { error: 'not mocked: ' + url.pathname });
});

// ---------------------------------------------------------------- helpers

let failures = 0;
async function check(name, fn) {
  try {
    await fn();
    console.log('  ok   ' + name);
  } catch (err) {
    failures++;
    console.log('  FAIL ' + name + '\n       ' + String(err.message).split('\n').join('\n       '));
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 20000, what = 'condition') {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('Timed out waiting for ' + what);
    await sleep(100);
  }
}

function startServer(port, extra) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'basmati-e2e-'));
  const mockUrl = `http://127.0.0.1:${mock.address().port}`;
  const env = {
    ...process.env, PORT: String(port), DATA_DIR: dataDir, TEST_CALLS: '1', AI_RETRY_MS: '10', AUTO_RETRY_MS: '300', AUTO_REMINDERS: '0', AUTO_RECOVER: '0',
    TWILIO_ACCOUNT_SID: 'ACtest', TWILIO_AUTH_TOKEN: 'tok', TWILIO_API_BASE: mockUrl,
    GEMINI_API_KEY: 'k', GEMINI_API_BASE: mockUrl,
    SHEET_WEBHOOK_URL: mockUrl + '/sheet', SHEET_SECRET: 'test-secret', SHEET_URL: 'https://docs.example/sheet',
    TWILIO_WHATSAPP_FROM: whatsappFrom, CLINIC_REP_WHATSAPP: '+966500000009', CLINIC_NUMBER: '+966 12 111 2222',
    PUBLIC_URL: '', DASHBOARD_PASSWORD: '', ...extra,
  };
  const child = spawn(process.execPath, ['server.js'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  child.stdout.on('data', (d) => (log += d));
  child.stderr.on('data', (d) => (log += d));
  const api = async (p, method = 'GET', json) => {
    const r = await fetch(`http://127.0.0.1:${port}${p}`, { method, ...(json ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(json) } : {}) });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  };
  const hook = async (p, form) => {
    const r = await fetch(`http://127.0.0.1:${port}/twilio/${p}`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(form),
    });
    return r.text();
  };
  return until(async () => { try { return (await fetch(`http://127.0.0.1:${port}/healthz`)).ok; } catch { return false; } }, 8000, 'server start')
    .then(() => ({ child, api, hook, log: () => log, stop: () => child.kill() }));
}

const rowOf = (tab, id) => (fake.sheet(tab) ? fake.sheet(tab).data : []).find((r) => r && r[0] === id);

/** A whole call as Twilio would report it: answered by the first person, then the recording arrives. */
async function simulateCall(srv, sid, from, scenario, o = {}) {
  await srv.hook('voice', { CallSid: sid, From: from, To: '+966121112222' });
  await srv.hook('next?i=0', { CallSid: sid, From: from });
  await srv.hook(`screen?call=${sid}&i=0`, {});
  await srv.hook(`screen-result?call=${sid}&i=0`, { Digits: '1' });
  await srv.hook(`after-dial?call=${sid}&i=0`, { CallSid: sid, DialCallStatus: 'completed', DialCallDuration: '40' });
  await srv.hook(`recording?call=${sid}&i=${o.attempt || 0}`, {
    RecordingSid: 'RE_' + scenario, RecordingUrl: 'https://api.twilio.com/2010-04-01/Accounts/ACtest/Recordings/RE_' + scenario,
    RecordingDuration: String(o.seconds || 40), RecordingStatus: 'completed',
  });
  await srv.hook('status', { CallSid: sid, CallStatus: 'completed', CallDuration: '45' });
}

async function settled(srv, sid) {
  return until(async () => {
    const call = (await srv.api('/api/state')).body.calls.find((c) => c.id === sid);
    const row = rowOf('Calls', sid);
    if (call && call.analysis && call.analysis.status !== 'working' && row && row[5] !== 'Analyzing') return call;
    return null;
  }, 20000, 'analysis of ' + sid);
}

const to = (phone) => sent.filter((m) => m.to === 'whatsapp:' + phone);

// ------------------------------------------------------------------ tests

(async () => {
  await new Promise((r) => mock.listen(0, '127.0.0.1', r));
  const a = await startServer(3201, {});

  console.log('Startup');
  await check('sheet script creates both tabs and removes the empty first tab', async () => {
    await until(() => fake.sheet('Calls') && fake.sheet('Appointments'), 5000, 'tabs');
    assert.deepStrictEqual(fake.sheets.map((s) => s.name), ['Appointments', 'Calls']);
    assert.strictEqual(fake.sheet('Calls').rules.length, 4);
  });
  await check('dashboard state reports what is connected', async () => {
    const st = (await a.api('/api/state')).body.integrations;
    assert.ok(st.sheet.configured && st.sheet.ok === true, 'sheet');
    assert.ok(st.whatsapp.configured && st.whatsapp.clinicNumberSet, 'whatsapp');
    assert.ok(st.transcription.configured, 'ai');
  });
  await check('sheet script refuses a wrong secret', async () => {
    const out = fake.doPost(JSON.stringify({ secret: 'nope', action: 'listAppointments' }));
    assert.strictEqual(out.ok, false);
    assert.ok(/Wrong secret/.test(out.error));
    assert.ok(/running/.test(fake.doGet()));
  });

  console.log('English booking');
  await check('booked, patient and clinic both get WhatsApp, sheet rows written', async () => {
    await simulateCall(a, 'CA_en', '+966551111111', 'book_en');
    const call = await settled(a, 'CA_en');
    assert.strictEqual(call.analysis.outcome, 'Booked');
    const patient = to('+966551111111');
    assert.strictEqual(patient.length, 1);
    assert.strictEqual(patient[0].from, whatsappFrom);
    assert.ok(/Hello Omar Al-Harbi/.test(patient[0].body) && /booked for/.test(patient[0].body) && /4:30 PM/.test(patient[0].body), patient[0].body);
    assert.ok(/\+966 12 111 2222/.test(patient[0].body), 'clinic number in message');
    const rep = to('+966500000009');
    assert.ok(/New booking/.test(rep[0].body) && /Patient confirmation: sent/.test(rep[0].body) && /Taken by: Landline 1/.test(rep[0].body), rep[0].body);
    const c = rowOf('Calls', 'CA_en');
    assert.strictEqual(c[5], 'Booked');
    assert.strictEqual(c[8], tomorrow);
    assert.strictEqual(c[9], '16:30');
    assert.strictEqual(c[3], 'Landline 1');
    assert.ok(/Caller:/.test(c[12]) && /\[#book_en#\]/.test(c[12]), 'transcript stored');
    const ap = rowOf('Appointments', 'CA_en');
    assert.deepStrictEqual([ap[1], ap[2], ap[3], ap[6], ap[7]], [tomorrow, '16:30', 'Omar Al-Harbi', 'Booked', 'English']);
    assert.strictEqual(ap[4], '+966551111111');
    assert.strictEqual(ap[8], 'Patient: sent / Clinic: sent');
    assert.ok(fake.sheet('Calls').textFormatCalls > 0, 'rows set to plain text');
  });

  console.log('Arabic booking');
  await check('patient gets the Arabic message', async () => {
    await simulateCall(a, 'CA_ar', '+966552222222', 'book_ar');
    const call = await settled(a, 'CA_ar');
    assert.strictEqual(call.analysis.outcome, 'Booked');
    const m = to('+966552222222')[0].body;
    assert.ok(/تم حجز موعدك/.test(m) && /مرحباً خالد الغامدي/.test(m) && /11:00 صباحاً/.test(m), m);
    assert.strictEqual(rowOf('Calls', 'CA_ar')[4], 'Arabic');
    assert.strictEqual(rowOf('Appointments', 'CA_ar')[7], 'Arabic');
  });

  console.log('Calls that are not bookings');
  await check('a plain question is Not booked: no messages, no appointment row', async () => {
    const before = sent.length;
    await simulateCall(a, 'CA_q', '+966553333333', 'inquiry');
    await settled(a, 'CA_q');
    assert.strictEqual(rowOf('Calls', 'CA_q')[5], 'Not booked');
    assert.strictEqual(rowOf('Appointments', 'CA_q'), undefined);
    assert.strictEqual(sent.length, before);
  });
  await check('wants an appointment but none agreed: only the clinic is told', async () => {
    await simulateCall(a, 'CA_un', '+966554444444', 'unclear');
    const call = await settled(a, 'CA_un');
    assert.strictEqual(call.analysis.outcome, 'Needs review');
    assert.strictEqual(to('+966554444444').length, 0);
    assert.ok(to('+966500000009').some((m) => /Please check this call/.test(m.body) && /none was confirmed/.test(m.body)));
    assert.strictEqual(rowOf('Appointments', 'CA_un')[6], 'Needs review');
  });
  for (const [sid, scenario, reason] of [['CA_bt', 'badtime', /day or time is not clear/], ['CA_lc', 'lowconf', /not sure/], ['CA_pa', 'past', /in the past/]]) {
    await check(`${scenario}: never confirmed to the patient`, async () => {
      await simulateCall(a, sid, '+96655' + String(sid.length) + '000000', scenario);
      const call = await settled(a, sid);
      assert.strictEqual(call.analysis.outcome, 'Needs review');
      assert.ok(reason.test(call.analysis.reviewReason), call.analysis.reviewReason);
      assert.ok(!sent.some((m) => /Your appointment/.test(m.body) && m.to.includes('+96655' + String(sid.length))));
    });
  }

  console.log('Staff fix a call on the dashboard');
  await check('confirming a review call books it, writes the sheet row and messages both sides', async () => {
    const day = new Date(Date.now() + 10 * 86400000).toISOString().slice(0, 10);
    const bad = await a.api('/api/calls/CA_un/confirm', 'POST', { action: 'book', patientName: 'Sara', date: '2020-01-01', time: '10:00' });
    assert.strictEqual(bad.status, 400);
    const noName = await a.api('/api/calls/CA_un/confirm', 'POST', { action: 'book', patientName: '', date: day, time: '10:00' });
    assert.strictEqual(noName.status, 400);
    const ok = await a.api('/api/calls/CA_un/confirm', 'POST', { action: 'book', patientName: 'Sara Ali', patientPhone: '+966554444444', date: day, time: '10:30', treatment: 'Cleaning' });
    assert.strictEqual(ok.status, 200, JSON.stringify(ok.body));
    const call = (await a.api('/api/state')).body.calls.find((c) => c.id === 'CA_un');
    assert.strictEqual(call.analysis.outcome, 'Booked');
    assert.strictEqual(call.analysis.patientName, 'Sara Ali');
    const row = rowOf('Appointments', 'CA_un');
    assert.strictEqual(row[6], 'Booked');
    assert.ok(to('+966554444444').some((m) => /Your appointment/.test(m.body)), 'patient confirmation');
  });
  await check('"not a booking" clears the appointment row', async () => {
    const ok = await a.api('/api/calls/CA_pa/confirm', 'POST', { action: 'notbooked' });
    assert.strictEqual(ok.status, 200);
    assert.strictEqual(rowOf('Appointments', 'CA_pa')[6], 'Cancelled');
    assert.strictEqual(rowOf('Calls', 'CA_pa')[5], 'Not booked');
  });

  await check('an appointment can be edited from the list, in the sheet and in the call', async () => {
    const day = new Date(Date.now() + 11 * 86400000).toISOString().slice(0, 10);
    const bad = await a.api('/api/appointments/CA_un/edit', 'POST', { patient: '', date: day, time: '11:00' });
    assert.strictEqual(bad.status, 400);
    const ok = await a.api('/api/appointments/CA_un/edit', 'POST', { patient: 'Sara A.', phone: '+966554444444', date: day, time: '11:15', treatment: 'Filling' });
    assert.strictEqual(ok.status, 200, JSON.stringify(ok.body));
    const row = rowOf('Appointments', 'CA_un');
    assert.strictEqual(row[1], day);
    assert.strictEqual(row[2], '11:15');
    assert.strictEqual(row[3], 'Sara A.');
    const call = (await a.api('/api/state')).body.calls.find((c) => c.id === 'CA_un');
    assert.strictEqual(call.analysis.patientName, 'Sara A.');
  });
  await check('an appointment can be removed from the list', async () => {
    const ok = await a.api('/api/appointments/CA_un/remove', 'POST', {});
    assert.strictEqual(ok.status, 200, JSON.stringify(ok.body));
    assert.strictEqual(rowOf('Appointments', 'CA_un')[6], 'Cancelled');
  });

  console.log('Things that go wrong');
  await check('WhatsApp refuses the patient: booking still saved, failure shown plainly', async () => {
    await simulateCall(a, 'CA_nowa', '+966555000000', 'book_en');
    const call = await settled(a, 'CA_nowa');
    assert.strictEqual(call.analysis.outcome, 'Booked');
    const m = call.messages.find((x) => x.to === 'customer');
    assert.ok(!m.ok && /sandbox/.test(m.error), m.error);
    assert.ok(to('+966500000009').some((x) => /NOT sent/.test(x.body)));
    assert.ok(/Patient: failed/.test(rowOf('Appointments', 'CA_nowa')[8]));
  });
  await check('Google AI rate limit is retried', async () => {
    await simulateCall(a, 'CA_retry', '+966556666666', 'retry');
    const call = await settled(a, 'CA_retry');
    assert.strictEqual(call.analysis.outcome, 'Booked');
    assert.ok(counters.retryHits >= 2);
  });
  await check('speech model not available: falls back to the general model', async () => {
    await simulateCall(a, 'CA_nm', '+966557777777', 'nomodel');
    const call = await settled(a, 'CA_nm');
    assert.strictEqual(call.analysis.outcome, 'Booked');
    assert.ok(counters.fallback >= 1);
  });
  await check('silent recording is Not booked, not an error', async () => {
    await simulateCall(a, 'CA_si', '+966558888888', 'silence');
    const call = await settled(a, 'CA_si');
    assert.strictEqual(call.analysis.status, 'done');
    assert.strictEqual(call.analysis.outcome, 'Not booked');
  });
  await check('speech model hears almost nothing: the general model transcribes the same audio', async () => {
    const before = counters.fallback;
    await simulateCall(a, 'CA_st', '+966558888801', 'shorttx');
    const call = await settled(a, 'CA_st');
    assert.strictEqual(call.analysis.outcome, 'Booked');
    assert.ok(counters.fallback > before);
  });
  await check('nothing heard by either model: says so and shows what each returned', async () => {
    const call = (await a.api('/api/state')).body.calls.find((c) => c.id === 'CA_si');
    assert.ok(/no text/.test(call.analysis.notes) && /KB/.test(call.analysis.notes), call.analysis.notes);
  });
  await check('main AI models overloaded: another model does the work', async () => {
    down.add('gemini-3.5-transcribe');
    down.add('gemini-3.8-flash');
    try {
      await simulateCall(a, 'CA_ov', '+966558888802', 'overload');
      const call = await settled(a, 'CA_ov');
      assert.strictEqual(call.analysis.outcome, 'Booked');
    } finally {
      down.clear();
    }
  });
  await check('every AI model overloaded: the call is analysed again by itself a little later', async () => {
    ['gemini-3.5-transcribe', 'gemini-3.8-flash', 'gemini-3.6-flash', 'gemini-3.5-flash-lite', 'gemini-3.1-flash-lite'].forEach((m) => down.add(m));
    await simulateCall(a, 'CA_ov2', '+966558888803', 'overload2');
    await until(async () => {
      const c = (await a.api('/api/state')).body.calls.find((x) => x.id === 'CA_ov2');
      return c && c.analysis && c.analysis.status === 'failed';
    }, 20000, 'failure');
    down.clear();
    const call = await until(async () => {
      const c = (await a.api('/api/state')).body.calls.find((x) => x.id === 'CA_ov2');
      return c && c.analysis && c.analysis.status === 'done' ? c : null;
    }, 20000, 'the automatic retry');
    assert.strictEqual(call.analysis.outcome, 'Booked');
    await settled(a, 'CA_ov2');
  });
  await check('very short recording is not sent to the AI', async () => {
    const before = counters.transcribe;
    await simulateCall(a, 'CA_sh', '+966559999990', 'book_en', { seconds: 5 });
    const call = await settled(a, 'CA_sh');
    assert.strictEqual(call.analysis.outcome, 'Not booked');
    assert.strictEqual(counters.transcribe, before);
  });
  await check('recording of someone who did not take the call is ignored', async () => {
    const before = counters.transcribe;
    await a.hook('voice', { CallSid: 'CA_wrong', From: '+966559999991' });
    await a.hook('next?i=0', { CallSid: 'CA_wrong' });
    await a.hook('screen?call=CA_wrong&i=0', {});
    await a.hook('screen-result?call=CA_wrong&i=0', { Digits: '1' });
    await a.hook('recording?call=CA_wrong&i=1', {
      RecordingSid: 'RE_book_en', RecordingUrl: 'https://api.twilio.com/2010-04-01/Accounts/ACtest/Recordings/RE_book_en', RecordingDuration: '30', RecordingStatus: 'completed',
    });
    await sleep(400);
    assert.strictEqual(counters.transcribe, before);
    const c = (await a.api('/api/state')).body.calls.find((x) => x.id === 'CA_wrong');
    assert.strictEqual(c.analysis, null);
    await a.hook('status', { CallSid: 'CA_wrong', CallStatus: 'completed' });
  });
  await check('call nobody answered shows as Missed call in the sheet', async () => {
    await a.hook('voice', { CallSid: 'CA_miss', From: '+966559999992' });
    await a.hook('status', { CallSid: 'CA_miss', CallStatus: 'completed', CallDuration: '3' });
    await until(() => rowOf('Calls', 'CA_miss'), 5000, 'missed row');
    assert.strictEqual(rowOf('Calls', 'CA_miss')[5], 'Missed call');
    assert.strictEqual(rowOf('Appointments', 'CA_miss'), undefined);
  });
  await check('analysing again does not send the confirmation twice', async () => {
    const before = to('+966551111111').length;
    await a.api('/api/analyze/CA_en', 'POST');
    await sleep(300);
    await settled(a, 'CA_en');
    await sleep(400);
    assert.strictEqual(to('+966551111111').length, before);
  });

  console.log('Ringing in groups');
  const g = await startServer(3203); // a clean server: calls left open by earlier tests would count as busy
  const numbersIn = (doc) => [...doc.matchAll(/<Number[^>]*>([^<]+)<\/Number>/g)].map((m) => m[1]);
  await check('both landlines ring together first, for 10 seconds', async () => {
    await g.hook('voice', { CallSid: 'CA_g1', From: '+966551230001', To: '+966121112222' });
    const doc = await g.hook('next?i=0', { CallSid: 'CA_g1' });
    assert.deepStrictEqual(numbersIn(doc), ['+966500000001', '+966500000002']);
    assert.ok(/timeout="10"/.test(doc), doc);
  });
  await check('nobody on the landlines: all four staff phones ring together', async () => {
    const doc = await g.hook('after-dial?call=CA_g1&i=0', { CallSid: 'CA_g1', DialCallStatus: 'no-answer' });
    assert.deepStrictEqual(numbersIn(doc), ['+966500000003', '+966500000004', '+966500000005', '+966500000006']);
  });
  await check('two people accept at the same moment: only the first is connected', async () => {
    const first = await g.hook('screen-result?call=CA_g1&i=1&u=3', { Digits: '1' });
    const second = await g.hook('screen-result?call=CA_g1&i=1&u=4', { Digits: '1' });
    assert.ok(/Connecting/.test(first), first);
    assert.ok(/already been taken/.test(second) && !/Connecting/.test(second), second);
    const late = await g.hook('screen?call=CA_g1&i=1&u=5', {});
    assert.ok(/already been taken/.test(late), late);
    const call = (await g.api('/api/state')).body.calls.find((c) => c.id === 'CA_g1');
    assert.strictEqual(call.answeredBy, 'u2');
    const other = call.steps.find((st) => st.target === 'u3');
    assert.strictEqual(other.result, 'no-answer');
    assert.strictEqual(other.note, 'Someone else answered first');
  });
  await check('someone already on a call is left out of the next group, and skipped groups are skipped', async () => {
    await g.hook('voice', { CallSid: 'CA_g2', From: '+966551230002', To: '+966121112222' });
    await g.hook('next?i=0', { CallSid: 'CA_g2' });
    await g.hook('screen-result?call=CA_g2&i=0&u=0', { Digits: '1' }); // Landline 1 takes it
    await g.hook('voice', { CallSid: 'CA_g3', From: '+966551230003', To: '+966121112222' });
    const doc = await g.hook('next?i=0', { CallSid: 'CA_g3' });
    assert.deepStrictEqual(numbersIn(doc), ['+966500000002']);
    await g.hook('screen-result?call=CA_g3&i=0&u=1', { Digits: '1' }); // Landline 2 takes it too
    await g.hook('voice', { CallSid: 'CA_g4', From: '+966551230004', To: '+966121112222' });
    const doc2 = await g.hook('next?i=0', { CallSid: 'CA_g4' });
    assert.deepStrictEqual(numbersIn(doc2), ['+966500000003', '+966500000005', '+966500000006'], 'both landlines busy: straight to the staff phones, minus the manager who is still on the first call');
    for (const sid of ['CA_g1', 'CA_g2', 'CA_g3', 'CA_g4']) await g.hook('status', { CallSid: sid, CallStatus: 'completed', CallDuration: '3' });
  });
  await check('nobody anywhere: goes to voicemail', async () => {
    await g.hook('voice', { CallSid: 'CA_g5', From: '+966551230005', To: '+966121112222' });
    await g.hook('next?i=0', { CallSid: 'CA_g5' });
    await g.hook('after-dial?call=CA_g5&i=0', { CallSid: 'CA_g5', DialCallStatus: 'no-answer' });
    const vm = await g.hook('after-dial?call=CA_g5&i=1', { CallSid: 'CA_g5', DialCallStatus: 'no-answer' });
    assert.ok(/<Record /.test(vm), vm);
    await g.hook('status', { CallSid: 'CA_g5', CallStatus: 'completed', CallDuration: '12' });
  });
  g.stop();

  console.log('Bringing calls back after a restart');
  const r1 = await startServer(3204, { AUTO_RECOVER: '1' });
  const toPatient = () => sent.filter((m) => m.to === 'whatsapp:+966556667788').length;
  await check('after a restart the call comes back from Twilio and is analysed', async () => {
    const call = await until(async () => {
      const c = (await r1.api('/api/state')).body.calls.find((x) => x.id === 'CAREC');
      return c && c.analysis && c.analysis.status === 'done' ? c : null;
    }, 20000, 'the recovered call');
    assert.strictEqual(call.analysis.outcome, 'Booked');
    assert.strictEqual(call.from, '+966556667788');
    await until(() => toPatient() === 1, 10000, 'the confirmation');
  });
  await check('old recordings and empty ones are not brought back', async () => {
    const ids = (await r1.api('/api/state')).body.calls.map((c) => c.id);
    assert.deepStrictEqual(ids, ['CAREC']);
  });
  await check('asking again brings nothing back twice', async () => {
    const res = await r1.api('/api/recover', 'POST');
    assert.strictEqual(res.body.recovered, 0, JSON.stringify(res.body));
  });
  await check('the Recordings list shows every recording Twilio holds, old ones too, and plays them', async () => {
    const res = await r1.api('/api/recordings', 'GET');
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    const ids = res.body.items.map((i) => i.callId);
    assert.ok(ids.includes('CAREC') && ids.includes('CAOLD'), ids.join(','));
    assert.ok(!ids.includes('CATINY'), 'empty recordings are left out');
    const first = res.body.items.find((i) => i.callId === 'CAREC');
    assert.strictEqual(first.outcome, 'Booked');
    const audio = await fetch('http://127.0.0.1:3204/api/recording-file/RE_book_en');
    assert.strictEqual(audio.status, 200);
    assert.strictEqual(audio.headers.get('content-type'), 'audio/mpeg');
  });
  await check('a call that already had its confirmation is not messaged again after another restart', async () => {
    const heard = counters.transcribe;
    const r2 = await startServer(3205, { AUTO_RECOVER: '1' });
    try {
      await until(async () => {
        const c = (await r2.api('/api/state')).body.calls.find((x) => x.id === 'CAREC');
        return c && c.analysis && c.analysis.status === 'done' ? c : null;
      }, 20000, 'the recovered call');
      await sleep(500);
      assert.strictEqual(toPatient(), 1);
      const c2 = (await r2.api('/api/state')).body.calls.find((x) => x.id === 'CAREC');
      assert.strictEqual(c2.analysis.outcome, 'Booked');
      assert.strictEqual(counters.transcribe, heard, 'a call staff already settled is not read by the AI again');
    } finally {
      r2.stop();
    }
  });
  r1.stop();

  console.log('Reminders');
  await check('tomorrow\'s bookings get a reminder, the day-after booking does not', async () => {
    const before = sent.length;
    const r = (await a.api('/api/reminders/run', 'POST')).body;
    // tomorrow, Booked, no reminder yet: CA_en, CA_nowa (fails: sandbox), CA_retry, CA_nm
    assert.strictEqual(r.date, tomorrow);
    assert.strictEqual(r.found, 8, JSON.stringify(r));
    assert.strictEqual(r.sent, 7);
    assert.strictEqual(r.failed, 1);
    const texts = sent.slice(before).map((m) => m.body);
    assert.ok(texts.every((t) => /Reminder from Basmati Dental Clinic/.test(t)), texts.join('\n'));
    assert.ok(!sent.slice(before).some((m) => m.to === 'whatsapp:+966552222222'), 'Arabic booking is for the day after');
    assert.ok(/^Sent /.test(rowOf('Appointments', 'CA_en')[9]));
    assert.ok(/^Failed .*sandbox/.test(rowOf('Appointments', 'CA_nowa')[9]));
    assert.ok(rowOf('Appointments', 'CA_ar')[9] === '' || rowOf('Appointments', 'CA_ar')[9] === undefined);
  });
  await check('a second run only retries the one that failed', async () => {
    const r = (await a.api('/api/reminders/run', 'POST')).body;
    assert.strictEqual(r.found, 1);
    assert.strictEqual(r.failed, 1);
  });
  await check('re-saving a booking keeps the reminder status already in the sheet', async () => {
    await a.api('/api/analyze/CA_en', 'POST');
    await sleep(300);
    await settled(a, 'CA_en');
    await sleep(500);
    assert.ok(/^Sent /.test(rowOf('Appointments', 'CA_en')[9]), String(rowOf('Appointments', 'CA_en')[9]));
  });
  await check('appointments are listed from the sheet in date and time order', async () => {
    const rows = (await a.api('/api/appointments?fresh=1')).body.rows;
    // empty days and times go last, the way Google Sheets sorts them
    const keys = rows.map((r) => (r.date || '9999') + ' ' + (r.time || '99:99'));
    assert.deepStrictEqual(keys, [...keys].sort());
    assert.ok(rows.find((r) => r.id === 'CA_ar'));
  });
  await check('sheet times typed by hand are read back as clean dates', async () => {
    const sh = fake.sheet('Appointments');
    const row = sh.data.findIndex((r) => r && r[0] === 'CA_ar') + 1;
    sh.data[row - 1][1] = new Date(`${dayAfter}T00:00:00+03:00`);
    sh.data[row - 1][2] = new Date('1970-01-01T08:30:00+03:00') // real Sheets uses 1899; Node's zone data has odd pre-1900 offsets, so the fake uses 1970;
    const out = fake.doPost(JSON.stringify({ secret: 'test-secret', action: 'listAppointments' })).rows.find((r) => r.id === 'CA_ar');
    assert.strictEqual(out.date, dayAfter);
    assert.strictEqual(out.time, '08:30');
    sh.data[row - 1][1] = dayAfter;
    sh.data[row - 1][2] = '11:00';
  });

  console.log('Demo number and test calls');
  const b = await startServer(3202, { DEMO_CUSTOMER_WHATSAPP: '+966599999999' });
  await check('demo number receives the patient messages instead of the caller', async () => {
    await simulateCall(b, 'CA_demo', '+966551234500', 'book_en');
    await settled(b, 'CA_demo');
    assert.strictEqual(to('+966551234500').length, 0);
    assert.strictEqual(to('+966599999999').length, 1);
    assert.strictEqual((await b.api('/api/state')).body.integrations.whatsapp.demoNumberEnd, '999');
  });
  await check('test call "Arabic booking" runs the whole chain', async () => {
    const before = to('+966599999999').length;
    assert.strictEqual((await b.api('/api/test-call?scenario=book_ar', 'POST')).status, 202);
    const call = await until(async () => {
      const c = (await b.api('/api/state')).body.calls.find((x) => x.test && x.analysis && x.analysis.status === 'done');
      const row = c && rowOf('Calls', c.id);
      return c && row && row[5] === 'Booked' && c.messages.length === 2 ? c : null;
    }, 40000, 'test call');
    assert.strictEqual(call.analysis.outcome, 'Booked');
    assert.ok(/تم حجز موعدك/.test(to('+966599999999')[before].body));
    assert.ok(/^TEST/.test(call.id));
    assert.ok(rowOf('Appointments', call.id));
    const t = (await b.api('/api/call/' + call.id)).body.transcript;
    assert.ok(/أبغى أحجز موعد/.test(t));
  });
  await check('removing test calls also clears them from the sheet', async () => {
    await b.api('/api/test-calls', 'DELETE');
    await until(() => !fake.sheet('Calls').data.some((r) => r && String(r[0]).startsWith('TEST')) &&
      !fake.sheet('Appointments').data.some((r) => r && String(r[0]).startsWith('TEST')), 8000, 'test rows gone');
    assert.ok(rowOf('Calls', 'CA_en'), 'real rows stay');
  });

  console.log('Dashboard page');
  await check('page is served and the transcript route answers', async () => {
    const html = await (await fetch('http://127.0.0.1:3201/')).text();
    assert.ok(/Appointments/.test(html) && /Transcript/.test(html));
  });

  a.stop();
  b.stop();
  mock.close();
  console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
  process.exit(failures ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
