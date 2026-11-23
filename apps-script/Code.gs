/**
 * Basmati Dental Clinic: Google Sheet connection.
 *
 * This script lives inside the Google Sheet. The phone desk server sends it one row per call,
 * and one row per appointment, and the sheet stays up to date live.
 *
 * Set up (once):
 *  1. In the sheet: Extensions > Apps Script. Delete what is there and paste this whole file.
 *  2. Change SECRET below to the same text the server has as SHEET_SECRET.
 *  3. Deploy > New deployment > type "Web app".
 *     Execute as: Me.  Who has access: Anyone.  Deploy, then allow access when Google asks.
 *  4. Copy the Web app URL. The server needs it as SHEET_WEBHOOK_URL.
 *
 * "Anyone" only means the address can be reached. Without the SECRET nothing is read or written.
 */

const SECRET = 'PASTE_SECRET_HERE';
const TIMEZONE = 'Asia/Riyadh';

// [column title, key sent by the server]
const CALL_COLS = [
  ['Call ID', 'id'], ['Received', 'received'], ['Caller', 'caller'], ['Answered by', 'answeredBy'],
  ['Language', 'language'], ['Outcome', 'outcome'], ['Patient', 'patient'], ['Patient phone', 'patientPhone'],
  ['Appointment date', 'date'], ['Appointment time', 'time'], ['Treatment', 'treatment'],
  ['Summary', 'summary'], ['Transcript', 'transcript'], ['Recording', 'recording'],
];
const APPT_COLS = [
  ['Booking ID', 'id'], ['Date', 'date'], ['Time', 'time'], ['Patient', 'patient'], ['Phone', 'phone'],
  ['Treatment', 'treatment'], ['Status', 'status'], ['Language', 'language'],
  ['Confirmation sent', 'confirmation'], ['Reminder sent', 'reminder'], ['Notes', 'notes'],
  ['Doctor', 'doctor'], ['Patient reply', 'reply'],
];
const TABS = {
  Appointments: { cols: APPT_COLS, statusCol: 7, sortBy: [{ column: 2, ascending: true }, { column: 3, ascending: true }] },
  Calls: { cols: CALL_COLS, statusCol: 6, sortBy: [{ column: 2, ascending: false }] },
};

function doGet() {
  return text_('The Basmati Dental Clinic sheet script is running.');
}

function doPost(e) {
  const lock = LockService.getScriptLock();
  let locked = false;
  try {
    lock.waitLock(25000);
    locked = true;
    const req = JSON.parse(e.postData.contents);
    if (req.secret !== SECRET) {
      return json_({ ok: false, error: 'Wrong secret. SECRET in the Apps Script must match SHEET_SECRET on the server.' });
    }
    switch (req.action) {
      case 'ping':
        sheet_('Appointments');
        sheet_('Calls');
        return json_({ ok: true });
      case 'upsertCall':
        upsert_('Calls', req.call);
        if (req.appointment) upsert_('Appointments', req.appointment);
        else if (req.appointment === null) remove_('Appointments', req.call.id);
        return json_({ ok: true });
      case 'upsertAppointment':
        upsert_('Appointments', req.appointment);
        return json_({ ok: true });
      case 'listAppointments':
        return json_({ ok: true, rows: read_('Appointments') });
      case 'listTranscripts':
        return json_({ ok: true, calls: read_('Calls').filter(function (r) { return r.transcript; }).map(function (r) { return { id: r.id, transcript: r.transcript }; }) });
      case 'updateAppointment':
        return json_({ ok: update_('Appointments', req.id, req.fields || {}) });
      case 'deleteAppointment':
        remove_('Appointments', req.id);
        return json_({ ok: true });
      case 'deleteTest':
        removeTest_();
        return json_({ ok: true });
      default:
        return json_({ ok: false, error: 'Unknown action: ' + req.action });
    }
  } catch (err) {
    return json_({ ok: false, error: String((err && err.message) || err) });
  } finally {
    if (locked) lock.releaseLock();
  }
}

// ---------------------------------------------------------------- tabs

