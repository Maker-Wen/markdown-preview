'use strict';
const fs = require('node:fs/promises');
const { constants } = require('node:fs');

// Callers validate the real path and its scope before opening it.
async function readRegularFile(file) {
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error('只能预览普通文件。');

    const buffer = Buffer.alloc(stat.size + 1);
    let used = 0;
    while (used < buffer.length) {
      const { bytesRead } = await handle.read(buffer, used, buffer.length - used, null);
      if (!bytesRead) break;
      used += bytesRead;
    }
    if (used > stat.size) throw new Error('文件在读取期间发生变化，请重新打开。');
    return buffer.subarray(0, used);
  } finally {
    await handle.close();
  }
}

module.exports = { readRegularFile };
