# Basmati Dental Clinic: call routing demo

A caller rings one clinic number. The call is offered to four people in order.
Anyone who is busy or does not pick up within 15 seconds is skipped. If nobody
takes it, the caller leaves a voicemail. Answered calls and voicemails are
recorded, and every call shows up on a dashboard with the path it took.

Plain Node.js (18 or newer), no npm packages.

## 1. See it working without a phone (2 minutes)

```
cp .env.example .env
node server.js
```

Open http://localhost:3000 and press **Run test call**. Test calls walk a
made-up call through the real routing code. No phone rings and there is no audio.
Run two test calls at the same time to see a person who is already on a call
being skipped.

## 2. Put your people in

Edit `config.json`:

- `users`: the four people, in the order they should be rung. Phone numbers in
  `+9665XXXXXXXX` format. The numbers in the file are placeholders.
- `ringSeconds`: how long each person rings before the call moves on.
- `screenCalls`: when `true`, the person who picks up hears "Press 1 to accept".
  This stops a mobile voicemail or a pocket-answer from swallowing the call.
  Set to `false` if you want the call to connect the moment they pick up.
- `recordCalls`, `greeting`, `voicemailPrompt`: as named. The greeting tells the
  caller the call may be recorded. Keep that sentence.
- `clinicNumber`: the Twilio number, shown at the top of the dashboard.

Restart the server after changing the file.

## 3. Connect a real number (Twilio)

1. Create a Twilio account and buy a voice number. A UK or US number is fine
   for the demo.
2. The server needs a public https address. Either deploy it (Render, Railway,
   a VPS) or, for a quick test from a laptop, run a tunnel such as
   `ngrok http 3000`.
3. Fill in `.env`: `PUBLIC_URL` (the https address, no slash at the end),
   `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, and a `DASHBOARD_PASSWORD`.
4. In the Twilio console, open the number and set:
   - **A call comes in**: Webhook, `POST`, `https://YOUR-ADDRESS/twilio/voice`
   - **Call status changes**: `POST`, `https://YOUR-ADDRESS/twilio/status`
5. Call the Twilio number.

Check these in the Twilio console before the demo, they are the usual reasons
a first call fails:

- **Trial accounts** can only ring numbers you have verified, and play a trial
  message first. Verify all four phones, or upgrade the account.
- **Voice geographic permissions**: calling Saudi Arabia must be switched on.
- **Recordings**: if the account requires login for recording files, that is
  fine, the dashboard fetches them with your credentials.

## 4. Showing it to the client

1. Put four phones on the table, dashboard on a screen.
2. Call the number. Phone 1 rings. Leave it. After 15 seconds phone 2 rings.
3. Reject on phone 2. Phone 3 rings. Pick up, press 1, talk for a few seconds.
4. Hang up. Open the call on the dashboard: the path, then the recording
   (it appears within about a minute).
5. Call again and let all four ring out. Leave a voicemail. Play it back.
6. Call from two phones at once to show a busy person being skipped.

## What this demo is not

- The demo number is foreign. For the real system the clinic's own Saudi
  numbers go through a CST-licensed provider, in the clinic's name.
- Only calls that come in on the clinic number are routed and recorded. A call
  made straight to someone's personal mobile never passes through here.
- Calls are stored in `data/calls.json`. Fine for a demo. A production version
  should use a database and a retention rule for recordings.
- On free hosting the disk is usually wiped on restart, so the call list resets.

## Files

| File | What it is |
| --- | --- |
| `server.js` | Routing, Twilio webhooks, dashboard API |
| `config.json` | Clinic name, people, ring time, prompts |
| `public/index.html` | The dashboard |
| `simulate.js` | Start a test call from the terminal: `node simulate.js voicemail` |
| `.env.example` | Settings to copy into `.env` |

## Demo: transcripts, Google Sheet and WhatsApp

Every answered call (and voicemail) is downloaded after it ends, transcribed (English or Arabic) and read by Gemini.
The result goes to a Google Sheet (tabs "Appointments" and "Calls") and to WhatsApp:

- Booked, clear date and time: the patient and the clinic rep both get a confirmation (in the caller's language).
- Unclear, low confidence or past date: marked "Needs review", only the clinic rep is told.
- Day before a booking: reminder to the patient, automatically at REMINDER_HOUR, or with the dashboard button.

Setup, once:
1. New Google Sheet > Extensions > Apps Script > paste `apps-script/Code.gs`, change SECRET, Deploy > Web app (Execute as Me, Access Anyone).
2. On Render set SHEET_WEBHOOK_URL (Web app URL), SHEET_SECRET (same text as SECRET), SHEET_URL (sheet address).
3. Set GEMINI_API_KEY.
4. WhatsApp sandbox (Twilio console > Messaging > Try WhatsApp): send the join code from the clinic rep's phone and from the demo customer phone; set TWILIO_WHATSAPP_FROM, CLINIC_REP_WHATSAPP, DEMO_CUSTOMER_WHATSAPP.

Limits of the demo: the sandbox only messages numbers that joined it, free text only within 24h of their last message; real use needs a Meta-approved WhatsApp sender and templates. The free Render server forgets its call list on restart (the sheet keeps everything). Gemini's free tier is not for real patient calls.

Tests: `node test/e2e.js` (uses fake Gemini, Twilio and Sheet).

## Who rings, and when

Staff are listed in `config.json` (or `USERS_JSON`). Users with the same `"group"` number ring **at the same time**; groups go in the order they first appear; a user with no group rings alone. Default: Landline 1 + Landline 2 (group 1), then Front desk + Clinic manager + Doctor on call + Owner (group 2), then voicemail. Each group rings for `ringSeconds` (10).

The first person to press 1 gets the call. Anyone else who accepts a moment later hears "This call has already been taken" and is dropped, and everyone who was still ringing is free for the next caller. Someone already on a clinic call is left out of the next group.
