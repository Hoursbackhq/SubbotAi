const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Keep verified legacy accounts readable, but never merge different IDs just
// because punctuation was replaced with underscores. Python uses the same hash.
function userPath(root, userId) {
  const id = String(userId);
  if (!id || id === '.' || id === '..') throw new Error('Invalid account ID');
  const legacy = path.join(root, id.replace(/[^a-zA-Z0-9:_.\-]/g, '_'));
  try {
    if (JSON.parse(fs.readFileSync(path.join(legacy, 'web3auth-meta.json'), 'utf8')).userId === id) return legacy;
  } catch (_) {}
  return path.join(root, 'u_' + crypto.createHash('sha256').update(id).digest('hex'));
}

module.exports = { userPath };