function sheet_(name) {
  const tab = TABS[name];
  const ss = SpreadsheetApp.getActive();
  let sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    const blank = ss.getSheetByName('Sheet1');
    if (blank && blank.getLastRow() === 0 && ss.getSheets().length > 1) ss.deleteSheet(blank);
  }
  if (sh.getLastRow() === 0) {
    sh.getRange(1, 1, 1, tab.cols.length)
      .setValues([tab.cols.map(function (c) { return c[0]; })])
      .setFontWeight('bold')
      .setBackground('#163029')
      .setFontColor('#ffffff');
    sh.setFrozenRows(1);
    colors_(sh, tab);
    try { styleTab_(sh, name, tab); } catch (e) { /* formatting is optional */ }
  }
  else if (!String(sh.getRange(1, tab.cols.length).getValue() || '')) {
    // an older sheet: add the new column titles at the end, existing data stays where it is
    sh.getRange(1, 1, 1, tab.cols.length)
      .setValues([tab.cols.map(function (c) { return c[0]; })])
      .setFontWeight('bold').setBackground('#163029').setFontColor('#ffffff');
  }
  return sh;
}

function colors_(sh, tab) {
  const range = sh.getRange(2, 1, Math.max(sh.getMaxRows() - 1, 1), tab.cols.length);
  const col = String.fromCharCode(64 + tab.statusCol);
  function rule(label, color) {
    return SpreadsheetApp.newConditionalFormatRule()
      .whenFormulaSatisfied('=$' + col + '2="' + label + '"')
      .setBackground(color)
      .setRanges([range])
      .build();
  }
  sh.setConditionalFormatRules([
    rule('Booked', '#DDF0EC'),
    rule('Needs review', '#FBEFD2'),
    rule('Missed call', '#F7E2E0'),
    rule('Cancelled', '#E5E7E6'),
  ]);
}

function find_(sh, id) {
  const last = sh.getLastRow();
  if (last < 2) return 0;
  const ids = sh.getRange(2, 1, last - 1, 1).getValues();
  for (let i = 0; i < ids.length; i++) {
    if (String(ids[i][0]) === String(id)) return i + 2;
  }
  return 0;
}

function upsert_(name, obj) {
  const tab = TABS[name];
  const sh = sheet_(name);
  const n = tab.cols.length;
  let row = find_(sh, obj.id);
  let values;
  if (row) {
    // Keep what is already in the sheet for anything the server did not send this time.
    const old = sh.getRange(row, 1, 1, n).getValues()[0];
    values = tab.cols.map(function (c, i) { return obj[c[1]] === undefined ? old[i] : obj[c[1]]; });
  } else {
    values = tab.cols.map(function (c) { return obj[c[1]] === undefined ? '' : obj[c[1]]; });
    row = Math.max(sh.getLastRow(), 1) + 1;
  }
  const range = sh.getRange(row, 1, 1, n);
  range.setNumberFormat('@'); // plain text, so dates, times and +966 numbers stay exactly as written
  range.setValues([values.map(function (v) { return v === null ? '' : String(v); })]);
  const last = sh.getLastRow();
  if (last > 2) sh.getRange(2, 1, last - 1, n).sort(tab.sortBy);
}

function remove_(name, id) {
  const sh = sheet_(name);
  const row = find_(sh, id);
  if (row) sh.deleteRow(row);
}

function cell_(v, key) {
  if (Object.prototype.toString.call(v) === '[object Date]') return Utilities.formatDate(v, TIMEZONE, key === 'time' ? 'HH:mm' : 'yyyy-MM-dd');
  return String(v);
}

function read_(name) {
  const tab = TABS[name];
  const sh = sheet_(name);
  const last = sh.getLastRow();
  if (last < 2) return [];
  return sh.getRange(2, 1, last - 1, tab.cols.length).getValues().map(function (r) {
    const o = {};
    tab.cols.forEach(function (c, i) { o[c[1]] = cell_(r[i], c[1]); });
    return o;
  });
}

function update_(name, id, fields) {
  const tab = TABS[name];
  const sh = sheet_(name);
  const row = find_(sh, id);
  if (!row) return false;
  tab.cols.forEach(function (c, i) {
    if (fields[c[1]] !== undefined) sh.getRange(row, i + 1).setNumberFormat('@').setValue(String(fields[c[1]]));
  });
  return true;
}

