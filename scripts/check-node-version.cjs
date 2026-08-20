#!/usr/bin/env node

const {
  buildUnsupportedNodeBlockBanner,
  isSupportedNodeVersion,
} = require('./node-version-banner.cjs');

const nodeVersion = process.versions.node;

if (!isSupportedNodeVersion(nodeVersion) && !process.env.CODEGRAPH_ALLOW_UNSAFE_NODE) {
  console.error(buildUnsupportedNodeBlockBanner(nodeVersion));
  process.exit(1);
}
