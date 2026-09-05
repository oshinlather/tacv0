// Returns today's date in IST (Asia/Kolkata) as YYYY-MM-DD string.
// Date.now() is an absolute instant regardless of the server's own timezone
// setting, so shifting it by IST's fixed +5:30 and reading it back via
// toISOString() (UTC) always gives the correct IST calendar date. (Previously
// this also added d.getTimezoneOffset(), which cancels the shift out entirely
// if the process ever runs on a host set to IST instead of UTC.)
function todayIST() {
  const d = new Date();
  d.setMinutes(d.getMinutes() + 330);
  return d.toISOString().split("T")[0];
}

// Minutes since midnight IST, right now — same +5:30 shift todayIST() uses, read back as
// hours*60+minutes instead of just the date. Used for time-of-day cutoffs (e.g. the evening
// demand slot closing at 11:45 AM) that a date-only helper can't express.
function istMinutesNow() {
  const d = new Date();
  d.setMinutes(d.getMinutes() + 330);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}

module.exports = { todayIST, istMinutesNow };
