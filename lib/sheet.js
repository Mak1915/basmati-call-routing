'use strict';

// Talks to the Google Sheet through a small Google Apps Script web app
// (see apps-script/Code.gs). Calls throw an Error with a plain-language message.

function createSheet(opts) {
  const url = opts.url || '';
  const secret = opts.secret || '';
  const configured = Boolean(url && secret);
  const state = { ok: null, error: '', at: null };

  function fail(message) {
    state.ok = false;
    state.error = message;
    state.at = new Date().toISOString();
    throw new Error(message);
  }

  async function call(payload) {
    if (!configured) throw new Error('The Google Sheet is not connected yet.');
    let text;
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify({ secret, ...payload }),
        redirect: 'follow',
        signal: AbortSignal.timeout(45000),
      });
      text = await res.text();
    } catch (err) {
      fail('Could not reach the Google Sheet script: ' + err.message);
    }
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      fail('The sheet script did not answer properly. In Apps Script, deploy it as a Web app with access set to "Anyone".');
    }
    if (!data.ok) fail(data.error || 'The sheet script reported an error.');
    state.ok = true;
    state.error = '';
    state.at = new Date().toISOString();
    return data;
  }

  return {
    configured,
    state,
    ping: () => call({ action: 'ping' }),
    // appointment: left out = leave that tab alone, null = remove the row, object = write it
    upsertCall: (callRow, appointment) => call({ action: 'upsertCall', call: callRow, appointment }),
    upsertAppointment: (appointment) => call({ action: 'upsertAppointment', appointment }),
    listAppointments: () => call({ action: 'listAppointments' }),
    listTranscripts: () => call({ action: 'listTranscripts' }),
    updateAppointment: (id, fields) => call({ action: 'updateAppointment', id, fields }),
    deleteAppointment: (id) => call({ action: 'deleteAppointment', id }),
    deleteTest: () => call({ action: 'deleteTest' }),
  };
}

module.exports = { createSheet };
