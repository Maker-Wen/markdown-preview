#!/usr/bin/env node
'use strict';

const { main } = require('../lib/release.cjs');

main().catch(error => {
  console.error(`安装失败：${error.message}`);
  process.exitCode = Number.isInteger(error.exitCode) && error.exitCode > 0 ? error.exitCode : 1;
});
