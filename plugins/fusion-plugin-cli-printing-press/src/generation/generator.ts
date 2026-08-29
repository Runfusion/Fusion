import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { GenerateCliInput, GeneratedCliArtifact } from "./types.js";

function buildScript(draftJson: string): string {
  return `#!/usr/bin/env node
const draft = ${draftJson};

function parseArgs(argv) {
  const parsed = { endpoint: "", params: {} };
  for (let i = 0; i < argv.length; i += 1) {
    const part = argv[i];
    if (part === "--endpoint") {
      parsed.endpoint = String(argv[i + 1] ?? "");
      i += 1;
      continue;
    }
    if (part.startsWith("--")) {
      const key = part.slice(2);
      const next = argv[i + 1];
      if (next === undefined || String(next).startsWith("--")) {
        parsed.params[key] = true;
      } else {
        parsed.params[key] = String(next);
        i += 1;
      }
    }
  }
  return parsed;
}

function endpointUrl(baseUrl, path) {
  return new URL(path, baseUrl).toString();
}

(async () => {
  const args = parseArgs(process.argv.slice(2));
  const endpoint = draft.endpoints.find((item) => item.id === args.endpoint);
  if (!endpoint) {
    process.stderr.write(\`Unknown endpoint: \${args.endpoint}\\n\`);
    process.exit(2);
  }

  const method = endpoint.method || "GET";
  const url = endpointUrl(draft.baseUrl, endpoint.path || "/");
  const headers = { "content-type": "application/json" };

  if (draft.credential?.kind === "apiKey") {
    const envValue = process.env[draft.credential.envVar] ?? process.env[\`CLIPP_CRED_\${String(draft.credential.envVar).toUpperCase()}\`];
    if (envValue) headers[draft.credential.header] = envValue;
  }
  if (draft.credential?.kind === "bearerToken") {
    const token = process.env[draft.credential.envVar] ?? process.env[\`CLIPP_CRED_\${String(draft.credential.envVar).toUpperCase()}\`];
    if (token) headers.authorization = \`Bearer \${token}\`;
  }
  if (draft.credential?.kind === "basicAuth") {
    const username = process.env[draft.credential.usernameEnvVar] ?? process.env[\`CLIPP_CRED_\${String(draft.credential.usernameEnvVar).toUpperCase()}\`];
    const password = process.env[draft.credential.passwordEnvVar] ?? process.env[\`CLIPP_CRED_\${String(draft.credential.passwordEnvVar).toUpperCase()}\`];
    if (username || password) {
      headers.authorization = "Basic " + Buffer.from(String(username ?? "") + ":" + String(password ?? "")).toString("base64");
    }
  }

  const body = method === "GET" || method === "DELETE" ? undefined : JSON.stringify(args.params);
  const response = await fetch(url, { method, headers, body });
  const text = await response.text();
  if (!response.ok) {
    process.stderr.write(text || \`HTTP \${response.status}\\n\`);
    process.exit(1);
  }
  process.stdout.write(text);
})().catch((error) => {
  process.stderr.write(String(error?.message ?? error));
  process.exit(1);
});
`;
}

export async function generateCli({ draft, outDir }: GenerateCliInput): Promise<GeneratedCliArtifact> {
  await mkdir(outDir, { recursive: true });
  const binPath = join(outDir, `${draft.slug}.mjs`);
  await writeFile(binPath, buildScript(JSON.stringify(draft)), "utf8");

  if (process.platform !== "win32") {
    await chmod(binPath, 0o755);
  }

  return {
    draftId: draft.id,
    slug: draft.slug,
    binPath,
    entrypoint: "node",
    generatedAt: new Date().toISOString(),
  };
}
