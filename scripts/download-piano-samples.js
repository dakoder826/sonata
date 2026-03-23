#!/usr/bin/env node
/**
 * Downloads Salamander Grand Piano samples into public/piano/
 * so playback works same-origin (no CORS). Run once: node scripts/download-piano-samples.js
 */
const fs = require("fs");
const path = require("path");

const BASE_URL = "https://tonejs.github.io/audio/salamander/";
const FILES = [
  "A0.mp3",
  "C1.mp3",
  "Fs1.mp3",
  "C2.mp3",
  "Fs2.mp3",
  "C3.mp3",
  "Fs3.mp3",
  "C4.mp3",
  "Fs4.mp3",
  "C5.mp3",
  "Fs5.mp3",
  "C6.mp3",
];

const OUT_DIR = path.join(__dirname, "..", "public", "piano");

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  for (const file of FILES) {
    const url = BASE_URL + file;
    process.stdout.write(`Downloading ${file}... `);
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(res.statusText);
      const buf = Buffer.from(await res.arrayBuffer());
      fs.writeFileSync(path.join(OUT_DIR, file), buf);
      console.log("ok");
    } catch (e) {
      console.log("FAIL:", e.message);
    }
  }
  console.log("Done. Piano samples are in public/piano/");
}

main();
