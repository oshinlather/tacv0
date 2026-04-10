// Returns today's date in IST (Asia/Kolkata) as YYYY-MM-DD string
function todayIST() {
  const d = new Date();
  // Convert to IST: UTC + 5:30
  d.setMinutes(d.getMinutes() + 330 + d.getTimezoneOffset());
  return d.toISOString().split("T")[0];
}

module.exports = { todayIST };
