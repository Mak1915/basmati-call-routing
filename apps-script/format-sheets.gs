/**
 * Makes both tabs of the Basmati sheet look good: colored header, status colors, banded rows,
 * sensible column widths, centered dates and times, wrapped notes.
 *
 * Paste this at the very end of your existing Apps Script file (below everything else),
 * pick "formatSheets" in the function list at the top and press Run. It does not need a new deployment.
 * Run it again any time the look gets messy. It never changes the data.
 */

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
