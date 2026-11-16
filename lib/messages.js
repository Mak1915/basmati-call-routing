'use strict';

// The WhatsApp texts. Patients get English or Arabic, matching the language of their call.
// The clinic's own messages are in English.
//
// ctx = { clinicName, clinicNameAr, clinicNumber, sheetUrl }

const { dayLabel, timeLabel } = require('./util');

const clinic = (ctx, lang) => (lang === 'ar' && ctx.clinicNameAr) || ctx.clinicName;
const callUs = (ctx, lang) => (ctx.clinicNumber ? (lang === 'ar' ? ` على ${ctx.clinicNumber}` : ` on ${ctx.clinicNumber}`) : '');
const lines = (list) => list.filter(Boolean).join('\n');

/** b = { name, date, time, treatment } */
function customerBooking(ctx, b, lang) {
  const day = dayLabel(b.date, lang);
  const time = timeLabel(b.time, lang);
  if (lang === 'ar') {
    return lines([
      b.name ? `مرحباً ${b.name}،` : 'مرحباً،',
      `تم حجز موعدك في ${clinic(ctx, lang)} يوم ${day} الساعة ${time}.`,
      b.treatment ? `الخدمة: ${b.treatment}` : '',
      `لتعديل الموعد أو إلغائه يرجى الاتصال بنا${callUs(ctx, lang)}.`,
      'نراك قريباً.',
    ]);
  }
  return lines([
    b.name ? `Hello ${b.name},` : 'Hello,',
    `Your appointment at ${clinic(ctx, lang)} is booked for ${day} at ${time}.`,
    b.treatment ? `Reason: ${b.treatment}` : '',
    `To change or cancel it, please call us${callUs(ctx, lang)}.`,
    'See you soon!',
  ]);
}

function customerReminder(ctx, b, lang) {
  const day = dayLabel(b.date, lang);
  const time = timeLabel(b.time, lang);
  if (lang === 'ar') {
    return lines([
      b.name ? `مرحباً ${b.name}،` : 'مرحباً،',
      `تذكير من ${clinic(ctx, lang)}: لديك موعد غداً ${day} الساعة ${time}.`,
      `نرجو الحضور في الوقت المحدد حتى لا يفوتك دورك. لتعديل الموعد أو إلغائه يرجى الاتصال بنا${callUs(ctx, lang)}.`,
    ]);
  }
  return lines([
    b.name ? `Hello ${b.name},` : 'Hello,',
    `Reminder from ${clinic(ctx, lang)}: you have an appointment tomorrow, ${day}, at ${time}.`,
    `Please arrive on time so you do not lose your slot. To change or cancel, please call us${callUs(ctx, lang)}.`,
  ]);
}

/** d = { name, phone, date, time, treatment, takenBy, summary, patientNotice } */
function repBooking(ctx, d) {
  return lines([
    'New booking ✅',
    `Patient: ${d.name || '(name not given)'}`,
    `Phone: ${d.phone || '(not known)'}`,
    `When: ${dayLabel(d.date, 'en')}, ${timeLabel(d.time, 'en')}`,
    d.treatment ? `For: ${d.treatment}` : '',
    `Taken by: ${d.takenBy || '-'}`,
    `Patient confirmation: ${d.patientNotice}`,
    ctx.sheetUrl ? `Sheet: ${ctx.sheetUrl}` : '',
  ]);
}

/** d = { name, phone, summary, takenBy, reason } */
function repReview(ctx, d) {
  return lines([
    'Please check this call ⚠️',
    d.reason,
    d.name ? `Patient: ${d.name}` : '',
    d.phone ? `Phone: ${d.phone}` : '',
    d.summary ? `Summary: ${d.summary}` : '',
    `Taken by: ${d.takenBy || '-'}`,
    'Nothing was sent to the patient.',
    ctx.sheetUrl ? `Sheet: ${ctx.sheetUrl}` : '',
  ]);
}

module.exports = { customerBooking, customerReminder, repBooking, repReview };
