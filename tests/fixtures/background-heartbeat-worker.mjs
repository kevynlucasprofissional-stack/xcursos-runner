import fs from 'node:fs';
import path from 'node:path';

const [heartbeatPath, stopPath, pidPath] = process.argv.slice(2);
if (!heartbeatPath || !stopPath || !pidPath) process.exit(64);

for (const file of [heartbeatPath, stopPath, pidPath]) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
}
fs.writeFileSync(pidPath, `${process.pid}\n`, 'utf8');

let counter = 0;
function beat() {
  counter += 1;
  const tmp = `${heartbeatPath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ pid: process.pid, counter, at: new Date().toISOString() }), 'utf8');
  fs.renameSync(tmp, heartbeatPath);
  if (fs.existsSync(stopPath)) process.exit(0);
}

beat();
setInterval(beat, 200);
