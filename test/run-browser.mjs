/**
 * Run every browser suite, all of them, even after one fails.
 *
 * `npm` scripts chain with `&&`, so the first failing file used to stop the run and
 * quietly hide whatever was broken in the files after it - which is exactly how a
 * whole set of bulk operations sat broken while a shorter suite still reported a
 * pass. Each file sets `process.exitCode` on failure, so the code is latched here
 * and every file is imported regardless.
 */

const SUITES = ['ui', 'inspect', 'editor', 'lift', 'real'];

let failedSuites = 0;

for (const name of SUITES) {
  console.log(`\n--- ${name} ---`);
  process.exitCode = 0;
  try {
    await import(`./${name}.e2e.mjs`);
  } catch (error) {
    failedSuites++;
    console.log(`  ERROR  ${name} threw: ${error.message.split('\n')[0]}`);
  }
  if (process.exitCode) failedSuites++;
}

if (failedSuites) {
  console.log(`\n${failedSuites} of ${SUITES.length} browser suites failed`);
  process.exitCode = 1;
} else {
  console.log(`\nall ${SUITES.length} browser suites passed`);
}