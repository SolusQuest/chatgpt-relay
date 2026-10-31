import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const publicRepositoryUrl = "git+https://github.com/SolusQuest/chatgpt-relay.git";
const requiredFiles = [
  ".gitattributes",
  ".github/workflows/ci.yml",
  "CONTRIBUTING.md",
  "LICENSE",
  "README.md",
  "SECURITY.md",
  "agent-instructions.md",
  "api.md",
];

const cjkDataFiles = new Set([
  "extension/content-script.js",
  "test/e2e-fake-extension.test.ts",
  "test/encoding-fix.test.ts",
  "test/effort.test.ts",
  "test/error-info.test.ts",
  "test/extension-page-readiness.test.ts",
  "test/extension-session-creation.test.ts",
  "test/recovery.test.ts",
  "test/session-diagnostics.test.ts",
  "test/v1-api.test.ts",
]);

const cjkPattern = /\p{Script=Han}/u;
const commentPrefix = /^\s*(?:\/\/|\/\*|\*|--)/;
const windowsLocalPath = /\b[A-Za-z]:\\(?:Users|code|dev|src)\\/i;
const unixHomePath = /\/(?:home|Users)\/[A-Za-z0-9._-]+\//;
const markdownUuid = /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/i;
const formerPrivateProjectName = ["cgcon", "v3"].join("-");
const secretPatterns = [
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
];

const failures: string[] = [];

for (const file of requiredFiles) {
  try {
    readFileSync(join(root, file));
  } catch {
    failures.push(`${file}: required public-release file is missing`);
  }
}

const tracked = execFileSync(
  "git",
  ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
  {
    cwd: root,
    encoding: "utf8",
  },
)
  .split("\0")
  .filter((file) => file && existsSync(join(root, file)));

for (const file of tracked) {
  const buffer = readFileSync(join(root, file));
  if (buffer.includes(0)) continue;

  const text = buffer.toString("utf8");
  const lines = text.split(/\r?\n/);

  for (const [index, line] of lines.entries()) {
    const location = `${file}:${index + 1}`;

    if (
      windowsLocalPath.test(line) ||
      unixHomePath.test(line) ||
      line.includes(formerPrivateProjectName)
    ) {
      failures.push(`${location}: machine-specific path or former private project name`);
    }

    if (secretPatterns.some((pattern) => pattern.test(line))) {
      failures.push(`${location}: possible credential or private key`);
    }

    if (file.endsWith(".md") && markdownUuid.test(line)) {
      failures.push(`${location}: real-looking UUID in public documentation`);
    }

    if (cjkPattern.test(line)) {
      if (file.endsWith(".md")) {
        failures.push(`${location}: canonical Markdown documentation must be English`);
      } else if (commentPrefix.test(line)) {
        failures.push(`${location}: source comments must be English`);
      } else if (!cjkDataFiles.has(file)) {
        failures.push(`${location}: CJK text is outside the functional data allowlist`);
      }
    }
  }
}

const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
if (packageJson.license !== "MIT") {
  failures.push("package.json: license must match the root MIT License");
}
if (packageJson.engines?.node !== ">=22.18.0") {
  failures.push("package.json: engines.node must match the documented Node.js requirement");
}
if (!packageJson.description || cjkPattern.test(packageJson.description)) {
  failures.push("package.json: description must be a non-empty English string");
}
if (packageJson.repository?.url !== publicRepositoryUrl) {
  failures.push("package.json: repository URL must match the public GitHub repository");
}
if (packageJson.homepage !== "https://github.com/SolusQuest/chatgpt-relay#readme") {
  failures.push("package.json: homepage must point to the public GitHub repository");
}
if (packageJson.bugs?.url !== "https://github.com/SolusQuest/chatgpt-relay/issues") {
  failures.push("package.json: bugs URL must point to the public GitHub issue tracker");
}

if (failures.length > 0) {
  console.error("Public-release hygiene check failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(`Public-release hygiene check passed for ${tracked.length} repository files.`);