function removeTest_() {
  Object.keys(TABS).forEach(function (name) {
    const sh = sheet_(name);
    for (let row = sh.getLastRow(); row >= 2; row--) {
      if (String(sh.getRange(row, 1).getValue()).indexOf('TEST') === 0) sh.deleteRow(row);
    }
  });
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function text_(s) {
  return ContentService.createTextOutput(s);
}

const LOOK = {
  font: 'Roboto',
  header: '#0B6E78',
  headerText: '#FFFFFF',
  band: '#F2F8F8',
  line: '#D5E3E5',
  widths: {
    Appointments: [110, 105, 70, 170, 145, 170, 120, 95, 230, 190, 300],
    Calls: [110, 150, 145, 140, 95, 125, 165, 145, 115, 90, 150, 380, 420, 230],
  },
  tabColor: { Appointments: '#0B6E78', Calls: '#3F6FB5' },
  centered: ['Date', 'Time', 'Language', 'Status', 'Outcome', 'Appointment date', 'Appointment time', 'Received'],
  wrapped: ['Notes', 'Summary', 'Confirmation sent', 'Reminder sent'],
  statuses: [
    ['Booked', '#CBEFD6', '#0B5D2E'],
    ['Needs review', '#FFE2A3', '#7A4A00'],
    ['Missed call', '#F8CFCB', '#8A1C14'],
    ['Voicemail', '#E2D8F6', '#4B2E83'],
    ['Not booked', '#DCE8F5', '#1F4E79'],
    ['Analyzing', '#FFF4C2', '#6B5A00'],
    ['In progress', '#FFF4C2', '#6B5A00'],
    ['Cancelled', '#E4E6E7', '#555555'],
  ],
};

function formatSheets() {
  Object.keys(TABS).forEach(function (name) {
    styleTab_(sheet_(name), name, TABS[name]);
  });
}

function styleTab_(sh, name, tab) {
  const n = tab.cols.length;
  const titles = tab.cols.map(function (c) { return c[0]; });
  const rows = 500;
  if (sh.getMaxRows() < rows) sh.insertRowsAfter(sh.getMaxRows(), rows - sh.getMaxRows());

  const all = sh.getRange(1, 1, rows, n);
  all.setFontFamily(LOOK.font).setFontSize(10).setVerticalAlignment('middle').setHorizontalAlignment('left').setWrapStrategy(SpreadsheetApp.WrapStrategy.CLIP);

  const head = sh.getRange(1, 1, 1, n);
  head.setBackground(LOOK.header).setFontColor(LOOK.headerText).setFontWeight('bold').setFontSize(11).setHorizontalAlignment('center');
  sh.setRowHeight(1, 38);
  if (rows > 1) sh.setRowHeights(2, rows - 1, 30);

  const widths = LOOK.widths[name] || [];
  titles.forEach(function (t, i) {
    const col = i + 1;
    if (widths[i]) sh.setColumnWidth(col, widths[i]);
    const body = sh.getRange(2, col, rows - 1, 1);
    if (LOOK.centered.indexOf(t) >= 0) body.setHorizontalAlignment('center');
    if (LOOK.wrapped.indexOf(t) >= 0) body.setWrapStrategy(SpreadsheetApp.WrapStrategy.WRAP);
  });
  sh.getRange(2, 1, rows - 1, 1).setFontColor('#7A8C90').setFontSize(9); // the ID column is for the machine

  sh.setFrozenRows(1);
  sh.setHiddenGridlines(true);
  sh.setTabColor(LOOK.tabColor[name] || LOOK.header);

  const body = sh.getRange(2, 1, rows - 1, n);
  body.setBorder(null, null, true, null, null, true, LOOK.line, SpreadsheetApp.BorderStyle.SOLID);

  const statusRange = sh.getRange(2, tab.statusCol, rows - 1, 1);
  const rules = LOOK.statuses.map(function (s) {
    return SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo(s[0]).setBackground(s[1]).setFontColor(s[2]).setBold(true).setRanges([statusRange]).build();
  });
  rules.push(SpreadsheetApp.newConditionalFormatRule().whenFormulaSatisfied('=AND($A2<>"",ISEVEN(ROW()))').setBackground(LOOK.band).setRanges([body]).build());
  sh.setConditionalFormatRules(rules);
}
