import { spawn } from 'node:child_process';

// Demonstração local: dois processos HTTP reais, ambos encerrados com Ctrl+C.
const mock = spawn(process.execPath, ['scripts/mock-aggregator.js'], { stdio: 'inherit' });
const api = spawn(process.execPath, ['src/server.js'], { stdio: 'inherit' });
let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  mock.kill('SIGTERM');
  api.kill('SIGTERM');
  process.exitCode = code;
}
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => stop());
for (const child of [mock, api]) {
  child.once('error', error => { console.error(error.message); stop(1); });
  child.once('exit', code => { if (!stopping) stop(code || 1); });
}
