#!/usr/bin/env node
'use strict';

const { spawnSync } = require('node:child_process');
const path = require('node:path');

const testFile = '.github/tests/close-linked-issues.test.cjs';
const result = spawnSync(process.execPath, ['--test', testFile], {
  cwd: path.resolve(__dirname, '../..'),
  encoding: 'utf8',
  windowsHide: true,
  timeout: 120_000,
});
const output = `${result.stdout || ''}${result.stderr || ''}`;
process.stdout.write(output);
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status || 1);

const tests = output.match(/^# tests (\d+)$/m);
const passed = output.match(/^# pass (\d+)$/m);
const failed = output.match(/^# fail (\d+)$/m);
if (!tests || !passed || !failed) {
  throw new Error(`Could not parse node:test summary for ${testFile}`);
}
const testCount = Number(tests[1]);
const passCount = Number(passed[1]);
const failCount = Number(failed[1]);
if (testCount <= 0 || passCount <= 0 || failCount !== 0) {
  throw new Error(`Invalid ${testFile} result: ${passCount} passed, ${failCount} failed`);
}
const names = [...output.matchAll(/^# Subtest: (.+)$/gm)].map(match => match[1]);
if (!names.length) throw new Error(`No named tests reported for ${testFile}`);
console.log(`REMOTE TEST PASS: ${testFile}; ${passCount} passed, ${failCount} failed; ${names.length} named subtests`);
for (const name of names) console.log(`TEST: ${name}`);
