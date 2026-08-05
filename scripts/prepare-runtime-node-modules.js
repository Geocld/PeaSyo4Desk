const fs = require("node:fs");
const path = require("node:path");

const rootDir = path.resolve(__dirname, "..");
const sourceRoot = path.join(rootDir, "node_modules");
const targetRoot = path.join(rootDir, "build", "runtime-node_modules");

const readJson = (filePath) => JSON.parse(fs.readFileSync(filePath, "utf8"));

const resolvePackageDir = (packageName, fromDir = rootDir) => {
  try {
    const packageJsonPath = require.resolve(`${packageName}/package.json`, {
      paths: [fromDir],
    });
    const packageDir = path.dirname(packageJsonPath);
    if (!path.resolve(packageDir).startsWith(sourceRoot + path.sep)) {
      return null;
    }
    return packageDir;
  } catch {
    return null;
  }
};

const copyPackageDir = (packageDir) => {
  const relativeDir = path.relative(sourceRoot, packageDir);
  if (!relativeDir || relativeDir.startsWith("..") || path.isAbsolute(relativeDir)) {
    return;
  }

  const destinationDir = path.join(targetRoot, relativeDir);
  fs.mkdirSync(path.dirname(destinationDir), { recursive: true });
  fs.cpSync(packageDir, destinationDir, {
    recursive: true,
    dereference: true,
    preserveTimestamps: true,
  });
};

const collectPackageTree = (packageName, fromDir, visitedDirs) => {
  const packageDir = resolvePackageDir(packageName, fromDir);
  if (!packageDir || visitedDirs.has(packageDir)) {
    return;
  }

  visitedDirs.add(packageDir);
  copyPackageDir(packageDir);

  const manifestPath = path.join(packageDir, "package.json");
  const manifest = readJson(manifestPath);
  const dependencyNames = new Set([
    ...Object.keys(manifest.dependencies || {}),
    ...Object.keys(manifest.optionalDependencies || {}),
    ...Object.keys(manifest.peerDependencies || {}),
  ]);

  for (const dependencyName of dependencyNames) {
    collectPackageTree(dependencyName, packageDir, visitedDirs);
  }
};

module.exports = async () => {
  fs.rmSync(targetRoot, { recursive: true, force: true });
  fs.mkdirSync(targetRoot, { recursive: true });

  const packageJson = readJson(path.join(rootDir, "package.json"));
  const visitedDirs = new Set();

  for (const dependencyName of Object.keys(packageJson.dependencies || {})) {
    collectPackageTree(dependencyName, rootDir, visitedDirs);
  }

  console.log(
    `Prepared production dependency staging at ${path.relative(rootDir, targetRoot)}`
  );
};

if (require.main === module) {
  module.exports().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
