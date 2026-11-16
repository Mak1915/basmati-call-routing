'use strict';

// Ready-made conversations for the test calls on the dashboard. They stand in for what the
// transcription step would produce, so the rest of the system can be shown without a phone.
// All names and details here are made up.

const util = require('./util');

const base = {
  language: 'en', summary: '', wantsAppointment: false, booked: false, patientName: '', patientPhone: '',
  date: '', time: '', treatment: '', confidence: 'high', notes: '', transcript: '',
};

const bookEn = () => ({
  ...base,
  language: 'en',
  summary: 'Omar Al-Harbi booked a teeth cleaning for tomorrow at 4:30 PM.',
  wantsAppointment: true,
  booked: true,
  patientName: 'Omar Al-Harbi',
  date: util.addDays(util.todayYmd(), 1),
  time: '16:30',
  treatment: 'Teeth cleaning',
  transcript: [
    'Caller: Hello, I would like to book an appointment for a teeth cleaning.',
    'Clinic: Of course. Which day works for you?',
    'Caller: Tomorrow afternoon, around four thirty if possible.',
    'Clinic: Yes, four thirty is free. Can I have your name?',
    'Caller: Omar Al-Harbi.',
    'Clinic: Thank you Omar, you are booked for tomorrow at 4:30 PM. See you then.',
    'Caller: Great, thank you. Bye.',
  ].join('\n'),
});

const bookAr = () => ({
  ...base,
  language: 'ar',
  summary: 'Khalid Al-Ghamdi booked a teeth cleaning for the day after tomorrow at 11:00 AM.',
  wantsAppointment: true,
  booked: true,
  patientName: 'خالد الغامدي',
  date: util.addDays(util.todayYmd(), 2),
  time: '11:00',
  treatment: 'تنظيف الأسنان',
  transcript: [
    'Caller: السلام عليكم، أبغى أحجز موعد لتنظيف الأسنان.',
    'Clinic: وعليكم السلام، تفضل. أي يوم يناسبك؟',
    'Caller: بعد بكرة الساعة 11 الصبح إذا ممكن.',
    'Clinic: تمام، الاسم الكريم؟',
    'Caller: خالد الغامدي.',
    'Clinic: تم حجز الموعد بعد بكرة الساعة 11 صباحاً. شكراً لك.',
    'Caller: شكراً، مع السلامة.',
  ].join('\n'),
});

const inquiryEn = () => ({
  ...base,
  summary: 'Caller asked about the price of teeth whitening and was told the dentist must see them first. No appointment.',
  transcript: [
    'Caller: Hi, how much is a teeth whitening session?',
    'Clinic: It depends on the case, the dentist needs to see you first.',
    'Caller: OK, thank you, I will think about it.',
    'Clinic: You are welcome.',
  ].join('\n'),
});

const unclearEn = () => ({
  ...base,
  summary: 'Sara asked for an appointment next week. The clinic is fully booked and will call back.',
  wantsAppointment: true,
  patientName: 'Sara',
  confidence: 'medium',
  notes: 'No day or time was agreed.',
  transcript: [
    'Caller: Hello, I need an appointment sometime next week.',
    'Clinic: We are fully booked for the moment. Let me check and call you back.',
    'Caller: OK, my name is Sara.',
  ].join('\n'),
});

const voicemailAr = () => ({
  ...base,
  language: 'ar',
  summary: 'Fahd left a voicemail asking for a teeth whitening appointment and a call back.',
  wantsAppointment: true,
  patientName: 'فهد',
  treatment: 'تبييض الأسنان',
  notes: 'Voicemail: nobody has agreed a time yet.',
  transcript: 'Caller: السلام عليكم، أنا فهد، أبغى موعد لتبييض الأسنان. أرجو الاتصال بي. شكراً.',
});

module.exports = { bookEn, bookAr, inquiryEn, unclearEn, voicemailAr };
