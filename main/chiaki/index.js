const path = require("path");

const candidates = [
  path.join(__dirname, "chiaki.node"),
];

let binding = null;
let lastError = null;

for (const addonPath of candidates) {
  try {
    binding = require(addonPath);
    break;
  } catch (err) {
    lastError = err;
  }
}

if (!binding) {
  const cause = lastError ? `\nOriginal error: ${lastError.message}` : "";
  throw new Error(
    "Failed to load native addon 'chiaki.node'. Run `npm run build` first." + cause
  );
}

module.exports = binding;
