import fs from 'node:fs';
import path from 'node:path';
import libpq from 'libpg-query';

await libpq.loadModule();
const { parseSync } = libpq;

const dir = 'supabase/migrations';
const files = fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort();
let bad = 0;
for (const f of files) {
  const sql = fs.readFileSync(path.join(dir, f), 'utf8');
  try {
    parseSync(sql);
    console.log('OK ', f, '(' + sql.length + ' bytes)');
  } catch (e) {
    bad++;
    console.error('FAIL ', f, '\n   ', e.message ?? e);
  }
}
process.exit(bad ? 1 : 0);
