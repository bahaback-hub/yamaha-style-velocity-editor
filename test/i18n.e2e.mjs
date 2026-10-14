/**
 * Arabic interface smoke checks.
 *
 * Arabic is the default language; English is one click away and pinned with
 * ?lang=en (which is how the other suites keep their English assertions).
 * This suite proves the default, the toggle both ways, the URL override and
 * the persistence — in a real browser, where dir=rtl actually applies.
 */

import { chromium } from '@playwright/test';

const BASE = `http://localhost:${process.env.PORT ?? '5173'}/`;

const browser = await chromium.launch();
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message.slice(0, 100)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 100)); });

const checks = [];
const check = (name, ok, detail = '') => {
  checks.push({ name, ok });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

// ---- default: Arabic ---------------------------------------------------------
await page.goto(BASE, { waitUntil: 'load' });
check('page loads without JS errors', errors.length === 0, errors.slice(0, 2).join(' | '));
check('default html lang is ar', await page.evaluate(() => document.documentElement.lang) === 'ar');
check('default direction is rtl', await page.evaluate(() => document.documentElement.dir) === 'rtl');
check('heading is Arabic by default', (await page.locator('header h1').textContent())?.includes('محرر الستايل'));
check('toggle offers English', (await page.locator('#btnLang').textContent())?.trim() === 'EN');

// ---- toggle to English -------------------------------------------------------
await page.locator('#btnLang').click();
check('heading switches to English', (await page.locator('header h1').textContent())?.includes('Style Editor'));
check('direction flips to ltr', await page.evaluate(() => document.documentElement.dir) === 'ltr');
check('toggle offers Arabic', (await page.locator('#btnLang').textContent())?.trim() === 'عربي');
check('drop prompt is English', (await page.locator('#drop strong').textContent())?.includes('Drop a .STY file here'));

// ---- choice persists across reload -------------------------------------------
await page.reload({ waitUntil: 'load' });
check('English persists after reload', (await page.locator('header h1').textContent())?.includes('Style Editor'));

// ---- back to Arabic ------------------------------------------------------------
await page.locator('#btnLang').click();
check('heading switches back to Arabic', (await page.locator('header h1').textContent())?.includes('محرر الستايل'));
check('no JS errors through the toggles', errors.length === 0, errors.slice(0, 2).join(' | '));

// ---- URL override --------------------------------------------------------------
await page.goto(BASE + '?lang=en', { waitUntil: 'load' });
check('?lang=en forces English', (await page.locator('header h1').textContent())?.includes('Style Editor'));

await browser.close();

if (checks.some((c) => !c.ok)) process.exitCode = 1;
