#!/usr/bin/env node
// runfusion.ai — tiny alias for @runfusion/fusion.
// With no args, launches the Fusion dashboard. With args, forwards to the
// underlying `fn` CLI so `npx runfusion.ai task list` etc. Just Work.

const args = process.argv.slice(2);

if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
  // No subcommand → default to dashboard. Keep --help passthrough explicit
  // so users can discover the full CLI surface via `npx runfusion.ai --help`.
  if (args.length === 0) {
    process.argv = [process.argv[0], process.argv[1], "dashboard"];
  }
}

await import("@runfusion/fusion/dist/bin.js");
