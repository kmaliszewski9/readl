#!/usr/bin/env node

require('../src/cli').run().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exitCode = 1;
});
