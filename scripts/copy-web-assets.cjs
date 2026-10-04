#!/usr/bin/env node
/*
 * Kopiert nur die tatsächlichen Web-Dateien der App (index.html, css/, js/) nach
 * src-tauri/dist/, damit Tauri nicht aus Versehen das ganze Repo-Root (inkl.
 * node_modules/, .git/, src-tauri/ selbst, README, ...) als "Frontend" einpackt.
 *
 * Wird von Tauri automatisch vor jedem `tauri dev`/`tauri build` ausgeführt
 * (siehe build.beforeDevCommand/beforeBuildCommand in src-tauri/tauri.conf.json).
 * Reiner Kopiervorgang, kein Build-Schritt für die App-Logik selbst.
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const DIST = path.join(ROOT, "src-tauri", "dist");

const ITEMS = ["index.html", "css", "js"];

function copyRecursive(src, dest) {
  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(src)) {
      copyRecursive(path.join(src, entry), path.join(dest, entry));
    }
  } else {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
  }
}

fs.rmSync(DIST, { recursive: true, force: true });
fs.mkdirSync(DIST, { recursive: true });

for (const item of ITEMS) {
  const src = path.join(ROOT, item);
  if (!fs.existsSync(src)) {
    console.error(`copy-web-assets: erwartete Datei/Ordner fehlt: ${src}`);
    process.exit(1);
  }
  copyRecursive(src, path.join(DIST, item));
}

console.log(`copy-web-assets: ${ITEMS.join(", ")} -> ${path.relative(ROOT, DIST)}`);
