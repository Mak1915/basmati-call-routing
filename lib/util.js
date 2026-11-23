'use strict';

// Dates, times and phone numbers. Everything here is in Saudi time.
// Saudi Arabia has no daylight saving, so a fixed +03:00 offset is safe.

const TZ = 'Asia/Riyadh';
const OFFSET = '+03:00';
const DAY = 86400000;

function toLatinDigits(s) {
  return String(s == null ? '' : s)
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0));
}

function ymdInZone(ms) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
}

const todayYmd = () => ymdInZone(Date.now());
const tomorrowYmd = () => ymdInZone(Date.now() + DAY);
const noon = (ymd) => Date.parse(`${ymd}T12:00:00${OFFSET}`);
const addDays = (ymd, n) => ymdInZone(noon(ymd) + n * DAY);

function isYmd(s) {
  return /^\d{4}-\d{2}-\d{2}$/.test(s || '') && !Number.isNaN(noon(s)) && ymdInZone(noon(s)) === s;
}

function hourNow() {
  return Number(new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', hourCycle: 'h23' }).format(new Date()));
}

/** "2026-11-16 14:05" in Saudi time. */
function stamp(ms) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(ms));
  const p = Object.fromEntries(parts.map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}

const weekdayOf = (ymd) => new Intl.DateTimeFormat('en-GB', { timeZone: TZ, weekday: 'long' }).format(new Date(noon(ymd)));

function dayLabel(ymd, lang) {
  if (!isYmd(ymd)) return ymd || '';
  const locale = lang === 'ar' ? 'ar-SA-u-ca-gregory-nu-latn' : 'en-GB';
  return new Intl.DateTimeFormat(locale, { timeZone: TZ, weekday: 'long', day: 'numeric', month: 'long' }).format(new Date(noon(ymd)));
}

function timeLabel(hhmm, lang) {
  const m = /^(\d{2}):(\d{2})$/.exec(hhmm || '');
  if (!m) return hhmm || '';
  const h = Number(m[1]);
  const h12 = h % 12 === 0 ? 12 : h % 12;
  const pm = h >= 12;
  const suffix = lang === 'ar' ? (pm ? 'مساءً' : 'صباحاً') : pm ? 'PM' : 'AM';
  return `${h12}:${m[2]} ${suffix}`;
}

/** "9:30" or "09.30" -> "09:30". Anything else -> "". */
function normalizeTime(raw) {
  const m = /^\s*(\d{1,2})[:.](\d{2})\s*$/.exec(toLatinDigits(raw));
  if (!m) return '';
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return '';
  return String(h).padStart(2, '0') + ':' + m[2];
}

/** Returns +9665XXXXXXXX style numbers, or null when the number cannot be trusted. */
function normalizePhone(raw) {
  if (!raw) return null;
  const s = toLatinDigits(raw).trim();
  if (/anonymous|restricted|unknown|private/i.test(s)) return null;
  const plus = s.startsWith('+');
  let d = s.replace(/\D/g, '');
  if (!d) return null;
  if (!plus) {
    if (d.startsWith('00')) d = d.slice(2);
    else if (d.startsWith('05') && d.length === 10) d = '966' + d.slice(1);
    else if (d.startsWith('5') && d.length === 9) d = '966' + d;
    else if (d.startsWith('0')) return null; // local number with no country, cannot guess
  }
  if (d.startsWith('9660')) d = '966' + d.slice(4); // +966 0554... : the leading 0 is not part of the number
  if (d.length < 8 || d.length > 15) return null;
  return '+' + d;
}

module.exports = {
  TZ, OFFSET, toLatinDigits, todayYmd, tomorrowYmd, addDays, isYmd, hourNow, stamp, weekdayOf,
  dayLabel, timeLabel, normalizeTime, normalizePhone,
};
