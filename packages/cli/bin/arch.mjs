#!/usr/bin/env node
/**
 * Executable entry point for the `arch` command.
 *
 * Exists so `package.json#bin` points at a real `.mjs` file: Node will run a
 * `.ts` entry directly on 22.6+, but npm's bin shims and some shells are
 * happier with an explicit JavaScript stub, and this also lets us fail with a
 * clear message on older runtimes instead of a syntax error.
 */

import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import process from 'node:process';

const MINIMUM_MAJOR = 22;
const MINIMUM_MINOR = 6;

const [major = 0, minor = 0] = process.versions.node.split('.').map(Number);
if (major < MINIMUM_MAJOR || (major === MINIMUM_MAJOR && minor < MINIMUM_MINOR)) {
  process.stderr.write(
    `arch needs Node ${MINIMUM_MAJOR}.${MINIMUM_MINOR} or newer to run TypeScript directly.\n` +
      `This is Node ${process.versions.node}.\n`,
  );
  process.exit(2);
}

const here = dirname(fileURLToPath(import.meta.url));
await import(resolve(here, '../src/main.ts'));
