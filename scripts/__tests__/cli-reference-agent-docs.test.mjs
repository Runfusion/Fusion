import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const docPath = path.resolve(__dirname, "../../docs/cli-reference.md");
const doc = readFileSync(docPath, "utf8");

function sectionBody(heading) {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = doc.match(new RegExp(`### ${escaped}\\n\\n([\\s\\S]*?)(?=\\n### |\\n---\\n|$)`));
  assert.ok(match, `Missing section: ${heading}`);
  return match[1];
}

test("cli reference includes dedicated fn agent subcommand sections", () => {
  const stop = sectionBody("`fn agent stop`");
  assert.match(stop, /Usage: `fn agent stop <id>`/);
  assert.match(stop, /already paused/);
  assert.match(stop, /Cannot stop agent .* transition to 'paused'/);
  assert.match(stop, /fn agent stop AGENT-001/);

  const start = sectionBody("`fn agent start`");
  assert.match(start, /Usage: `fn agent start <id>`/);
  assert.match(start, /already running/);
  assert.match(start, /Cannot start agent .* transition to 'active'/);
  assert.match(start, /fn agent start AGENT-001/);

  const mailbox = sectionBody("`fn agent mailbox`");
  assert.match(mailbox, /Usage: `fn agent mailbox <id>`/);
  assert.match(mailbox, /<unreadCount> unread/);
  assert.match(mailbox, /up to 20/);
  assert.match(mailbox, /80 characters/);
  assert.match(mailbox, /fn agent mailbox AGENT-001/);

  const exportSection = sectionBody("`fn agent export`");
  assert.match(exportSection, /Usage: `fn agent export <dir>/);
  assert.match(exportSection, /No agents found to export/);
  assert.match(exportSection, /summary including output directory, agents exported, skills exported, files written/);
  assert.match(exportSection, /--company-name <name>/);
  assert.match(exportSection, /--company-slug <slug>/);
  assert.match(exportSection, /fn agent export \.\/output-dir/);
});
