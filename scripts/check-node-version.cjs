#!/usr/bin/env node

const { buildUnsupportedNodeBlockBanner } = require('./node-version-banner.cjs');

const nodeVersion = process.versions.node;
const nodeMajor = Number.parseInt(nodeVersion.split('.')[0] || '0', 10);

if (nodeMajor >= 24 && !process.env.CODEGRAPH_ALLOW_UNSAFE_NODE) {
  console.error(buildUnsupportedNodeBlockBanner(nodeVersion));
  process.exit(1);
}
