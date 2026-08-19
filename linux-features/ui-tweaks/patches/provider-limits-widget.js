"use strict";

const fs = require("fs");
const path = require("path");

const APP_INITIAL_ASSET_PATTERN = /^app-initial-[^.]+\.js$/;
const RUNTIME_MARKER = "codexLinuxUiTweaksProviderLimitsWidgetRuntime";
const WIDGET_ID = "codex-linux-provider-limits-widget";
const LIMITS_URL = "http://127.0.0.1:4001/limits.json";
const CSP_ORIGIN = "http://127.0.0.1:4001";

function warn(message) {
  console.warn(`WARN: ${message} - skipping ui-tweaks provider limits widget patch`);
}

// Runtime injected into the app bundle: polls the local shim's /limits.json
// and renders compact usage bars above the sidebar footer host badge.
function providerLimitsRuntimeSource() {
  return [
    `;(()=>{const ${RUNTIME_MARKER}=true;`,
    `const WIDGET_ID=${JSON.stringify(WIDGET_ID)};`,
    `const LIMITS_URL=${JSON.stringify(LIMITS_URL)};`,
    `function row(name,pct,sub){const c=pct>=90?"#e5534b":pct>=70?"#d4a72c":"#57ab5a";`,
    `return '<div style="display:flex;align-items:center;gap:8px;margin:3px 0"><span style="width:64px;color:#9a9a9a">'+name+'</span>'+`,
    `'<span style="flex:1;height:4px;background:rgba(128,128,128,.18);border-radius:2px;overflow:hidden"><span style="display:block;width:'+Math.min(100,pct)+'%;height:100%;background:'+c+'"></span></span>'+`,
    `'<span style="width:66px;text-align:right;color:#9a9a9a">'+pct+'% '+sub+'</span></div>';}`,
    `function render(data){`,
    `const footer=[...document.querySelectorAll('div.absolute.inset-x-0.bottom-0')].find(d=>d.querySelector('button'));`,
    `if(!footer)return;`,
    `let w=document.getElementById(WIDGET_ID);`,
    `if(w&&w.parentElement!==footer){w.remove();w=null;}`,
    `if(!w){w=document.createElement('div');w.id=WIDGET_ID;footer.insertBefore(w,footer.firstChild);}`,
    `let rows='';`,
    `const u=data&&data.opencode&&data.opencode.json&&data.opencode.json.usage;`,
    `if(u&&u.weekly)rows+=row('OpenCode',u.weekly.percent,'wk');`,
    `const g=data&&data.chatgpt&&data.chatgpt.json&&data.chatgpt.json.rate_limit;`,
    `if(g&&g.primary_window){const d=Math.round(g.primary_window.limit_window_seconds/86400);rows+=row('ChatGPT',g.primary_window.used_percent,d+'d');}`,
    `if(!rows){w.remove();return;}`,
    `w.innerHTML='<div style="padding:8px 16px 6px;font:11px/1.4 system-ui;border-top:1px solid rgba(128,128,128,.12)">'+rows+'</div>';}`,
    `function tick(){if(typeof document==="undefined")return;const d=window.__codexLinuxProviderLimits;if(d)render(d);}`,
    `setInterval(tick,10000);`,
    `document.readyState==="loading"?document.addEventListener("DOMContentLoaded",()=>setTimeout(tick,5000),{once:true}):setTimeout(tick,5000);`,
    `})();`,
  ].join("");
}


// Main-process runtime: polls the local shim (renderer network policy blocks
// direct fetches) and pushes limits data into every renderer.
const MAIN_RUNTIME_MARKER = "codexLinuxUiTweaksProviderLimitsMainRuntime";

function providerLimitsMainRuntimeSource() {
  return [
    `;(()=>{const ${MAIN_RUNTIME_MARKER}=true;try{`,
    `const LIMITS_URL=${JSON.stringify(LIMITS_URL)};`,
    `function push(){fetch(LIMITS_URL).then(r=>r.json()).then(data=>{`,
    `try{const{webContents}=require("electron");const payload=JSON.stringify(data);`,
    `for(const wc of webContents.getAllWebContents()){`,
    `wc.executeJavaScript("window.__codexLinuxProviderLimits="+payload+";true").catch(()=>{});`,
    `}}catch(e){}`,
    `}).catch(()=>{});}`,
    `setTimeout(push,15000);setInterval(push,60000);`,
    `}catch(e){}})();`,
  ].join("");
}

