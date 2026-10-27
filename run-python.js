const { spawn } = require('child_process');
const path = require('path');

// Invoke Python directly. User IDs and service names must never be shell text.
function runPython(script, args, { input, timeout = 60000, spawnImpl = spawn } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnImpl('python3', [path.join(__dirname, script), ...args], {
      timeout, stdio: ['pipe', 'pipe', 'pipe'], shell: false,
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`Python task failed (${code}): ${stderr.slice(-2000)}`));
    });
    child.stdin.on('error', () => {}); // child may exit before consuming input
    child.stdin.end(input);
  });
}

module.exports = { runPython };
