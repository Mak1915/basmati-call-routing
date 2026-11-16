'use strict';

// A tiny stand-in for Google's SpreadsheetApp, just big enough to run apps-script/Code.gs
// in Node and check its logic (finding rows, keeping old values, sorting, deleting).

const vm = require('vm');

function createFakeSheets(code) {
  const sheets = [];

  function range(sh, r, c, nr, nc) {
    const rg = {
      getValues() {
        const out = [];
        for (let i = 0; i < nr; i++) {
          const row = sh.data[r - 1 + i] || [];
          const o = [];
          for (let j = 0; j < nc; j++) o.push(row[c - 1 + j] === undefined ? '' : row[c - 1 + j]);
          out.push(o);
        }
        return out;
      },
      getValue() { return rg.getValues()[0][0]; },
      setValues(v) {
        for (let i = 0; i < nr; i++) {
          sh.data[r - 1 + i] = sh.data[r - 1 + i] || [];
          for (let j = 0; j < nc; j++) sh.data[r - 1 + i][c - 1 + j] = v[i][j];
        }
        return rg;
      },
      setValue(v) { return rg.setValues([[v]]); },
      setNumberFormat() { sh.textFormatCalls++; return rg; },
      setFontWeight() { return rg; },
      setBackground() { return rg; },
      setFontColor() { return rg; },
      sort(specs) {
        const rows = rg.getValues();
        rows.sort((a, b) => {
          for (const s of specs) {
            const i = s.column - c;
            const x = String(a[i]);
            const y = String(b[i]);
            if (x === y) continue;
            if (x === '') return 1;
            if (y === '') return -1;
            const cmp = x < y ? -1 : 1;
            return s.ascending ? cmp : -cmp;
          }
          return 0;
        });
        return rg.setValues(rows);
      },
    };
    return rg;
  }

  function make(name) {
    const sh = {
      name, data: [], maxRows: 1000, textFormatCalls: 0, rules: [],
      getLastRow() {
        for (let i = sh.data.length - 1; i >= 0; i--) if ((sh.data[i] || []).some((v) => v !== '' && v != null)) return i + 1;
        return 0;
      },
      getMaxRows() { return sh.maxRows; },
      setFrozenRows() {},
      setConditionalFormatRules(rules) { sh.rules = rules; },
      deleteRow(r) { sh.data.splice(r - 1, 1); },
      getRange(r, c, nr = 1, nc = 1) { return range(sh, r, c, nr, nc); },
    };
    return sh;
  }

  sheets.push(make('Sheet1'));
  const ss = {
    getSheetByName: (n) => sheets.find((s) => s.name === n) || null,
    insertSheet: (n) => { const s = make(n); sheets.push(s); return s; },
    getSheets: () => sheets,
    deleteSheet: (s) => sheets.splice(sheets.indexOf(s), 1),
  };

  const rule = () => {
    const r = {};
    r.whenFormulaSatisfied = (f) => { r.formula = f; return r; };
    r.setBackground = (b) => { r.background = b; return r; };
    r.setRanges = (x) => { r.ranges = x; return r; };
    r.build = () => ({ formula: r.formula, background: r.background });
    return r;
  };

  const sandbox = {
    SpreadsheetApp: { getActive: () => ss, newConditionalFormatRule: rule },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    ContentService: {
      MimeType: { JSON: 'json' },
      createTextOutput: (s) => ({ content: s, setMimeType() { return this; } }),
    },
    Utilities: {
      formatDate(d, tz, fmt) {
        const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
          timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
        }).formatToParts(d).map((x) => [x.type, x.value]));
        return fmt === 'HH:mm' ? `${p.hour}:${p.minute}` : `${p.year}-${p.month}-${p.day}`;
      },
    },
  };
  const ctx = vm.createContext(sandbox);
  vm.runInContext(code + '\n;this.__doPost = doPost; this.__doGet = doGet;', ctx);

  return {
    sheets,
    sheet: (name) => ss.getSheetByName(name),
    doPost: (contents) => JSON.parse(ctx.__doPost({ postData: { contents } }).content),
    doGet: () => ctx.__doGet().content,
  };
}

module.exports = { createFakeSheets };
