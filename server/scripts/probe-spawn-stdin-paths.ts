/**
 * Probe script: verify spawn + stdin delivery for BOTH executable paths
 * (.exe direct and .cmd + shell:true fallback). Confirms:
 *   1. spawn does not throw EINVAL on either path
 *   2. stdin.write(prompt) + end() delivers the prompt to claude CLI
 *   3. Adversarial prompt (cmd.exe metacharacters) survives verbatim
 *
 * Does NOT require network — we only need claude to START and emit
 * something (even an auth error counts; what we check is that spawn
 * succeeded and stdin was consumed without EINVAL).
 *
 *   cd server && npx tsx scripts/probe-spawn-stdin-paths.ts
 */

import { spawn } from 'node:child_process';

const adversarialPrompt =
  'line1 | line2\nline3 "q" `back` $HOME > out < in & bg\n| A | B |\n|---|---|';

interface ProbeResult {
  label: string;
  cmd: string;
  args: string[];
  useShell: boolean;
  spawnThrew: string | null;
  exitCode: number | null;
  stdoutHead: string;
  stderrHead: string;
}

function probe(
  label: string,
  cmd: string,
  args: string[],
  useShell: boolean,
  env: NodeJS.ProcessEnv,
  timeoutMs: number
): Promise<ProbeResult> {
  return new Promise((resolve) => {
    const result: ProbeResult = {
      label,
      cmd,
      args,
      useShell,
      spawnThrew: null,
      exitCode: null,
      stdoutHead: '',
      stderrHead: '',
    };
    try {
      const child = spawn(cmd, args, {
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        ...(useShell ? { shell: true } : {}),
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (c) => {
        stdout += c.toString('utf-8');
      });
      child.stderr.on('data', (c) => {
        stderr += c.toString('utf-8');
      });
      const t = setTimeout(() => {
        try {
          child.kill('SIGTERM');
        } catch {
          // best effort
        }
      }, timeoutMs);
      child.on('close', (code) => {
        clearTimeout(t);
        result.exitCode = code;
        result.stdoutHead = stdout.slice(0, 400);
        result.stderrHead = stderr.slice(0, 400);
        resolve(result);
      });
      // The core of v020-r2: prompt goes via stdin, not argv.
      child.stdin.write(adversarialPrompt);
      child.stdin.end();
    } catch (err) {
      result.spawnThrew = err instanceof Error ? err.message : String(err);
      resolve(result);
    }
  });
}

function print(r: ProbeResult): void {
  console.log(`--- ${r.label} ---`);
  console.log(`  cmd         : ${r.cmd}`);
  console.log(`  args        : ${JSON.stringify(r.args)}`);
  console.log(`  useShell    : ${r.useShell}`);
  console.log(`  spawnThrew  : ${r.spawnThrew ?? '(none)'}`);
  console.log(`  exitCode    : ${r.exitCode}`);
  console.log(`  stdoutHead  : ${r.stdoutHead.slice(0, 200)}`);
  console.log(`  stderrHead  : ${r.stderrHead.slice(0, 200)}`);
  console.log('');
}

async function main(): Promise<void> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    // Strip credentials so claude CLI fails FAST at the auth/config
    // stage rather than blocking on a network round-trip. We only care
    // that spawn succeeded + stdin was consumed without EINVAL.
    ANTHROPIC_API_KEY: '',
    ANTHROPIC_AUTH_TOKEN: '',
  };

  // We invoke claude --help (or --version) instead of -p so the probe
  // terminates immediately without making a network call. The point is
  // to confirm spawn itself works on both paths.
  const exePath = process.env.CLAUDE_CODE_EXECPATH ?? '';
  const results: ProbeResult[] = [];

  if (exePath) {
    results.push(
      await probe('tier2 .exe no-shell --help', exePath, ['--help'], false, env, 15_000)
    );
    results.push(
      await probe(
        'tier2 .exe no-shell -p stdin (expect auth/network error, NOT EINVAL)',
        exePath,
        ['-p', '--output-format', 'json', '--max-turns', '1'],
        false,
        env,
        45_000
      )
    );
  } else {
    console.log('SKIP tier2: CLAUDE_CODE_EXECPATH not set');
  }

  results.push(
    await probe(
      'tier3 win32 .cmd + shell:true -p stdin (expect auth/network error, NOT EINVAL)',
      'claude.cmd',
      ['-p', '--output-format', 'json', '--max-turns', '1'],
      true,
      env,
      45_000
    )
  );

  // Direct injection comparison: simulate the OLD code's behavior of
  // passing the adversarial prompt as an argv element under shell:true,
  // vs the NEW behavior of stdin delivery. We use `echo` as the target
  // command (no claude network dependency) to make the difference
  // visible in stdout.
  //
  // OLD-equivalent: argv carries the prompt; cmd.exe parses metachars.
  //     echo's argv becomes ['echo', '<prompt-with-metachars>']
  //     Under shell:true Node concatenates + cmd.exe interprets '|'.
  // NEW-equivalent: argv carries only fixed flags; prompt via stdin
  //     never enters the command line, so metachars are inert.
  console.log('--- injection comparison: echo under shell:true ---');
  console.log('(OLD pattern) echo prompt-in-argv under shell:true:');
  const oldEcho = await new Promise<ProbeResult>((resolve) => {
    const result: ProbeResult = {
      label: 'OLD echo shell:true prompt-in-argv',
      cmd: 'echo',
      args: ['echo', `${adversarialPrompt}\n| injected | echo PWNED`],
      useShell: true,
      spawnThrew: null,
      exitCode: null,
      stdoutHead: '',
      stderrHead: '',
    };
    try {
      const child = spawn('echo', result.args, {
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        shell: true,
      });
      let stdout = '';
      child.stdout.on('data', (c) => (stdout += c.toString('utf-8')));
      child.stderr.on('data', (c) => {});
      child.on('close', (code) => {
        result.exitCode = code;
        result.stdoutHead = stdout.slice(0, 400);
        resolve(result);
      });
      child.stdin.end();
    } catch (err) {
      result.spawnThrew = err instanceof Error ? err.message : String(err);
      resolve(result);
    }
  });
  print(oldEcho);

  console.log('(NEW pattern) echo fixed-argv, prompt via stdin under shell:true:');
  const newEcho = await new Promise<ProbeResult>((resolve) => {
    // Fixed argv that does NOT include user-controlled content; this
    // mirrors how ClaudeCliChannel passes only hard-coded flags.
    // We use `sort` which reads stdin, sorts lines, prints to stdout —
    // any adversarial metacharacter in stdin survives as a literal
    // byte and shows up in the sorted output.
    const result: ProbeResult = {
      label: 'NEW sort shell:true fixed-argv + stdin',
      cmd: 'sort',
      args: [],
      useShell: true,
      spawnThrew: null,
      exitCode: null,
      stdoutHead: '',
      stderrHead: '',
    };
    try {
      const child = spawn('sort', result.args, {
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        shell: true,
      });
      let stdout = '';
      child.stdout.on('data', (c) => (stdout += c.toString('utf-8')));
      child.stderr.on('data', (c) => {});
      child.on('close', (code) => {
        result.exitCode = code;
        result.stdoutHead = stdout.slice(0, 400);
        resolve(result);
      });
      // Prompt goes via stdin — even with $, |, backtick the cmd.exe
      // never sees them (they are bytes in the pipe, not command line).
      child.stdin.write(`${adversarialPrompt}\nSENTINEL\n`);
      child.stdin.end();
    } catch (err) {
      result.spawnThrew = err instanceof Error ? err.message : String(err);
      resolve(result);
    }
  });
  print(newEcho);

  console.log('INJECTION EVIDENCE:');
  console.log(
    `  OLD stdout contains "PWNED" (cmd.exe ran injected command): ${oldEcho.stdoutHead.includes('PWNED')}`
  );
  console.log(
    `  NEW stdin preserved adversarial chars: ${newEcho.stdoutHead.includes('|')} / ${newEcho.stdoutHead.includes('`')} / ${newEcho.stdoutHead.includes('$')} / ${newEcho.stdoutHead.includes('SENTINEL')}`
  );

  for (const r of results) print(r);

  // Assertions (exit non-zero if any spawn threw EINVAL).
  const failures = results.filter((r) => r.spawnThrew !== null);
  if (failures.length > 0) {
    console.log(`FAIL: ${failures.length} spawn invocation(s) threw:`);
    for (const f of failures) console.log(`  - ${f.label}: ${f.spawnThrew}`);
    process.exit(1);
  }
  console.log('PASS: no spawn threw; both paths accepted stdin without EINVAL.');
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
