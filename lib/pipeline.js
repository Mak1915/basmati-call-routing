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
    const rec = { to, kind, phone: phone || '', lang, at: now() };
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

  let recovering = null;
  function recover(hours = 48) {
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

  return { confirmBooking, analyzeCall, onRecording, onFinish, retry, recover, appointments, runReminders, startScheduler, ping, removeTestRows, status };
}

module.exports = { createPipeline };
