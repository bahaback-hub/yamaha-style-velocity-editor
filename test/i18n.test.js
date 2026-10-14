import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { t, cnt, getLang, setLang, initLang, LANGS, DEFAULT_LANG } from '../src/i18n.js';

// Reach the dictionaries through behaviour only: parity means every key the
// English UI can ask for also exists in Arabic, and vice versa. Collect the
// keys by probing a broad candidate list gathered from the source.
import { readFileSync } from 'node:fs';

function keysUsedIn(src) {
  const out = new Set();
  for (const m of src.matchAll(/\bt\(\s*['"]([a-z0-9_]+)['"]/g)) out.add(m[1]);
  for (const m of src.matchAll(/data-i18n(?:-aria|-title|-ph)?="([a-z0-9_]+)"/g)) out.add(m[1]);
  return out;
}

describe('i18n dictionary', () => {
  beforeEach(() => {
    setLang('ar');
  });

  it('defaults to Arabic', () => {
    assert.equal(DEFAULT_LANG, 'ar');
    setLang('en');
    assert.equal(getLang(), 'en');
  });

  it('rejects unknown languages', () => {
    setLang('en');
    setLang('xx');
    assert.equal(getLang(), 'en');
  });

  it('falls back to the key itself when missing everywhere', () => {
    setLang('ar');
    assert.equal(t('no_such_key_xyz'), 'no_such_key_xyz');
  });

  it('fills {placeholders}', () => {
    setLang('en');
    assert.equal(t('note_added', { pitch: 'C4', bar: 'Bar 3' }), 'Added C4 at Bar 3.');
    setLang('ar');
    assert.equal(t('note_added', { pitch: 'C4', bar: 'الشريط 3' }), 'أُضيفت C4 عند الشريط 3.');
  });

  it('every key used in code and HTML exists in both languages', () => {
    const files = ['src/app.js', 'src/map-view.js', 'src/note-lift.js', 'src/variation-view.js', 'src/variations.js', 'index.html'];
    const used = new Set();
    for (const f of files) {
      for (const k of keysUsedIn(readFileSync(f, 'utf8'))) used.add(k);
    }
    assert.ok(used.size > 50, `expected a real key surface, got ${used.size}`);
    const missing = [];
    for (const key of used) {
      setLang('en');
      const en = t(key);
      setLang('ar');
      const ar = t(key);
      if (en === key || ar === key) missing.push(`${key} (en=${en === key ? 'MISS' : 'ok'} ar=${ar === key ? 'MISS' : 'ok'})`);
    }
    assert.deepEqual(missing, []);
  });

  it('cnt() plurals: English', () => {
    setLang('en');
    assert.equal(cnt(1, 'note'), '1 note');
    assert.equal(cnt(4, 'note'), '4 notes');
    assert.equal(cnt(0, 'bar'), '0 bars');
  });

  it('cnt() plurals: Arabic tiers (1/2/3-10/11+)', () => {
    setLang('ar');
    assert.equal(cnt(1, 'note'), '1 نوتة');
    assert.equal(cnt(2, 'note'), '2 نوتتان');
    assert.equal(cnt(4, 'note'), '4 نوتات');
    assert.equal(cnt(11, 'note'), '11 نوتة');
    assert.equal(cnt(3, 'variation'), '3 فابوريشنات');
  });

  it('initLang() without a browser keeps the default', () => {
    assert.equal(initLang(), 'ar');
  });

  it('LANGS lists exactly ar and en', () => {
    assert.deepEqual(LANGS, ['ar', 'en']);
  });
});
