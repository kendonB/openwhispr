const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

test("ElevenLabs uses its official mark across provider and remote-model pickers", async (t) => {
  installBrowserGlobals(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-elevenlabs-icon-",
    resolveAlias: { "@": path.resolve(__dirname, "../../src") },
  });
  const icons = await vite.ssrLoadModule("/utils/providerIcons.ts");
  const { ProviderIcon } = await vite.ssrLoadModule("/components/ui/ProviderIcon.tsx");
  const icon = icons.getProviderIcon("elevenlabs");
  assert.match(icon, /^data:image\/svg\+xml,/);
  assert.equal(icons.isMonochromeProvider("elevenlabs"), true);
  assert.deepEqual(icons.getRemoteProviderIcon("elevenlabs"), { icon, invertInDark: true });
  const markup = renderToStaticMarkup(
    React.createElement(ProviderIcon, { provider: "elevenlabs" })
  );
  assert.match(markup, /<img/);
  assert.match(markup, /alt="elevenlabs icon"/);
  assert.match(markup, /icon-monochrome/);
  assert.doesNotMatch(markup, /<svg/);
});
