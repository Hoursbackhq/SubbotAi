// Bound expensive subprocesses independently of client-side charging.
function createTaskLimiter({ maxActive = 4, perHour = 10, now = Date.now } = {}) {
  const users = new Map();
  let active = 0;
  return async function runTask(userId, task) {
    const time = now();
    for (const [id, entry] of users) if (!entry.active && time - entry.start >= 3600000) users.delete(id);
    const entry = users.get(userId) || { start: time, runs: 0, active: false };
    if (entry.active || entry.runs >= perHour) throw Object.assign(new Error('Task limit reached. Try again later.'), { status: 429 });
    if (active >= maxActive || (!users.has(userId) && users.size >= 10000)) {
      throw Object.assign(new Error('Tasks are busy. Try again shortly.'), { status: 503 });
    }
    users.set(userId, entry);
    entry.runs++; entry.active = true; active++;
    try { return await task(); }
    finally { entry.active = false; active--; }
  };
}

module.exports = { createTaskLimiter };
