"use strict";

const APP_INITIAL_ASSET_PATTERN = /^app-initial-[^.]+\.js$/;
const STYLE_ID = "codex-linux-ui-tweaks-composer-model-chip-style";
const RUNTIME_MARKER = "codexLinuxUiTweaksComposerModelChipRuntime";

const COMPOSER_CHIP_MARKERS = ["data-codex-intelligence-trigger"];

const COMPOSER_CHIP_CSS = [
  "button[data-codex-intelligence-trigger]{",
  "background:color-mix(in srgb, currentColor 8%, transparent);",
  "padding-inline:11px;",
  "}",
  "button[data-codex-intelligence-trigger] span.gap-1\\.5{gap:4px;}",
  "button[data-codex-intelligence-trigger] span.gap-1\\.5 > span:last-child{opacity:.62;}",
].join("");

function warn(message) {
  console.warn(`WARN: ${message} - skipping ui-tweaks composer model chip patch`);
}

function composerModelChipRuntimeSource(css = COMPOSER_CHIP_CSS) {
  return [
    `;(()=>{const ${RUNTIME_MARKER}=true;`,
    `const STYLE_ID=${JSON.stringify(STYLE_ID)};`,
    `const CSS=${JSON.stringify(css)};`,
    `function install(){if(typeof document==="undefined")return;const target=document.head||document.documentElement;if(!target)return;let style=document.getElementById(STYLE_ID);if(style){style.textContent!==CSS&&(style.textContent=CSS);return}style=document.createElement("style");style.id=STYLE_ID;style.textContent=CSS;target.appendChild(style)}`,
    `document.readyState==="loading"&&document.addEventListener("DOMContentLoaded",install,{once:true});install();})();`,
  ].join("");
}

function composerModelChipConfig(context) {
  const defaults = context?.feature?.manifest?.tweaks?.composer?.modelChip;
  const settings = context?.feature?.settings?.tweaks?.composer?.modelChip;
  return {
    ...(defaults != null && typeof defaults === "object" && !Array.isArray(defaults) ? defaults : {}),
    ...(settings != null && typeof settings === "object" && !Array.isArray(settings) ? settings : {}),
  };
}

function applyComposerModelChipPatch(source, context = {}) {
  try {
    if (typeof source !== "string") {
      warn("Asset source is not a string");
      return source;
    }

    const config = composerModelChipConfig(context);
    if (config.enabled === false || source.includes(RUNTIME_MARKER) || source.includes(STYLE_ID)) {
      return source;
    }

    if (!COMPOSER_CHIP_MARKERS.every((marker) => source.includes(marker))) {
      if (context.warnOnMissingMarkers === true) {
        warn("Could not find current composer model chip markers");
      }
      return source;
    }

    return `${source}\n${composerModelChipRuntimeSource()}`;
  } catch (error) {
    warn(`Unexpected error: ${error instanceof Error ? error.message : String(error)}`);
    return source;
  }
}

const descriptors = [
  {
    id: "composer-model-chip-style",
    phase: "webview-asset",
    order: 20_795,
    ciPolicy: "optional",
    pattern: APP_INITIAL_ASSET_PATTERN,
    missingDescription: "app initial bundle",
    skipDescription: "ui-tweaks composer model chip style patch",
    apply: (source, context = {}) =>
      applyComposerModelChipPatch(source, { ...context, warnOnMissingMarkers: true }),
  },
];

module.exports = {
  APP_INITIAL_ASSET_PATTERN,
  COMPOSER_CHIP_CSS,
  RUNTIME_MARKER,
  STYLE_ID,
  applyComposerModelChipPatch,
  composerModelChipRuntimeSource,
  descriptors,
};
