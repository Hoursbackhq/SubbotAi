const fs = require('fs');
const { performance } = require('perf_hooks');

// Shared protocol with sub_store.py: exclusive-create <data file>.lock.
// Never steal a lock based on age: a slow writer may still own it. After a
// crash, an operator must stop writers before removing the abandoned lock.
async function withFileLock(file, fn, { timeoutMs = 3000, retryMs = 50 } = {}) {
  const lockPath = `${file}.lock`;
  const deadline = performance.now() + timeoutMs;
  let fd;
  for (;;) {
    try {
      fd = fs.openSync(lockPath, 'wx');
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      if (performance.now() >= deadline) {
        throw Object.assign(new Error('Storage is busy. Please try again shortly.'), {
          code: 'ELOCKTIMEOUT', status: 503,
        });
      }
      await new Promise(resolve => setTimeout(resolve, retryMs));
    }
  }
  try {
    fs.writeFileSync(fd, `${process.pid}\n`);
    return await fn();
  } finally {
    fs.closeSync(fd);
    fs.unlinkSync(lockPath);
  }
}

module.exports = { withFileLock };