function applyProviderLimitsMainPatch(source, context = {}) {
  try {
    if (typeof source !== "string") {
      warn("Main bundle source is not a string");
      return source;
    }
    const config = providerLimitsConfig(context);
    if (config.enabled === false || source.includes(MAIN_RUNTIME_MARKER)) {
      return source;
    }
    return `${source}\n${providerLimitsMainRuntimeSource()}`;
  } catch (error) {
    warn(`Unexpected error: ${error instanceof Error ? error.message : String(error)}`);
    return source;
  }
}

function providerLimitsConfig(context) {
  const defaults = context?.feature?.manifest?.tweaks?.sidebar?.providerLimits;
  const settings = context?.feature?.settings?.tweaks?.sidebar?.providerLimits;
  return {
    ...(defaults != null && typeof defaults === "object" && !Array.isArray(defaults) ? defaults : {}),
    ...(settings != null && typeof settings === "object" && !Array.isArray(settings) ? settings : {}),
  };
}

function applyProviderLimitsWidgetPatch(source, context = {}) {
  try {
    if (typeof source !== "string") {
      warn("Asset source is not a string");
      return source;
    }
    const config = providerLimitsConfig(context);
    if (config.enabled === false || source.includes(RUNTIME_MARKER)) {
      return source;
    }
    return `${source}\n${providerLimitsRuntimeSource()}`;
  } catch (error) {
    warn(`Unexpected error: ${error instanceof Error ? error.message : String(error)}`);
    return source;
  }
}

// Amend the webview CSP so the renderer may talk to the local shim.
function patchWebviewCsp(extractedDir, context = {}) {
  const config = providerLimitsConfig(context);
  if (config.enabled === false) {
    return { matched: 0, changed: 0, reason: "disabled" };
  }
  const indexPath = path.join(extractedDir, "webview", "index.html");
  if (!fs.existsSync(indexPath)) {
    return { matched: 0, changed: 0, reason: "webview index.html not found" };
  }
  const source = fs.readFileSync(indexPath, "utf8");
  if (source.includes(CSP_ORIGIN)) {
    return { matched: 1, changed: 0 };
  }
  const marker = "connect-src ";
  const idx = source.indexOf(marker);
  if (idx === -1) {
    return { matched: 0, changed: 0, reason: "connect-src directive not found" };
  }
  const patched =
    source.slice(0, idx + marker.length) + `${CSP_ORIGIN} ` + source.slice(idx + marker.length);
  fs.writeFileSync(indexPath, patched);
  return { matched: 1, changed: 1 };
}

const descriptors = [
  {
    id: "provider-limits-widget-main-process",
    phase: "main-bundle",
    order: 20_794,
    ciPolicy: "optional",
    apply: (source, context = {}) => applyProviderLimitsMainPatch(source, context),
  },
  {
    id: "provider-limits-widget-csp",
    phase: "extracted-app:post-webview",
    order: 20_796,
    ciPolicy: "optional",
    apply: (extractedDir, context = {}) => patchWebviewCsp(extractedDir, context),
    status: (result) => {
      if (result?.matched !== 1) {
        return { status: "skipped-optional", reason: result?.reason ?? null };
      }
      return result.changed > 0 ? "applied" : "already-applied";
    },
  },
  {
    id: "provider-limits-widget-runtime",
    phase: "webview-asset",
    order: 20_797,
    ciPolicy: "optional",
    pattern: APP_INITIAL_ASSET_PATTERN,
    missingDescription: "app initial bundle",
    skipDescription: "ui-tweaks provider limits widget patch",
    apply: (source, context = {}) => applyProviderLimitsWidgetPatch(source, context),
  },
];

module.exports = {
  APP_INITIAL_ASSET_PATTERN,
  CSP_ORIGIN,
  LIMITS_URL,
  RUNTIME_MARKER,
  WIDGET_ID,
  applyProviderLimitsMainPatch,
  applyProviderLimitsWidgetPatch,
  descriptors,
  patchWebviewCsp,
  providerLimitsRuntimeSource,
};
