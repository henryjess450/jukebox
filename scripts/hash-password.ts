/**
 * Generate the bcrypt hash for ADMIN_PASSWORD_HASH.
 *
 *   npm run hash-password -- 'my admin password'
 *
 * With no argument it reads one line from stdin, which keeps the password out
 * of your shell history.
 */
import { createInterface } from 'node:readline/promises';
import bcrypt from 'bcryptjs';

const ROUNDS = 12;

async function readPassword(): Promise<string> {
  const fromArgv = process.argv[2];
  if (fromArgv) return fromArgv;

  const rl = createInterface({ input: process.stdin, output: process.stderr });
  const answer = await rl.question('Admin password: ');
  rl.close();
  return answer;
}

const password = (await readPassword()).trim();

if (password.length < 10) {
  process.stderr.write('Refusing: use at least 10 characters.\n');
  process.exit(1);
}

const hash = await bcrypt.hash(password, ROUNDS);

// Single quotes matter: a bcrypt hash is full of `$`, and Docker Compose
// reads an unquoted `$NAME` in .env as a variable to substitute. Without the
// quotes the container receives a mangled hash and refuses to start.
process.stderr.write('\nAdd this line to .env, keeping the quotes:\n\n');
process.stdout.write(`ADMIN_PASSWORD_HASH='${hash}'\n`);
