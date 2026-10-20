#!/usr/bin/env node
/*
 * Deterministic frame renderer for the Qurp demo.
 *
 * Usage:
 *   node demo/render.mjs --times=0,3.6,6.9,11.2 --out=/tmp/qurp-preview
 *   node demo/render.mjs --all --out=demo/frames --fps=24 --scale=2
 */
import {spawn} from 'node:child_process';
import {mkdtemp, mkdir, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const htmlPath = path.join(__dirname, 'demo.html');
const args = Object.fromEntries(process.argv.slice(2).map(a => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/);
  return m ? [m[1], m[2] ?? true] : [a, true];
}));

const FPS = Number(args.fps ?? 24);
const DURATION = 13;
const SCALE = Number(args.scale ?? 2);
const OUT = path.resolve(args.out ?? path.join(root, 'demo', 'frames'));
const PREVIEW = args.times ? String(args.times).split(',').map(Number) : null;
const PORT = 9333;

const sleep = ms => new Promise(r => setTimeout(r, ms));

const profile = await mkdtemp(path.join(tmpdir(), 'qurp-chrome-'));
const chrome = spawn('google-chrome', [
  '--headless=new',
  `--remote-debugging-port=${PORT}`,
  '--remote-allow-origins=*',
  `--user-data-dir=${profile}`,
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-background-timer-throttling',
  '--disable-renderer-backgrounding',
  '--disable-backgrounding-occluded-windows',
  '--hide-scrollbars',
  '--force-color-profile=srgb',
  '--font-render-hinting=none',
  '--window-size=1600,900',
  `file://${htmlPath}`,
], {stdio: 'ignore'});

let ws;
let seq = 0;
const pending = new Map();
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++seq;
  pending.set(id, {resolve, reject});
  ws.send(JSON.stringify({id, method, params}));
});

async function connect() {
  for (let i = 0; i < 80; i++) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = targets.find(t => t.type === 'page' && t.url.includes('demo.html'));
      if (page) {
        ws = new WebSocket(page.webSocketDebuggerUrl);
        await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
        ws.onmessage = ev => {
          const msg = JSON.parse(ev.data);
          if (msg.id && pending.has(msg.id)) {
            const {resolve, reject} = pending.get(msg.id);
            pending.delete(msg.id);
            msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
          }
        };
        return;
      }
    } catch {}
    await sleep(150);
  }
  throw new Error('Chrome did not expose the demo page');
}

try {
  await connect();
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', {
    width: 1600, height: 900, deviceScaleFactor: SCALE, mobile: false,
  });
  await send('Runtime.evaluate', {expression: 'window.__ready', awaitPromise: true});

  await mkdir(OUT, {recursive: true});
  const evalFrame = async t => {
    await send('Runtime.evaluate', {
      expression: `window.renderAt(${t}); new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>r(true))))`,
      awaitPromise: true,
    });
  };
  const shot = async file => {
    const {data} = await send('Page.captureScreenshot', {format: 'png', fromSurface: true});
    await writeFile(file, Buffer.from(data, 'base64'));
  };

  if (PREVIEW) {
    for (const t of PREVIEW) {
      await evalFrame(t);
      if (args.probe) {
        const {result} = await send('Runtime.evaluate', {
          expression: `JSON.stringify({
            t: ${t},
            panelOpacity: getComputedStyle(document.getElementById('panel')).opacity,
            panelTransform: document.getElementById('panel').style.transform,
            panelHeight: getComputedStyle(document.getElementById('panel')).height,
            introOpacity: getComputedStyle(document.getElementById('intro')).opacity,
            qsState: document.getElementById('qs-state').textContent,
            qsOpacity: getComputedStyle(document.getElementById('qs')).opacity,
            qurpOpacity: getComputedStyle(document.getElementById('qurp')).opacity,
            capText: document.getElementById('cap-text').textContent,
            finaleOpacity: getComputedStyle(document.getElementById('finale')).opacity,
            bodyOpacity: document.body.style.opacity
          }, null, 2)`,
          returnByValue: true,
        });
        console.log(result.value);
      }
      const file = path.join(OUT, `preview_${String(t).replace('.', '_')}.png`);
      await shot(file);
      console.log(file);
    }
  } else {
    const count = Math.round(DURATION * FPS);
    for (let i = 0; i < count; i++) {
      await evalFrame(i / FPS);
      await shot(path.join(OUT, `frame_${String(i + 1).padStart(4, '0')}.png`));
      if (i % 24 === 0) process.stdout.write(`\r${i + 1}/${count}`);
    }
    process.stdout.write(`\r${count}/${count}\n`);
  }
} finally {
  try { ws?.close(); } catch {}
  chrome.kill('SIGKILL');
  await sleep(150);
  await rm(profile, {recursive: true, force: true}).catch(() => {});
}
