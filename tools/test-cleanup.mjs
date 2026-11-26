// Lists (dry run, default) or with --kill ends leftover test node.exe processes
// whose command line contains net-guard.mjs or jest.apps.config.
// WARNING: run only between rounds when no Bhava agent is active - it cannot tell
// your processes from another agent's running tests.
import { spawnSync } from 'node:child_process';

const kill = process.argv.includes('--kill');
if (process.platform !== 'win32') {
  console.error('test-cleanup: Windows only');
  process.exit(2);
}
const PATTERN = /net-guard\.mjs|jest\.apps\.config/;

function list() {
  const ps = spawnSync('powershell', ['-NoProfile', '-Command',
    "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Select-Object ProcessId,ParentProcessId,CommandLine | ConvertTo-Json -Compress"],
  { encoding: 'utf8', maxBuffer: 64 << 20 });
  if (ps.status === 0 && ps.stdout.trim()) {
    const j = JSON.parse(ps.stdout);
    return (Array.isArray(j) ? j : [j]).map((p) => ({ pid: p.ProcessId, ppid: p.ParentProcessId, cmd: p.CommandLine || '' }));
  }
  const w = spawnSync('wmic', ['process', 'where', "name='node.exe'", 'get', 'ProcessId,ParentProcessId,CommandLine', '/format:csv'], { encoding: 'utf8', maxBuffer: 64 << 20 });
  if (w.status !== 0) { console.error('test-cleanup: could not list processes'); process.exit(1); }
  return w.stdout.split(/\r?\n/).slice(1).filter(Boolean).map((l) => {
    const c = l.split(','); // Node,CommandLine,ParentProcessId,ProcessId (command line may contain commas)
    return { pid: Number(c[c.length - 1]), ppid: Number(c[c.length - 2]), cmd: c.slice(1, -2).join(',') };
  });
}

const hits = list().filter((p) => p.pid !== process.pid && PATTERN.test(p.cmd));
if (!hits.length) console.log('No leftover test processes found.');
for (const p of hits) {
  console.log(`${kill ? 'KILL' : 'found'} pid=${p.pid} ppid=${p.ppid} ${p.cmd.slice(0, 160)}`);
  if (kill) spawnSync('taskkill', ['/T', '/F', '/PID', String(p.pid)], { stdio: 'ignore' });
}
if (!kill && hits.length) console.log(`\n${hits.length} process(es). Dry run only; re-run with --kill (only when no agent is active).`);
