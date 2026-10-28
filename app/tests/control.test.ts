import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';
import ts from 'typescript';

const exports: any = {};
vm.runInNewContext(ts.transpileModule(readFileSync(new URL('../src/lib/control.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText, { exports, Date, Math, Number });

test('sizes read like a file manager', () => {
  assert.equal(exports.bytes(0), '0 B');
  assert.equal(exports.bytes(512), '512 B');
  assert.equal(exports.bytes(1536), '1.5 KB');
  assert.equal(exports.bytes(16876511232), '15.7 GB');
  assert.equal(exports.bytes(270553174016), '252 GB');
});

test('durations keep the two biggest units', () => {
  assert.equal(exports.duration(45), '45s');
  assert.equal(exports.duration(720), '12m');
  assert.equal(exports.duration(3 * 3600), '3h');
  assert.equal(exports.duration(3 * 3600 + 12 * 60), '3h 12m');
  assert.equal(exports.duration(2 * 86400 + 4 * 3600 + 59), '2d 4h');
});

for (const [locale, friday] of [['en-GB', /^Fri /], ['da-DK', /^fre\. /]] as const) {
test(`next run is relative when soon and uses the ${locale} weekday within the week`, () => {
  class LocalDate extends Date {
    toLocaleDateString(_locales?: Intl.LocalesArgument, options?: Intl.DateTimeFormatOptions) {
      return super.toLocaleDateString(locale, options);
    }
    toLocaleTimeString(_locales?: Intl.LocalesArgument, options?: Intl.DateTimeFormatOptions) {
      return super.toLocaleTimeString(locale, options);
    }
  }
  const localized: any = {};
  vm.runInNewContext(ts.transpileModule(readFileSync(new URL('../src/lib/control.ts', import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, { exports: localized, Date: LocalDate, Math, Number });
  const now = new Date(2026, 9, 6, 8, 0, 0); // Tue 6 Oct 2026, 08:00 local
  const at = (d: number, h: number, m = 0) => new Date(2026, 9, d, h, m).toISOString();
  assert.equal(localized.whenNext(at(6, 8, 0), now), 'any moment');
  assert.equal(localized.whenNext(at(6, 8, 25), now), 'in 25 min');
  assert.match(localized.whenNext(at(6, 21), now), /^today /);
  assert.match(localized.whenNext(at(7, 9), now), /^tomorrow /);
  assert.match(localized.whenNext(at(9, 9), now), friday);
  assert.equal(localized.whenNext(null, now), '');
  assert.equal(localized.whenNext('invalid', now), '');
});
}

test('log lines are tagged by level and split from their timestamp', () => {
  const line = '2026-10-06 08:35:09,550 WARNING gateway.run: Skipping auto-resume';
  assert.equal(exports.logLevel(line), 'warn');
  assert.equal(exports.logLevel('2026-10-06 08:35:09,550 ERROR x: boom'), 'error');
  assert.equal(exports.logLevel('Traceback (most recent call last):'), null);
  assert.deepEqual([...exports.splitLogLine(line)], ['08:35:09', 'WARNING gateway.run: Skipping auto-resume']);
  assert.deepEqual([...exports.splitLogLine('  File "x.py"')], ['', '  File "x.py"']);
});

test("Hermes's schedule errors shorten to their first line", () => {
  assert.equal(exports.firstLine("Invalid schedule 'whenever'. Use:\n  - Interval: '30m'"), "Invalid schedule 'whenever'.");
  assert.equal(exports.firstLine('Bad cron.'), 'Bad cron.');
});

test('idempotency keys differ', () => {
  assert.notEqual(exports.idempotencyKey(), exports.idempotencyKey());
});
