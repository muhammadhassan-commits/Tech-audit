// Build step: freeze the checkpoint table (status / severity / reason_code per PRD condition row)
// from the Source Reference file into src/engine/checkpoints.generated.json.
// The engine reads the frozen copy, so an edit to the register cannot silently change audit logic;
// `npm run check:sources` reports any drift between the two.
import fs from 'node:fs';
import path from 'node:path';
import { getRegister } from './register.js';
import { PROJECT_ROOT } from '../config.js';

export const GENERATED_PATH = path.join(PROJECT_ROOT, 'src', 'engine', 'checkpoints.generated.json');

export function normaliseStatus(s) {
  const t = String(s || '').trim();
  if (['PASS', 'WARN', 'FAIL', 'NOT_APPLICABLE', 'NOT_TESTABLE'].includes(t)) return t;
  if (/^INFO/.test(t)) return 'PASS';
  if (/^NOT_TESTABLE/.test(t)) return 'NOT_TESTABLE';
  return 'NOTE';
}

export function buildCheckpointTable(reg = getRegister()) {
  const out = {};
  for (const cp of reg.checkpoints.values()) {
    out[cp.checkpoint] = {
      check_id: cp.check_id,
      status: normaliseStatus(cp.status),
      status_text: cp.status,
      severity: /^(CRITICAL|HIGH|MEDIUM|LOW)$/.test(cp.severity) ? cp.severity : null,
      reason_code: cp.reason_code,
      condition: cp.condition,
      reason_text: cp.reason_text,
    };
  }
  return out;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))) {
  const table = buildCheckpointTable();
  fs.writeFileSync(GENERATED_PATH, JSON.stringify(table, null, 1));
  console.log(`Wrote ${Object.keys(table).length} checkpoints → ${GENERATED_PATH}`);
}
