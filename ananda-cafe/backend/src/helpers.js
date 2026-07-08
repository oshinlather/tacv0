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

module.exports = { todayIST };
