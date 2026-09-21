/**
 * Generate the bcrypt hash for ADMIN_PASSWORD_HASH.
 *
 *   npm run hash-password
 *
 * Reads one line from the terminal without echoing it, so the password does
 * not end up in your shell history *or* in the scrollback. Only the hash is
 * printed.
 */
import { createInterface } from 'node:readline';
import { stdin, stdout, stderr } from 'node:process';
import bcrypt from 'bcryptjs';

const ROUNDS = 12;

/**
 * Prompt with the typed characters suppressed.
 *
 * readline echoes by default, so the output stream is intercepted while the
 * answer is being typed. Falls back to visible input when stdin is not a TTY
 * (a pipe, or CI), because there is nothing to hide in that case.
 */
function askHidden(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: stdin, output: stdout, terminal: true });
    let muted = false;

    const write = stdout.write.bind(stdout);
    (stdout as { write: (chunk: string | Uint8Array) => boolean }).write = (chunk) =>
      muted ? true : write(chunk as string);

    stderr.write(prompt);
    muted = stdin.isTTY === true;

    rl.question('', (answer) => {
      muted = false;
      (stdout as { write: typeof write }).write = write;
      stderr.write('\n');
      rl.close();
      resolve(answer);
    });
  });
}

async function readPassword(): Promise<string> {
  const fromArgv = process.argv[2];
  if (fromArgv) {
    stderr.write(
      'Warning: passing the password as an argument puts it in your shell history.\n',
    );
    return fromArgv;
  }
  return askHidden('Admin password (not shown): ');
}

const password = (await readPassword()).trim();

if (password.length < 10) {
  stderr.write('Refusing: use at least 10 characters.\n');
  process.exit(1);
}

const hash = await bcrypt.hash(password, ROUNDS);

// Single quotes matter: a bcrypt hash is full of `$`, and Docker Compose reads
// an unquoted `$NAME` in .env as a variable to substitute. Without the quotes
// the container receives a mangled hash and refuses to start.
stderr.write('\nAdd this line to .env, keeping the quotes:\n\n');
stdout.write(`ADMIN_PASSWORD_HASH='${hash}'\n`);
