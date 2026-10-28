import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';
import ts from 'typescript';

const exports: any = {};
vm.runInNewContext(ts.transpileModule(readFileSync(new URL('../src/lib/theme.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText, { exports, require: () => ({ Platform: { select: (o: any) => o.default } }) });
const { buildColors, ACCENT_NAMES } = exports;

type RGB = [number, number, number];
function parse(c: string): { rgb: RGB; a: number } {
  if (c.startsWith('#')) {
    const n = parseInt(c.slice(1), 16);
    return { rgb: [(n >> 16) & 255, (n >> 8) & 255, n & 255], a: 1 };
  }
  const m = c.match(/rgba?\(([^)]+)\)/)!;
  const [r, g, b, a = '1'] = m[1].split(',').map((x) => x.trim());
  return { rgb: [Number(r), Number(g), Number(b)], a: Number(a) };
}
/** Composite a (possibly translucent) colour over an opaque one. */
function over(top: string, under: RGB): RGB {
  const { rgb, a } = parse(top);
  return rgb.map((v, i) => v * a + under[i] * (1 - a)) as RGB;
}
function lum([r, g, b]: RGB) {
  const f = (v: number) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}
function ratio(fg: RGB, bg: RGB) {
  const [x, y] = [lum(fg), lum(bg)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

for (const [scheme, tone] of [['light', 'charcoal'], ['dark', 'charcoal'], ['dark', 'graphite'], ['dark', 'black']] as const) {
  for (const accent of ACCENT_NAMES) {
    test(`${scheme}${scheme === 'dark' ? ` (${tone})` : ''} / ${accent}: every text and background pair passes WCAG AA (4.5:1)`, () => {
      const c = buildColors(scheme, accent, tone);
      const bg = parse(c.bg).rgb;
      const surfaces: [string, RGB][] = ['bg', 'surface', 'surfaceRaised', 'surfaceSunken', 'surfaceHigh', 'glassOpaque']
        .map((k) => [k, over(c[k], bg)]);
      surfaces.push(['glass', over(c.glass, bg)]);
      const check = (fgName: string, fg: RGB, bgName: string, under: RGB) => {
        const r = ratio(fg, under);
        assert.ok(r >= 4.5, `${fgName} on ${bgName}: ${r.toFixed(2)}`);
      };
      for (const text of ['text', 'textSecondary', 'textTertiary']) {
        for (const [name, s] of surfaces) check(text, parse(c[text]).rgb, name, s);
      }
      for (const text of ['accent', 'success', 'warning', 'danger']) {
        for (const [name, s] of surfaces.filter(([n]) => n !== 'surfaceHigh')) check(text, parse(c[text]).rgb, name, s);
      }
      // White on your bubbles and primary buttons, at both gradient stops.
      check('onAccent', parse(c.onAccent).rgb, 'accentFill', parse(c.accentFill).rgb);
      check('onAccent', parse(c.onAccent).rgb, 'accentFillLight', parse(c.accentFillLight).rgb);
      // Tinted chips, tonal buttons and status pills, over every surface they sit on.
      for (const [name, s] of surfaces.filter(([n]) => n !== 'surfaceHigh')) {
        check('onAccentSoft', parse(c.onAccentSoft).rgb, `accentSoft/${name}`, over(c.accentSoft, s));
        check('danger', parse(c.danger).rgb, `dangerSoft/${name}`, over(c.dangerSoft, s));
        check('warning', parse(c.warning).rgb, `warningSoft/${name}`, over(c.warningSoft, s));
        check('success', parse(c.success).rgb, `successSoft/${name}`, over(c.successSoft, s));
      }
      check('onDanger', parse(c.onDanger).rgb, 'danger badge', parse(c.danger).rgb);
      for (const syn of ['codeText', 'synKeyword', 'synString', 'synNumber', 'synComment', 'synFunction', 'synType']) {
        check(syn, parse(c[syn]).rgb, 'codeBg', over(c.codeBg, bg));
      }
    });
  }
}

test('dark defaults to charcoal, with graphite and true black available', () => {
  assert.equal(buildColors('dark', 'iris').bg, '#161618');
  assert.equal(buildColors('dark', 'iris', 'graphite').bg, '#0C0C0E');
  assert.equal(buildColors('dark', 'iris', 'black').bg, '#000000');
  assert.equal(buildColors('light', 'iris', 'black').bg, buildColors('light', 'iris').bg);
});
