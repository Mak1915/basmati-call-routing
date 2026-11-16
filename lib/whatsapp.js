'use strict';

// Sends WhatsApp messages through Twilio. For the demo this is the Twilio WhatsApp sandbox.
// Never throws: always returns { ok, sid?, error? } so one failed message cannot stop the rest.

function explain(code, message, status) {
  switch (Number(code)) {
    case 63015:
      return 'This phone has not joined the Twilio WhatsApp sandbox yet. On that phone, send the join code to the sandbox number first.';
    case 63016:
      return 'WhatsApp only allows free text within 24 hours of the person\'s last message. A live system needs an approved template for this.';
    case 63007:
    case 63003:
      return 'The WhatsApp sender is not set up correctly. Check TWILIO_WHATSAPP_FROM.';
    case 21211:
    case 21614:
      return 'This is not a valid mobile number.';
    case 20003:
      return 'Twilio login failed. Check TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN.';
    default:
      return `Twilio said: ${message || 'HTTP ' + status}`.slice(0, 220);
  }
}

function createWhatsApp(opts) {
  const sid = opts.sid || '';
  const token = opts.token || '';
  const from = opts.from ? '+' + String(opts.from).replace(/^whatsapp:/i, '').replace(/\D/g, '') : '';
  const base = (opts.base || 'https://api.twilio.com').replace(/\/+$/, '');
  const configured = Boolean(sid && token && from.length > 6);

  async function send(toPhone, body) {
    if (!configured) return { ok: false, error: 'WhatsApp is not set up yet.' };
    try {
      const form = new URLSearchParams({
        From: `whatsapp:${from}`,
        To: `whatsapp:${toPhone}`,
        Body: String(body).slice(0, 1500),
      });
      const res = await fetch(`${base}/2010-04-01/Accounts/${encodeURIComponent(sid)}/Messages.json`, {
        method: 'POST',
        headers: {
          Authorization: 'Basic ' + Buffer.from(`${sid}:${token}`).toString('base64'),
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: form,
        signal: AbortSignal.timeout(20000),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) return { ok: true, sid: data.sid || null };
      return { ok: false, error: explain(data.code, data.message, res.status) };
    } catch (err) {
      return { ok: false, error: 'Could not reach Twilio: ' + err.message };
    }
  }

  return { configured, from, send };
}

module.exports = { createWhatsApp };
