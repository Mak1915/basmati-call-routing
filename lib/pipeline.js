'use strict';

// What happens after a call: recording > transcript > booking details > Google Sheet > WhatsApp,
// plus the reminders for tomorrow's appointments.

const util = require('./util');
const messages = require('./messages');

const MIN_SECONDS = 8; // shorter recordings are failed attempts or just the "press 1" prompt
const MAX_AUDIO = 15 * 1024 * 1024;

function createPipeline(deps) {
  const { calls, users, config, save, ai, sheet, wa, env } = deps;
  const now = () => new Date().toISOString();
  const log = (what) => (err) => console.warn(`${what}:`, err && err.message ? err.message : err);
  const ctx = {
    clinicName: config.clinicName,
    clinicNameAr: config.clinicNameAr || '',
    clinicNumber: config.clinicNumber || '',
    sheetUrl: env.sheetLink || '',
  };
  const userName = (id) => (users.find((u) => u.id === id) || {}).name || '';
  const repPhone = () => util.normalizePhone(env.clinicRepWhatsApp);
  const demoPhone = () => util.normalizePhone(env.demoCustomerWhatsApp);

  // Sheet writes go one at a time, always built from the latest state of the call.
  let chain = Promise.resolve();
  function enqueue(fn) {
    const result = chain.then(fn);
    chain = result.catch(() => {});
    return result;
  }

  let apptCache = { at: 0, data: null };

  function recordingLink(call) {
    if (!env.publicUrl) return '';
    if (call.recording && call.recording.url) return `${env.publicUrl}/api/recording/${encodeURIComponent(call.id)}/call`;
    if (call.voicemail && call.voicemail.url) return `${env.publicUrl}/api/recording/${encodeURIComponent(call.id)}/voicemail`;
    return '';
  }

  function outcomeOf(call) {
    const a = call.analysis;
    if (a && a.status === 'done') return a.outcome;
    if (a && a.status === 'failed') return 'Needs review';
    if (call.answeredBy && !config.recordCalls) return 'Answered';
    if (call.answeredBy || call.voicemail) return 'Analyzing';
    return call.endedAt ? 'Missed call' : 'In progress';
  }

  function confirmationText(call) {
    const last = (to) => [...(call.messages || [])].reverse().find((m) => m.to === to && m.kind !== 'reminder');
    const part = (label, m) => (m ? `${label}: ${m.ok ? 'sent' : 'failed (' + String(m.error).slice(0, 90) + ')'}` : null);
    return [part('Patient', last('customer')), part('Clinic', last('clinic'))].filter(Boolean).join(' / ');
  }

  function rowsFor(call) {
    // results from this analysis or from an earlier one (kept while a call is being looked at again)
    const a = call.analysis && call.analysis.outcome ? call.analysis : null;
    const failed = call.analysis && call.analysis.status === 'failed' ? call.analysis : null;
    const outcome = outcomeOf(call);
    const callRow = {
      id: call.id,
      received: util.stamp(Date.parse(call.startedAt)),
      caller: (call.test ? '(test) ' : '') + (call.from || 'Hidden number'),
      answeredBy: userName(call.answeredBy),
      language: a ? (a.language === 'ar' ? 'Arabic' : 'English') : '',
      outcome,
      patient: a ? a.patientName : '',
      patientPhone: a ? a.patientPhone : '',
      date: a ? a.date : '',
      time: a ? a.time : '',
      treatment: a ? a.treatment : '',
      summary: failed ? 'Could not analyse this call: ' + failed.error : a ? a.summary : '',
      transcript: ((a || failed || {}).transcript || '').slice(0, 40000),
      recording: recordingLink(call),
    };
    // undefined: leave the Appointments tab alone. null: this call has no appointment. Object: write it.
    let appointmentRow;
    if (call.analysis && call.analysis.status === 'done') appointmentRow = null;
    if (appointmentRow === null && (a.outcome === 'Booked' || a.outcome === 'Needs review') && (a.booked || a.wantsAppointment)) {
      appointmentRow = {
        id: call.id,
        date: a.date,
        time: a.time,
        patient: a.patientName,
        phone: util.normalizePhone(a.patientPhone) || (!call.test && util.normalizePhone(call.from)) || '',
        treatment: a.treatment,
        status: a.outcome,
        language: callRow.language,
        confirmation: confirmationText(call),
        notes: a.reviewReason || a.notes,
      };
    }
    // Staff said "not a booking": keep a Cancelled row, so the decision is still in the sheet after a restart.
    if (appointmentRow === null && a && a.staffEdited && a.outcome === 'Not booked') {
      appointmentRow = {
        id: call.id, date: '', time: '', patient: a.patientName, phone: util.normalizePhone(a.patientPhone) || '', treatment: a.treatment,
        status: 'Cancelled', language: callRow.language, confirmation: confirmationText(call), notes: 'Marked as not a booking by staff',
      };
    }
    return { callRow, appointmentRow };
  }

  function publishRow(call) {
    if (!sheet.configured) return Promise.resolve();
    return enqueue(async () => {
      const { callRow, appointmentRow } = rowsFor(call);
      await sheet.upsertCall(callRow, appointmentRow);
      apptCache = { at: 0, data: null };
    }).catch(log('Sheet write failed'));
  }

  function finalize(r) {
    const date = util.isYmd(r.date) ? r.date : '';
    const time = util.normalizeTime(r.time);
    const out = { ...r, date, time };
    let outcome;
    let reason = '';
    if (r.booked) {
      const when = date && time ? Date.parse(`${date}T${time}:00${util.OFFSET}`) : NaN;
      if (!date || !time) reason = 'A booking was mentioned but the day or time is not clear.';
      else if (when < Date.now() - 30 * 60000) reason = 'The booked day and time look like they are in the past.';
      else if (r.confidence === 'low') reason = 'The AI is not sure it heard the day or time correctly.';
      outcome = reason ? 'Needs review' : 'Booked';
    } else if (r.wantsAppointment) {
      outcome = 'Needs review';
      reason = 'The caller wants an appointment but none was confirmed.';
    } else {
      outcome = 'Not booked';
      out.date = '';
      out.time = '';
    }
    out.outcome = outcome;
    out.reviewReason = reason;
    return out;
  }

  async function downloadAudio(recUrl) {
    let u;
    try {
      u = new URL(recUrl);
    } catch {
      throw new Error('The recording address is not valid.');
    }
    if (u.protocol !== 'https:' || !/(^|\.)twilio\.com$/.test(u.hostname)) throw new Error('The recording is not stored at Twilio.');
    if (!env.twilioSid || !env.twilioToken) throw new Error('Add TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN so recordings can be downloaded.');
    const target = (env.twilioBase || 'https://api.twilio.com').replace(/\/+$/, '') + u.pathname.replace(/\.(mp3|wav)$/, '') + '.mp3';
    const res = await fetch(target, {
      headers: { Authorization: 'Basic ' + Buffer.from(`${env.twilioSid}:${env.twilioToken}`).toString('base64') },
      signal: AbortSignal.timeout(60000),
    });
    if (!res.ok) throw new Error(`Twilio answered ${res.status} for the recording.`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_AUDIO) throw new Error('The recording is too long to analyse in the demo.');
    return buf;
  }

  function customerPhone(call, a) {
    if (env.demoCustomerWhatsApp) return demoPhone();
    if (!call.test) {
      const fromCaller = util.normalizePhone(call.from);
      if (fromCaller) return fromCaller;
    }
    return util.normalizePhone(a.patientPhone);
  }

  async function sendMsg(call, to, kind, phone, body, lang) {
    const rec = { to, kind, phone: phone || '', lang, at: now(), body: String(body || '').slice(0, 1500) };
    if (!phone) {
      rec.ok = false;
      rec.error = to === 'clinic' ? 'No clinic WhatsApp number is set (CLINIC_REP_WHATSAPP).' : 'No phone number for this patient.';
    } else {
      Object.assign(rec, await wa.send(phone, body));
    }
    (call.messages = call.messages || []).push(rec);
    save();
    return rec;
  }

  async function notify(call) {
    const a = call.analysis;
    if (a.outcome !== 'Booked' && a.outcome !== 'Needs review') return;
    if (call.notified === a.outcome) return;
    const data = {
      name: a.patientName,
      phone: util.normalizePhone(a.patientPhone) || (!call.test && util.normalizePhone(call.from)) || '',
      date: a.date,
      time: a.time,
      treatment: a.treatment,
      summary: a.summary,
      takenBy: userName(call.answeredBy) || (call.voicemail ? 'Voicemail' : ''),
      reason: a.reviewReason,
    };
    if (a.outcome === 'Booked') {
      const m = await sendMsg(call, 'customer', 'booking', customerPhone(call, a), messages.customerBooking(ctx, data, a.language), a.language);
      data.patientNotice = m.ok ? 'sent' : 'NOT sent (' + m.error + ')';
      await sendMsg(call, 'clinic', 'booking', repPhone(), messages.repBooking(ctx, data), 'en');
    } else {
      await sendMsg(call, 'clinic', 'review', repPhone(), messages.repReview(ctx, data), 'en');
    }
    call.notified = a.outcome;
    save();
  }

  // A busy AI service usually recovers within minutes: try again by itself, a few times, with growing pauses.
  function scheduleRetry(call, source, err) {
    if (!err || !err.transient || call.test) return;
    const n = call.autoRetries || 0;
    if (n >= 3) return;
    call.autoRetries = n + 1;
    const wait = env.autoRetryMs != null ? env.autoRetryMs : 60000 * (n + 1);
    const t = setTimeout(() => analyzeCall(call, source).catch(log('Analysis retry failed')), wait);
    if (t.unref) t.unref();
  }

  async function analyzeCall(call, source, opts = {}) {
    // A run that has been going for over 4 minutes is stuck: let a new one start.
    if (call.analysis && call.analysis.status === 'working' && Date.now() - Date.parse(call.analysis.startedAt || 0) < 240000) return;
    const previous = call.analysis && call.analysis.outcome ? call.analysis : {};
    call.analysis = { ...previous, status: 'working', source, startedAt: now(), error: '' };
    save();
    publishRow(call);
    try {
      let result;
      if (opts.fixture) {
        result = opts.fixture;
        call.analysis.model = 'test';
      } else {
        const rec = source === 'voicemail' ? call.voicemail : call.recording;
        if (!rec || !rec.url) throw new Error('There is no recording to analyse.');
        if (rec.seconds < MIN_SECONDS) {
          result = {
            language: 'en', summary: 'The call was too short to analyse.', wantsAppointment: false, booked: false, patientName: '',
            patientPhone: '', date: '', time: '', treatment: '', confidence: 'high', notes: '', transcript: '',
          };
        } else {
          if (!ai.configured) throw new Error('GEMINI_API_KEY is not set, so calls are recorded but not transcribed yet.');
          const audio = await downloadAudio(rec.url);
          const today = util.todayYmd();
          console.log(`[ai] analysing ${call.id || ''} (${Math.round(audio.length / 1024)} KB audio)`);
          let timer;
          const cap = new Promise((_, reject) => {
            timer = setTimeout(() => reject(Object.assign(new Error('The AI took too long to answer. Press Try again.'), { transient: true })), 200000);
          });
          try {
            result = await Promise.race([ai.analyze(audio, { clinicName: config.clinicName, today, weekday: util.weekdayOf(today) }, { onTranscript: (t) => { call.analysis.transcript = t; save(); } }), cap]);
          } finally {
            clearTimeout(timer);
          }
          call.analysis.model = ai.model;
        }
      }
      call.analysis = { ...call.analysis, ...finalize(result), status: 'done', at: now() };
    } catch (err) {
      call.analysis = { ...call.analysis, status: 'failed', error: String(err.message || err).slice(0, 300), at: now() };
      if (err.transcript) call.analysis.transcript = err.transcript;
      scheduleRetry(call, source, err);
    }
    save();
    if (call.analysis.status === 'done') {
      try {
        await notify(call);
      } catch (err) {
        log('Notifying failed')(err);
      }
    }
    await publishRow(call);
  }

  /**
   * Staff fix a call from the dashboard. `f` = { action: 'book' | 'notbooked', patientName, patientPhone, date, time, treatment }.
   * 'book' makes it a confirmed booking (sheet row, patient and clinic messages); 'notbooked' clears the appointment.
   */
  async function confirmBooking(callId, f = {}) {
    const call = calls.get(callId);
    if (!call || !call.analysis || call.analysis.status !== 'done') throw new Error('This call has not been analysed yet.');
    const a = call.analysis;
    if (f.action === 'notbooked') {
      call.analysis = { ...a, booked: false, wantsAppointment: false, outcome: 'Not booked', reviewReason: '', date: '', time: '', staffEdited: now() };
    } else {
      const date = String(f.date || '').trim();
      const time = util.normalizeTime(f.time);
      if (!util.isYmd(date)) throw new Error('Pick the appointment day.');
      if (!time) throw new Error('Pick the appointment time.');
      if (Date.parse(`${date}T${time}:00${util.OFFSET}`) < Date.now() - 30 * 60000) throw new Error('That day and time are in the past.');
      const name = String(f.patientName || '').trim().slice(0, 80);
      if (!name) throw new Error('Write the patient name.');
      const phone = String(f.patientPhone || '').trim().slice(0, 30);
      if (phone && !util.normalizePhone(phone)) throw new Error('The phone number does not look right. Use +966... or 05...');
      call.analysis = {
        ...a, booked: true, wantsAppointment: true, outcome: 'Booked', reviewReason: '', confidence: 'high',
        patientName: name, patientPhone: phone || a.patientPhone || '', date, time,
        treatment: String(f.treatment || '').trim().slice(0, 80), staffEdited: now(),
      };
    }
    save();
    await publishRow(call);
    try {
      await notify(call);
    } catch (err) {
      log('Notifying failed')(err);
    }
    save();
    await publishRow(call);
    return { outcome: call.analysis.outcome };
  }

  /** Staff change a booking from the Appointments list. Works for rows whose call is gone after a restart too. */
  async function editAppointment(id, f = {}) {
    const date = String(f.date || '').trim();
    const time = util.normalizeTime(f.time);
    if (!util.isYmd(date)) throw new Error('Pick the appointment day.');
    if (!time) throw new Error('Pick the appointment time.');
    const patient = String(f.patient || '').trim().slice(0, 80);
    if (!patient) throw new Error('Write the patient name.');
    const phone = String(f.phone || '').trim().slice(0, 30);
    const normalized = phone ? util.normalizePhone(phone) : '';
    if (phone && !normalized) throw new Error('The phone number does not look right. Use +966... or 05...');
    const treatment = String(f.treatment || '').trim().slice(0, 80);
    const doctor = String(f.doctor || '').trim().slice(0, 60);
    const call = calls.get(id);
    if (call && call.analysis && call.analysis.status === 'done') {
      Object.assign(call.analysis, { patientName: patient, patientPhone: phone, date, time, treatment, staffEdited: now() });
      save();
    }
    await enqueue(() => sheet.updateAppointment(id, { date, time, patient, phone: normalized || phone, treatment, doctor }));
    apptCache = { at: 0, data: null };
    return { ok: true };
  }

  /** Staff add a booking by hand from the Appointments list (for example a patient who walked in or phoned a staff mobile). */
  async function addAppointment(f = {}) {
    if (!sheet.configured) throw new Error('The Google Sheet is not connected.');
    const date = String(f.date || '').trim();
    const time = util.normalizeTime(f.time);
    if (!util.isYmd(date)) throw new Error('Pick the appointment day.');
    if (!time) throw new Error('Pick the appointment time.');
    const patient = String(f.patient || '').trim().slice(0, 80);
    if (!patient) throw new Error('Write the patient name.');
    const phone = String(f.phone || '').trim().slice(0, 30);
    const normalized = phone ? util.normalizePhone(phone) : '';
    if (phone && !normalized) throw new Error('The phone number does not look right. Use +966... or 05...');
    const id = 'MAN-' + Date.now().toString(36).toUpperCase();
    await enqueue(() => sheet.upsertAppointment({
      id, date, time, patient, phone: normalized || phone,
      treatment: String(f.treatment || '').trim().slice(0, 80),
      doctor: String(f.doctor || '').trim().slice(0, 60),
      status: 'Booked', language: '', notes: 'Added by staff',
    }));
    apptCache = { at: 0, data: null };
    return { ok: true, id };
  }

  /** Staff note how the patient answered the confirmation / reminder. */
  async function setReply(id, f = {}) {
    const reply = ['Approved', 'Not approved', 'Not responded', ''].includes(f.reply) ? f.reply : null;
    if (reply === null) throw new Error('Pick Approved, Not approved or Not responded.');
    await enqueue(() => sheet.updateAppointment(id, { reply }));
    apptCache = { at: 0, data: null };
    return { ok: true };
  }

  async function removeAppointment(id) {
    const call = calls.get(id);
    if (call && call.analysis && call.analysis.status === 'done') return confirmBooking(id, { action: 'notbooked' });
    await enqueue(async () => {
      try {
        await sheet.deleteAppointment(id);
      } catch (err) {
        if (!/Unknown action/i.test(err.message)) throw err;
        await sheet.updateAppointment(id, { status: 'Cancelled' }); // an older sheet script cannot delete rows
      }
    });
    apptCache = { at: 0, data: null };
    return { ok: true };
  }

  const onRecording = (call, kind) => analyzeCall(call, kind === 'voicemail' ? 'voicemail' : 'call').catch(log('Analysis failed'));
  const onFinish = (call) => publishRow(call);

  function retry(callId) {
    const call = calls.get(callId);
    if (!call) throw new Error('Unknown call.');
    const source = call.voicemail && !call.answeredBy ? 'voicemail' : 'call';
    return analyzeCall(call, source);
  }

  async function appointments(force) {
    if (!sheet.configured) return { configured: false, rows: [] };
    if (!force && apptCache.data && Date.now() - apptCache.at < 10000) return apptCache.data;
    const { rows } = await sheet.listAppointments();
    apptCache = { at: Date.now(), data: { configured: true, rows } };
    return apptCache.data;
  }

  async function runReminders() {
    if (!sheet.configured) throw new Error('The Google Sheet is not connected yet.');
    if (!wa.configured) throw new Error('WhatsApp is not set up yet.');
    const date = util.tomorrowYmd();
    const { rows } = await sheet.listAppointments();
    const due = rows.filter((r) => r.date === date && r.status === 'Booked' && !/^sent/i.test(r.reminder || ''));
    const out = { date, found: due.length, sent: 0, failed: 0, details: [] };
    for (const r of due) {
      const lang = /arab/i.test(r.language) ? 'ar' : 'en';
      const phone = env.demoCustomerWhatsApp ? demoPhone() : util.normalizePhone(r.phone);
      const res = phone
        ? await wa.send(phone, messages.customerReminder(ctx, { name: r.patient, date: r.date, time: r.time }, lang))
        : { ok: false, error: 'No phone number in the sheet row.' };
      const when = util.stamp(Date.now());
      await sheet.updateAppointment(r.id, { reminder: res.ok ? `Sent ${when}` : `Failed ${when}: ${res.error}`.slice(0, 150) });
      const call = calls.get(r.id);
      if (call) {
        (call.messages = call.messages || []).push({ to: 'customer', kind: 'reminder', phone: phone || '', lang, ok: res.ok, error: res.error || '', at: now() });
        save();
      }
      if (res.ok) out.sent++;
      else out.failed++;
      out.details.push({ id: r.id, patient: r.patient, ok: res.ok, error: res.error || '' });
    }
    apptCache = { at: 0, data: null };
    return out;
  }

  // ---- bringing calls back after a restart
  // The free host forgets its call list when it restarts. The recordings stay at Twilio, so the
  // calls can be rebuilt from there and analysed again. Nobody is messaged twice: if the sheet
  // already shows a confirmation for the call, it is not sent again.
  async function twilioGet(pathAndQuery) {
    if (!env.twilioSid || !env.twilioToken) throw new Error('Add TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN to bring calls back from Twilio.');
    const base = (env.twilioBase || 'https://api.twilio.com').replace(/\/+$/, '');
    const res = await fetch(base + pathAndQuery, {
      headers: { Authorization: 'Basic ' + Buffer.from(`${env.twilioSid}:${env.twilioToken}`).toString('base64') },
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) throw new Error(`Twilio answered ${res.status}.`);
    return res.json();
  }

  let recCache = { at: 0, data: null };
  /** Every recording Twilio still holds, newest first, with the caller and what became of the call where we know it. */
  async function listRecordings(force) {
    if (!force && recCache.data && Date.now() - recCache.at < 20000) return recCache.data;
    const acct = `/2010-04-01/Accounts/${encodeURIComponent(env.twilioSid || '')}`;
    const list = await twilioGet(`${acct}/Recordings.json?PageSize=100`);
    let info = new Map();
    const patientOf = new Map(); // outgoing: parent call sid -> number that was dialled
    try {
      const cl = await twilioGet(`${acct}/Calls.json?PageSize=100`);
      info = new Map((cl.calls || []).map((c) => [c.sid, c]));
      for (const c of cl.calls || []) if (c.parent_call_sid) patientOf.set(c.parent_call_sid, c.to);
    } catch (err) {
      log('Could not read the call list from Twilio')(err);
    }
    let rows = [];
    try {
      rows = (await appointments()).rows || [];
    } catch {
      // the list still works without the sheet
    }
    const items = [];
    for (const r of list.recordings || []) {
      const seconds = Number(r.duration) || 0;
      if (!r.call_sid || (r.status && r.status !== 'completed') || seconds < 1) continue;
      const call = calls.get(r.call_sid);
      const c = info.get(r.call_sid) || {};
      const row = rows.find((x) => x.id === r.call_sid);
      const outgoing = /^outbound/.test(c.direction || '');
      items.push({
        id: r.sid,
        direction: outgoing ? 'outgoing' : 'incoming',
        callId: r.call_sid,
        kind: r.source === 'RecordVerb' ? 'voicemail' : 'call',
        at: r.date_created ? new Date(r.date_created).toISOString() : '',
        seconds,
        from: outgoing ? patientOf.get(r.call_sid) || c.to || '' : (call && call.from) || c.from || '',
        outcome: call && call.analysis && call.analysis.outcome ? call.analysis.outcome : row ? (row.status === 'Cancelled' ? 'Not booked' : row.status) : '',
        patient: (call && call.analysis && call.analysis.patientName) || (row && row.patient) || '',
        hasTranscript: Boolean(call && call.analysis && call.analysis.transcript),
      });
    }
    items.sort((a, b) => (a.at < b.at ? 1 : -1));
    recCache = { at: Date.now(), data: { items } };
    return recCache.data;
  }

  // Transcripts of calls staff made. Kept in memory and written to the Calls tab, so they survive a restart.
  const outgoing = new Map();
  const outgoingTranscript = (id) => (outgoing.get(id) || {}).transcript || '';
  async function transcribeOutgoing(o) {
    if (!o.id || !o.url || o.seconds < MIN_SECONDS || outgoing.has(o.id)) return;
    if (!ai.configured) throw new Error('GEMINI_API_KEY is not set.');
    outgoing.set(o.id, { transcript: '' });
    try {
      const audio = await downloadAudio(o.url);
      const today = util.todayYmd();
      const out = await ai.analyze(audio, { clinicName: config.clinicName, today, weekday: util.weekdayOf(today) });
      outgoing.set(o.id, { transcript: out.transcript || '', summary: out.summary || '' });
      if (sheet.configured) await enqueue(() => sheet.upsertCall({
        id: o.id, received: util.stamp(Date.now()), caller: '(outgoing) ' + (o.staff || 'staff'), answeredBy: o.staff || '',
        language: out.language === 'ar' ? 'Arabic' : 'English', outcome: 'Outgoing call', patient: '', patientPhone: o.patient || '',
        date: '', time: '', treatment: '', summary: out.summary || '', transcript: String(out.transcript || '').slice(0, 40000), recording: '',
      }));
    } catch (err) {
      outgoing.delete(o.id); // allow another try
      throw err;
    }
  }

  /** Calls staff made from the dashboard, newest first, with the recording when there is one. */
  async function listOutgoing() {
    const acct = `/2010-04-01/Accounts/${encodeURIComponent(env.twilioSid || '')}`;
    const [cl, rl] = await Promise.all([twilioGet(`${acct}/Calls.json?PageSize=100`), twilioGet(`${acct}/Recordings.json?PageSize=100`)]);
    const all = cl.calls || [];
    const child = new Map(all.filter((c) => c.parent_call_sid).map((c) => [c.parent_call_sid, c]));
    const recOf = new Map();
    for (const r of rl.recordings || []) if (r.call_sid && (!r.status || r.status === 'completed') && Number(r.duration) >= 1 && !recOf.has(r.call_sid)) recOf.set(r.call_sid, r);
    const items = all.filter((c) => /^outbound-api/.test(c.direction || '') && !c.parent_call_sid).map((c) => {
      const leg = child.get(c.sid);
      const rec = recOf.get(c.sid);
      const talked = leg && leg.status === 'completed' ? Number(leg.duration) || 0 : 0;
      const status = !leg ? (c.status === 'completed' ? 'Staff phone answered, patient not dialled' : 'Staff did not pick up') : leg.status === 'completed' ? 'Talked' : leg.status === 'no-answer' ? 'Patient did not answer' : leg.status === 'busy' ? 'Patient busy' : leg.status === 'canceled' ? 'Cancelled' : leg.status === 'failed' ? 'Failed' : leg.status;
      return {
        id: c.sid,
        at: c.start_time || c.date_created ? new Date(c.start_time || c.date_created).toISOString() : '',
        patient: (leg && leg.to) || '',
        staff: c.to || '',
        shown: (leg && leg.from) || c.from || '',
        status,
        seconds: talked,
        recordingId: rec ? rec.sid : '',
      };
    });
    items.sort((a, b) => (a.at < b.at ? 1 : -1));
    return { items };
  }

  let recovering = null;
  // Only calls from the last RECOVER_MINUTES (default 30) are brought back, so a restart never reopens older calls.
  function recover(hours = (Number(process.env.RECOVER_MINUTES) || 30) / 60) {
    if (!recovering) recovering = doRecover(hours).finally(() => { recovering = null; });
    return recovering;
  }

  async function doRecover(hours) {
    const acct = `/2010-04-01/Accounts/${encodeURIComponent(env.twilioSid || '')}`;
    const list = await twilioGet(`${acct}/Recordings.json?PageSize=100`);
    const cutoff = Date.now() - hours * 3600 * 1000;
    const byCall = new Map();
    for (const r of list.recordings || []) {
      const created = Date.parse(r.date_created);
      const seconds = Number(r.duration) || 0;
      if (!r.call_sid || calls.has(r.call_sid) || (r.status && r.status !== 'completed') || seconds < 1 || !(created >= cutoff)) continue;
      const kind = r.source === 'RecordVerb' ? 'voicemail' : 'call';
      const entry = byCall.get(r.call_sid) || {};
      if (!entry[kind] || entry[kind].seconds < seconds) {
        entry[kind] = { sid: r.sid, url: 'https://api.twilio.com' + String(r.uri || '').replace(/\.json$/, ''), seconds, created };
      }
      byCall.set(r.call_sid, entry);
    }

    let sheetRows = [];
    if (sheet.configured && byCall.size) {
      try {
        sheetRows = (await sheet.listAppointments()).rows || [];
      } catch (err) {
        log('Could not read the sheet before recovering')(err);
      }
    }

    const out = { found: byCall.size, recovered: 0 };
    for (const [sid, rec] of byCall) {
      let info = {};
      try {
        info = await twilioGet(`${acct}/Calls/${encodeURIComponent(sid)}.json`);
      } catch (err) {
        log('Could not read call ' + sid)(err);
      }
      if (/^outbound/.test(info.direction || '')) { out.found--; continue; } // staff-made calls are not patient bookings
      const first = rec.call || rec.voicemail;
      const started = Date.parse(info.start_time) || first.created - first.seconds * 1000;
      const answeredBy = rec.call && users[0] ? users[0].id : null;
      const call = {
        id: sid,
        from: info.from || '',
        to: info.to || '',
        fromCountry: '',
        startedAt: new Date(started).toISOString(),
        endedAt: new Date(Math.max(started, first.created)).toISOString(),
        answeredBy,
        answeredAt: rec.call ? new Date(first.created - rec.call.seconds * 1000).toISOString() : null,
        talkSeconds: rec.call ? rec.call.seconds : null,
        totalSeconds: Number(info.duration) || null,
        steps: answeredBy ? [{ target: answeredBy, group: 0, startedAt: new Date(started).toISOString(), endedAt: new Date(first.created).toISOString(), result: 'answered', note: 'Brought back from Twilio: who answered is a guess' }] : [],
        recording: rec.call || null,
        voicemail: rec.voicemail || null,
        test: false,
        analysis: null,
        messages: [],
        notified: null,
      };
      const row = sheetRows.find((r) => r.id === sid);
      if (row && row.confirmation) call.notified = row.status;
      calls.set(sid, call);
      if (row && (row.status === 'Booked' || row.status === 'Cancelled')) {
        const booked = row.status === 'Booked';
        call.analysis = {
          status: 'done', outcome: booked ? 'Booked' : 'Not booked', language: row.language === 'Arabic' ? 'ar' : 'en',
          summary: booked ? 'Booking confirmed earlier. Brought back from the Google Sheet. The transcript is not kept after a restart: press Try again to read the call again.' : 'Marked as not a booking earlier.',
          wantsAppointment: booked, booked, patientName: row.patient || '', patientPhone: row.phone || '', date: booked ? row.date || '' : '', time: booked ? row.time || '' : '',
          treatment: row.treatment || '', confidence: 'high', reviewReason: '', notes: '', transcript: '', staffEdited: now(), at: now(),
        };
        if (booked) call.notified = 'Booked';
        save();
        out.recovered++;
        continue;
      }
      save();
      out.recovered++;
      await analyzeCall(call, rec.call ? 'call' : 'voicemail');
    }
    return out;
  }

  function startScheduler() {
    if (!env.autoReminders) return;
    let lastDay = '';
    setInterval(async () => {
      if (!sheet.configured || !wa.configured) return;
      const today = util.todayYmd();
      if (util.hourNow() !== config.reminderHour || lastDay === today) return;
      lastDay = today;
      try {
        const r = await runReminders();
        console.log(`Reminders for ${r.date}: ${r.sent} sent, ${r.failed} failed.`);
      } catch (err) {
        log('Reminders failed')(err);
      }
    }, 60000).unref();
  }

  const ping = () => (sheet.configured ? sheet.ping().catch(log('Sheet check failed')) : Promise.resolve());

  async function removeTestRows() {
    if (!sheet.configured) return;
    await enqueue(() => sheet.deleteTest());
    apptCache = { at: 0, data: null };
  }

  function status() {
    return {
      sheet: { configured: sheet.configured, ok: sheet.state.ok, error: sheet.state.error },
      whatsapp: {
        configured: wa.configured,
        clinicNumberSet: Boolean(repPhone()),
        demoNumberEnd: env.demoCustomerWhatsApp ? String(demoPhone() || '').slice(-3) : '',
      },
      transcription: { configured: ai.configured },
      autoReminders: Boolean(env.autoReminders),
      reminderHour: config.reminderHour,
    };
  }

  return { listRecordings, listOutgoing, transcribeOutgoing, outgoingTranscript, addAppointment, setReply, editAppointment, removeAppointment, confirmBooking, analyzeCall, onRecording, onFinish, retry, recover, appointments, runReminders, startScheduler, ping, removeTestRows, status };
}

module.exports = { createPipeline };
