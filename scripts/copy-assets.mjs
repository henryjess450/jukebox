// Non-TS files that must ship next to the compiled output.
import { cpSync, mkdirSync } from 'node:fs';

mkdirSync('dist/db', { recursive: true });
cpSync('src/db/schema.sql', 'dist/db/schema.sql');
console.log('copied schema.sql -> dist/db/');
