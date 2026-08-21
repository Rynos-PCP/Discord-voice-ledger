#!/usr/bin/env node
/**
 * Discord Voice Ledger — ETL
 *
 * Reads a Discord data package (folder "package") exactly once and writes a
 * compact dataset plus a self-contained HTML dashboard.
 *
 *   node build.mjs [--package <path>] [--out <path>] [--quiet]
 *
 * No dependencies, no network. Everything stays on your machine.
 */

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------- CLI ------

const argv = process.argv.slice(2);
function arg(name, fallback) {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
}
const QUIET = argv.includes('--quiet');
const PKG = path.resolve(arg('--package', path.join(__dirname, 'package')));
const OUT = path.resolve(arg('--out', path.join(__dirname, 'dist')));

const log = (...a) => { if (!QUIET) console.log(...a); };
const warnings = [];
const warn = (m) => { warnings.push(m); console.warn('  ! ' + m); };

// ------------------------------------------------------ Locate folders -----

/** Find a folder regardless of export language or letter case. */
function findDirByName(root, candidates) {
  let entries;
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return null; }
  const norm = (s) => s.toLowerCase().normalize('NFC');
  for (const c of candidates) {
    const hit = entries.find((e) => e.isDirectory() && norm(e.name) === norm(c));
    if (hit) return path.join(root, hit.name);
  }
  return null;
}

/**
 * Fallback for export languages we do not know by name: recognise a folder by
 * what is inside it. Discord translates the folder names but never the file
 * names, so the contents are a reliable fingerprint.
 */
function findDirByContent(root, test) {
  let entries;
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return null; }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const dir = path.join(root, e.name);
    try { if (test(dir)) return dir; } catch { /* unreadable — skip */ }
  }
  return null;
}

const hasFile = (dir, name) => fs.existsSync(path.join(dir, name));
const anyChild = (dir, test) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (test(e, path.join(dir, e.name))) return true;
  }
  return false;
};

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

if (!fs.existsSync(PKG)) {
  console.error(`Data package not found: ${PKG}`);
  console.error('Usage: node build.mjs --package "<path to the unzipped Discord package>"');
  process.exit(1);
}

// Known folder names first (fast, exact), content fingerprint second.
const dirActivity = findDirByName(PKG, ['activity', 'Aktivität', 'Aktivitat', 'activité', 'actividad', 'attività', 'atividade'])
  ?? findDirByContent(PKG, (d) => anyChild(d, (e, p) => e.isDirectory() && anyChild(p, (f) => /^events-.*\.(json|jsonl)$/i.test(f.name))));

const dirMessages = findDirByName(PKG, ['messages', 'Nachrichten', 'mensajes', 'messaggi', 'mensagens'])
  ?? findDirByContent(PKG, (d) => hasFile(d, 'index.json') && anyChild(d, (e, p) => e.isDirectory() && hasFile(p, 'channel.json')));

const dirServers = findDirByName(PKG, ['servers', 'Server', 'serveurs', 'servidores', 'server'])
  ?? findDirByContent(PKG, (d) => anyChild(d, (e, p) => e.isDirectory() && hasFile(p, 'guild.json')));

const dirAccount = findDirByName(PKG, ['account', 'Account', 'Konto', 'compte', 'cuenta'])
  ?? findDirByContent(PKG, (d) => hasFile(d, 'user.json'));

const rel = (d) => (d ? path.relative(PKG, d) : '— missing —');
log(`Data package: ${PKG}`);
log(`  activity : ${rel(dirActivity)}`);
log(`  messages : ${rel(dirMessages)}`);
log(`  servers  : ${rel(dirServers)}`);

if (!dirActivity) warn('The "activity" folder is missing — without it there is no voice time.');

// ----------------------------------------------------------- Helpers -------

/** Discord sometimes writes a timestamp as a JSON string inside a JSON string. */
function parseTs(v) {
  if (v == null) return null;
  let s = String(v).trim();
  if (s.startsWith('"') && s.endsWith('"')) s = s.slice(1, -1);
  if (!s || s === 'null') return null;
  if (s.endsWith(' UTC')) s = s.slice(0, -4).trim();
  // "2023-11-03 14:59:06" is UTC without a zone marker — read it as UTC.
  if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d+)?$/.test(s)) s = s.replace(' ', 'T') + 'Z';
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : null;
}
function eventTime(o) {
  return parseTs(o.timestamp) ?? parseTs(o.client_track_timestamp)
      ?? parseTs(o.client_send_timestamp) ?? parseTs(o._ingest_ts);
}
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const sec = (ms) => Math.round(ms / 1000);
const int = (n) => n.toLocaleString('en-US');

// -------------------------------------------------------- Read events ------

const RE_TYPE = /"event_type":"([a-z0-9_]+)"/;
const RE_ID   = /"event_id":"([^"]+)"/;
const KEEP = new Set(['leave_voice_channel', 'voice_disconnect', 'join_voice_channel', 'send_message']);

const seenEvent = new Set();
const joins  = [];   // {t, ch, gid}
const leaves = [];   // {t, dur, ch, gid, ctype}
const discos = [];   // {t, dur, ch, gid, ctype, ctx, speak, listen}
const sendMsgs = []; // {id, t, ch, gid, ctype, len, words, att}

const guildNameFromEvents = new Map();
const channelNameFromEvents = new Map();

const stats = {
  files: [], lines: 0, parsed: 0, duplicates: 0,
  byType: {}, badTimestamps: 0,
};

async function readEventFile(file) {
  const rl = readline.createInterface({
    input: fs.createReadStream(file, { encoding: 'utf8', highWaterMark: 1 << 22 }),
    crlfDelay: Infinity,
  });
  let lines = 0, kept = 0, dup = 0;
  for await (const line of rl) {
    if (!line) continue;
    lines++;
    const hasName = line.indexOf('"guild_name"') >= 0 || line.indexOf('"channel_name"') >= 0;
    const mt = RE_TYPE.exec(line);
    const type = mt ? mt[1] : null;
    const keep = !!type && KEEP.has(type);
    if (!hasName && !keep) continue;

    // Only the events that are actually collected need the duplicate check.
    // Reading a name twice changes nothing (the first one wins), and
    // remembering every other event is what fills the heap on large packages.
    let eid = null;
    if (keep) {
      const mi = RE_ID.exec(line);
      eid = mi ? mi[1] : null;
      if (eid && seenEvent.has(eid)) { dup++; continue; }
    }

    let o;
    try { o = JSON.parse(line); } catch { continue; }
    // Deliberately the ID out of the parsed object, not the one out of the
    // regex: a match is a view into the raw line, and V8 keeps that whole
    // line alive for as long as the view exists — a few hundred bytes per
    // event, times millions of events.
    if (eid) seenEvent.add(o.event_id != null ? String(o.event_id) : eid);

    if (o.guild_id && o.guild_name && !guildNameFromEvents.has(String(o.guild_id)))
      guildNameFromEvents.set(String(o.guild_id), String(o.guild_name));
    if (o.channel_id && o.channel_name && !channelNameFromEvents.has(String(o.channel_id)))
      channelNameFromEvents.set(String(o.channel_id), String(o.channel_name));

    if (!keep) continue;
    kept++;
    stats.byType[type] = (stats.byType[type] || 0) + 1;
    const t = eventTime(o);
    if (t == null) { stats.badTimestamps++; continue; }

    if (type === 'join_voice_channel') {
      joins.push({
        t, ch: o.channel_id ? String(o.channel_id) : null,
        gid: o.guild_id ? String(o.guild_id) : null, ctype: String(o.channel_type ?? ''),
      });
    } else if (type === 'leave_voice_channel') {
      leaves.push({
        t, dur: num(o.duration), ch: o.channel_id ? String(o.channel_id) : null,
        gid: o.guild_id ? String(o.guild_id) : null, ctype: String(o.channel_type ?? ''),
      });
    } else if (type === 'voice_disconnect') {
      discos.push({
        t, dur: num(o.duration), ch: o.channel_id ? String(o.channel_id) : null,
        gid: o.guild_id ? String(o.guild_id) : null, ctype: String(o.channel_type ?? ''),
        ctx: o.context ? String(o.context) : 'default',
        speak: num(o.duration_speaking_ms) || num(o.duration_speaking) * 1000,
        listen: num(o.duration_listening_ms) || num(o.duration_listening) * 1000,
      });
    } else if (type === 'send_message') {
      sendMsgs.push({
        id: o.message_id ? String(o.message_id) : null, t,
        ch: o.channel ? String(o.channel) : null,
        gid: o.server ? String(o.server) : null,
        ctype: String(o.channel_type ?? ''),
        len: num(o.length), words: num(o.word_count), att: num(o.num_attachments),
      });
    }
  }
  stats.lines += lines; stats.parsed += kept; stats.duplicates += dup;
  stats.files.push({ file: path.relative(PKG, file), lines, kept, dup });
  log(`  ${path.relative(PKG, file)} — ${int(lines)} lines, ${int(kept)} relevant, ${int(dup)} duplicates`);
}

if (dirActivity) {
  const files = walk(dirActivity).filter((f) => /\.(json|jsonl)$/i.test(f));
  if (!files.length) warn('No event files found under "activity".');
  log(`\nReading events (${files.length} file(s)) …`);
  for (const f of files) await readEventFile(f);
}

// ------------------------------------------------- Read messages folder ----

/** channel_id -> label from index.json, e.g. "general in Gaming Corner". */
let msgIndex = {};
const pkgMessages = [];        // {id, t, ch}
const channelMeta = new Map(); // id -> {name, type, guildId, guildName, recipients}
let msgFoldersFound = 0;

function parseCsvMessages(text) {
  // Discord CSV: ID,Timestamp,Contents,Attachments — with quotes and newlines.
  const rows = []; let i = 0, field = '', row = [], inQ = false;
  while (i < text.length) {
    const c = text[i];
    if (inQ) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i += 2; continue; } inQ = false; i++; continue; }
      field += c; i++; continue;
    }
    if (c === '"') { inQ = true; i++; continue; }
    if (c === ',') { row.push(field); field = ''; i++; continue; }
    if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; i++; continue; }
    if (c === '\r') { i++; continue; }
    field += c; i++;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  if (!rows.length) return [];
  const head = rows[0].map((h) => h.trim().toLowerCase());
  const iId = head.indexOf('id'), iTs = head.indexOf('timestamp');
  return rows.slice(1).filter((r) => r.length > 1).map((r) => ({ ID: r[iId], Timestamp: r[iTs] }));
}

if (dirMessages) {
  const idxFile = path.join(dirMessages, 'index.json');
  if (fs.existsSync(idxFile)) {
    try { msgIndex = JSON.parse(fs.readFileSync(idxFile, 'utf8')); }
    catch (e) { warn('messages/index.json is unreadable: ' + e.message); }
  }
  const folders = fs.readdirSync(dirMessages, { withFileTypes: true })
    .filter((e) => e.isDirectory()).map((e) => e.name);
  msgFoldersFound = folders.length;
  log(`\nMessages: ${Object.keys(msgIndex).length} channels in the index, ${folders.length} folders present`);

  for (const folder of folders) {
    const dir = path.join(dirMessages, folder);
    let cid = folder.replace(/^c/i, '');
    const cjPath = path.join(dir, 'channel.json');
    if (fs.existsSync(cjPath)) {
      try {
        const cj = JSON.parse(fs.readFileSync(cjPath, 'utf8'));
        if (cj.id) cid = String(cj.id);
        channelMeta.set(cid, {
          name: cj.name ? String(cj.name) : null,
          type: cj.type ? String(cj.type) : null,
          guildId: cj.guild?.id ? String(cj.guild.id) : null,
          guildName: cj.guild?.name ? String(cj.guild.name) : null,
          recipients: Array.isArray(cj.recipients) ? cj.recipients.map(String) : null,
        });
      } catch { /* ignore */ }
    }
    const jsonPath = path.join(dir, 'messages.json');
    const csvPath = path.join(dir, 'messages.csv');
    let list = null;
    if (fs.existsSync(jsonPath)) {
      try {
        // Discord writes the message ID as a JSON number. Snowflakes are larger
        // than 2^53, so JSON.parse would round them and destroy the dedup
        // against the send_message events. Quote them before parsing.
        const raw = fs.readFileSync(jsonPath, 'utf8').replace(/"ID"(\s*):(\s*)(\d+)/g, '"ID"$1:$2"$3"');
        list = JSON.parse(raw);
      } catch (e) { warn(`${folder}/messages.json unreadable: ${e.message}`); }
    } else if (fs.existsSync(csvPath)) {
      try { list = parseCsvMessages(fs.readFileSync(csvPath, 'utf8')); } catch (e) { warn(`${folder}/messages.csv unreadable: ${e.message}`); }
    }
    if (!Array.isArray(list)) continue;
    for (const m of list) {
      const t = parseTs(m.Timestamp ?? m.timestamp);
      if (t == null) continue;
      pkgMessages.push({ id: m.ID != null ? String(m.ID) : null, t, ch: cid });
    }
  }
}

// ------------------------------------------ Server names from the folder ---

const guildNameFromServers = new Map();
if (dirServers) {
  for (const e of fs.readdirSync(dirServers, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const gj = path.join(dirServers, e.name, 'guild.json');
    if (!fs.existsSync(gj)) continue;
    try {
      const g = JSON.parse(fs.readFileSync(gj, 'utf8'));
      if (g.id && g.name) guildNameFromServers.set(String(g.id), String(g.name));
    } catch { /* ignore */ }
  }
  log(`Servers folder: ${guildNameFromServers.size} server names found`);
}

// -------------------------------------------------------- Own user ID ------

// Used only in memory, to tell yourself apart from the other participants of a
// chat. Neither the ID nor the name is written to the output — see the note in
// "Build the output" below.
let selfUserId = null;
if (dirAccount) {
  const uj = path.join(dirAccount, 'user.json');
  if (fs.existsSync(uj)) {
    try {
      // Deliberately the ID and nothing else. E-mail, phone number and the rest
      // of user.json have no business in an analysis dataset.
      const u = JSON.parse(fs.readFileSync(uj, 'utf8'));
      if (u.id) selfUserId = String(u.id);
    } catch { /* ignore */ }
  }
}

// =========================================================== Voice time =====
//
// Trustworthiness: `leave_voice_channel` carries the channel attribution
// correctly (98.4 % agreement with the matching join_voice_channel event),
// whereas `voice_disconnect` in the 2022/2023 client builds frequently reports
// the channel of the PREVIOUS session. Therefore:
//   1. Base = leave_voice_channel   (interval = [ts − duration, ts])
//   2. Fill = voice_disconnect (excluding context="stream", which runs in
//      parallel), channel corrected via the nearest join_voice_channel, and
//      only for stretches the base does not already cover.
// The result is an overlap-free timeline: every second belongs to exactly one
// channel.

joins.sort((a, b) => a.t - b.t);
const joinTimes = joins.map((j) => j.t);

function nearestJoin(t, tolMs = 10000) {
  if (!joins.length) return null;
  let lo = 0, hi = joinTimes.length - 1, best = null, bestD = Infinity;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (joinTimes[mid] < t) lo = mid + 1; else hi = mid - 1;
  }
  for (let i = Math.max(0, lo - 2); i < Math.min(joins.length, lo + 2); i++) {
    const d = Math.abs(joins[i].t - t);
    if (d < bestD) { bestD = d; best = joins[i]; }
  }
  return bestD <= tolMs ? best : null;
}

const MIN_SESSION_MS = 5000;   // shorter connections are noise (misclicks)
const MIN_FILL_MS = 60000;     // only adopt filler stretches from a minute up

// 1) Base intervals
let base = leaves
  .filter((l) => l.dur >= MIN_SESSION_MS && l.ch)
  .map((l) => ({ a: l.t - l.dur, b: l.t, ch: l.ch, gid: l.gid, ctype: l.ctype, fill: 0 }))
  .sort((x, y) => x.a - y.a);

// Trim overlaps in the base (you can only be in one channel at a time)
let trimmedMs = 0;
{
  const out = [];
  let lastEnd = -Infinity;
  for (const iv of base) {
    if (iv.a < lastEnd) { trimmedMs += Math.min(lastEnd, iv.b) - iv.a; iv.a = lastEnd; }
    if (iv.b - iv.a >= MIN_SESSION_MS) { out.push(iv); lastEnd = Math.max(lastEnd, iv.b); }
  }
  base = out;
}

// 2) Filler stretches from voice_disconnect
let reattributed = 0;
const fillCandidates = discos
  .filter((d) => d.ctx !== 'stream' && d.dur >= MIN_FILL_MS && d.ch)
  .map((d) => {
    const a = d.t - d.dur;
    const j = nearestJoin(a);
    let ch = d.ch, gid = d.gid;
    if (j && j.ch && j.ch !== d.ch) { ch = j.ch; gid = j.gid; reattributed++; }
    return { a, b: d.t, ch, gid, ctype: d.ctype, fill: 1 };
  })
  .sort((x, y) => x.a - y.a);

// Determine the union of the base and subtract it
const baseUnion = [];
for (const iv of base) {
  const last = baseUnion[baseUnion.length - 1];
  if (last && iv.a <= last[1]) last[1] = Math.max(last[1], iv.b);
  else baseUnion.push([iv.a, iv.b]);
}
function subtractUnion(a, b) {
  const parts = [];
  let cur = a;
  let lo = 0, hi = baseUnion.length - 1, start = baseUnion.length;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (baseUnion[mid][1] < a) lo = mid + 1; else { start = mid; hi = mid - 1; } }
  for (let i = start; i < baseUnion.length && baseUnion[i][0] < b; i++) {
    const [s, e] = baseUnion[i];
    if (s > cur) parts.push([cur, Math.min(s, b)]);
    cur = Math.max(cur, e);
    if (cur >= b) break;
  }
  if (cur < b) parts.push([cur, b]);
  return parts.filter((p) => p[1] - p[0] >= MIN_FILL_MS);
}

const filled = [];
for (const c of fillCandidates) {
  for (const [a, b] of subtractUnion(c.a, c.b)) filled.push({ ...c, a, b });
}

// 3) Merge, then make overlap-free once more
let sessions = base.concat(filled).sort((x, y) => x.a - y.a);
{
  const out = [];
  let lastEnd = -Infinity;
  for (const iv of sessions) {
    if (iv.a < lastEnd) iv.a = lastEnd;
    if (iv.b - iv.a >= MIN_SESSION_MS) { out.push(iv); lastEnd = Math.max(lastEnd, iv.b); }
  }
  sessions = out;
}

// 4) Lay speaking/listening time and Go Live time onto the sessions
for (const s of sessions) { s.speak = 0; s.listen = 0; s.stream = 0; }
const sessStarts = sessions.map((s) => s.a);
function overlapSession(a, b) {
  let lo = 0, hi = sessStarts.length - 1, idx = -1;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (sessStarts[mid] <= a) { idx = mid; lo = mid + 1; } else hi = mid - 1; }
  let best = null, bestOv = 0;
  for (let i = Math.max(0, idx - 1); i < sessions.length && sessions[i].a < b; i++) {
    const ov = Math.min(sessions[i].b, b) - Math.max(sessions[i].a, a);
    if (ov > bestOv) { bestOv = ov; best = sessions[i]; }
  }
  return bestOv > 0 ? best : null;
}
for (const d of discos) {
  if (d.dur < MIN_SESSION_MS) continue;
  const s = overlapSession(d.t - d.dur, d.t);
  if (!s) continue;
  if (d.ctx === 'stream') s.stream += Math.min(d.dur, s.b - s.a);
  else { s.speak += d.speak; s.listen += d.listen; }
}

// ============================================================== Messages ====
//
// Two sources, unioned by message ID:
//   A) messages folder   — complete history, but only for extracted channels
//   B) send_message events — from the start of the analytics window, all channels
// The union by ID prevents double counting.

const messages = new Map(); // id -> {t, ch, len, att, src}
let noIdCounter = 0;
for (const m of sendMsgs) {
  const key = m.id || `a${noIdCounter++}`;
  messages.set(key, { t: m.t, ch: m.ch, len: m.len, att: m.att, src: 1 });
}
let pkgOnly = 0;
for (const m of pkgMessages) {
  const key = m.id || `p${noIdCounter++}`;
  const prev = messages.get(key);
  if (prev) { prev.src |= 2; if (!prev.ch) prev.ch = m.ch; }
  else { messages.set(key, { t: m.t, ch: m.ch, len: -1, att: -1, src: 2 }); pkgOnly++; }
}

// ======================================================= Name resolution ====

const channelGuild = new Map();   // channel -> guild
const channelType = new Map();    // channel -> Discord channel type (number as string)
const channelName = new Map();
const dmLabel = new Map();        // channel -> display name for DM/group

function noteChannel(ch, gid, ctype) {
  if (!ch) return;
  if (gid && !channelGuild.has(ch)) channelGuild.set(ch, gid);
  if (ctype && !channelType.has(ch)) channelType.set(ch, ctype);
}
for (const l of leaves) noteChannel(l.ch, l.gid, l.ctype);
for (const d of discos) noteChannel(d.ch, d.gid, d.ctype);
for (const j of joins) noteChannel(j.ch, j.gid, j.ctype);
for (const m of sendMsgs) noteChannel(m.ch, m.gid, m.ctype);
for (const [cid, meta] of channelMeta) {
  if (meta.guildId) channelGuild.set(cid, meta.guildId);
  if (meta.name) channelName.set(cid, meta.name);
  if (meta.type === 'DM') channelType.set(cid, '1');
  else if (meta.type === 'GROUP_DM') channelType.set(cid, '3');
}
for (const [cid, n] of channelNameFromEvents) if (!channelName.has(cid)) channelName.set(cid, n);

// Read index.json: "channel in Server name" resp. "Direct Message with name#0"
const guildNameInferred = new Map();
for (const [cidRaw, labelRaw] of Object.entries(msgIndex)) {
  const cid = String(cidRaw);
  const label = labelRaw == null ? '' : String(labelRaw);
  if (!label || label === 'None' || label === 'Unknown channel') continue;
  const dm = /^Direct Message with (.+)$/.exec(label);
  if (dm) {
    dmLabel.set(cid, dm[1].replace(/#0$/, ''));
    if (!channelType.has(cid)) channelType.set(cid, '1');
    continue;
  }
  const inGuild = label.lastIndexOf(' in ');
  if (inGuild > 0) {
    const cname = label.slice(0, inGuild);
    const gname = label.slice(inGuild + 4);
    if (!channelName.has(cid)) channelName.set(cid, cname);
    const g = channelGuild.get(cid);
    if (g && !guildNameInferred.has(g)) guildNameInferred.set(g, gname);
  } else {
    // Channel without a server name -> group DM with a name of its own
    if (!channelName.has(cid)) channelName.set(cid, label);
    if (!dmLabel.has(cid)) dmLabel.set(cid, label);
    if (!channelType.has(cid)) channelType.set(cid, '3');
  }
}
for (const [cid, meta] of channelMeta) {
  if (meta.guildName && meta.guildId && !guildNameInferred.has(meta.guildId))
    guildNameInferred.set(meta.guildId, meta.guildName);
}

// One-to-one chats reveal which user ID belongs to which name: channel.json
// lists the participants, index.json names the other side.
const userNames = new Map();
for (const [cid, meta] of channelMeta) {
  if (!meta.recipients || meta.type !== 'DM') continue;
  const others = meta.recipients.filter((r) => r !== selfUserId);
  const label = dmLabel.get(cid);
  if (others.length === 1 && label) userNames.set(others[0], label);
}

// That also gives unnamed group chats a label you can actually read.
for (const [cid, meta] of channelMeta) {
  if (!meta.recipients || dmLabel.has(cid)) continue;
  const others = meta.recipients.filter((r) => r !== selfUserId);
  if (!others.length) continue;
  if (others.length === 1) {
    // Group chat with a single other person: keep it clearly apart from the
    // one-to-one chat with the same person, otherwise two entries share a name.
    const who = userNames.get(others[0]) || `Contact #${others[0].slice(-4)}`;
    dmLabel.set(cid, meta.type === 'GROUP_DM' ? `Group with ${who}` : who);
    continue;
  }
  const known = others.map((o) => userNames.get(o)).filter(Boolean);
  if (known.length) {
    const shown = known.slice(0, 3).join(', ');
    const rest = others.length - Math.min(3, known.length);
    dmLabel.set(cid, rest > 0 ? `Group: ${shown} +${rest}` : `Group: ${shown}`);
  } else {
    dmLabel.set(cid, `Group (${others.length + 1} people)`);
  }
}

function guildName(gid) {
  return guildNameFromServers.get(gid) || guildNameFromEvents.get(gid) || guildNameInferred.get(gid) || null;
}

// ------------------------------------------------------- Index channels ----

const allChannels = new Set();
for (const s of sessions) allChannels.add(s.ch);
for (const m of messages.values()) if (m.ch) allChannels.add(m.ch);

const guildIdx = new Map();
const guilds = [];
function guildIndex(gid) {
  if (!gid) return -1;
  if (guildIdx.has(gid)) return guildIdx.get(gid);
  const i = guilds.length;
  const n = gid === '0' ? null : guildName(gid);
  guilds.push({
    id: gid,
    name: n || (gid === '0' ? 'Unknown server' : `Server #${gid.slice(-4)}`),
    named: n ? 1 : 0,
  });
  guildIdx.set(gid, i);
  return i;
}

// Discord channel types: 1 = DM, 3 = group DM, anything else belongs to a server.
const DM_TYPES = new Set(['1', '3']);
const chIdx = new Map();
const channels = [];
for (const cid of allChannels) {
  const gid = channelGuild.get(cid) || null;
  const ctype = channelType.get(cid) || (gid ? '0' : '1');
  let kind;
  if (gid) kind = 'guild';
  else if (ctype === '3') kind = 'group';
  else if (DM_TYPES.has(ctype)) kind = 'dm';
  else kind = 'guild'; // server channel whose server ID is missing from the package
  const gi = kind === 'guild' ? guildIndex(gid || '0') : -1;
  const rec = channelMeta.get(cid)?.recipients || null;
  channels.push({
    id: cid,
    n: channelName.get(cid) || null,
    t: ctype,
    g: gi,
    k: kind,
    p: kind === 'guild' ? null : (dmLabel.get(cid) || null),
    r: rec && rec.length ? rec.filter((r) => r !== selfUserId).length + 1 : 0,
  });
  chIdx.set(cid, channels.length - 1);
}

// ------------------------------------------------------ Build the output ---

const S = { s: [], d: [], c: [], f: [], sp: [], li: [], st: [] };
for (const s of sessions) {
  S.s.push(sec(s.a));
  S.d.push(sec(s.b - s.a));
  S.c.push(chIdx.get(s.ch) ?? -1);
  S.f.push(s.fill);
  S.sp.push(sec(Math.min(s.speak, s.b - s.a)));
  S.li.push(sec(Math.min(s.listen, s.b - s.a)));
  S.st.push(sec(Math.min(s.stream, s.b - s.a)));
}

const msgArr = [...messages.values()].filter((m) => m.ch && chIdx.has(m.ch)).sort((a, b) => a.t - b.t);
const M = { t: [], c: [], l: [], a: [], s: [] };
for (const m of msgArr) {
  M.t.push(sec(m.t));
  M.c.push(chIdx.get(m.ch));
  M.l.push(m.len);
  M.a.push(m.att);
  M.s.push(m.src);
}

const droppedMessages = messages.size - msgArr.length;
if (droppedMessages > 0) warn(`${droppedMessages} message(s) without an assignable channel were left out.`);

// Coverage and quality notes
const idxCount = Object.keys(msgIndex).length;
if (dirMessages && idxCount > 0 && msgFoldersFound < idxCount) {
  warn(`Messages folder incomplete: ${msgFoldersFound} of ${idxCount} channels extracted. `
     + `Message counts therefore come mostly from the analytics events (from ${new Date(msgArr[0]?.t ?? Date.now()).getFullYear()} onwards).`);
}
if (!dirServers) {
  const unnamed = guilds.filter((g) => !g.named).length;
  warn(`The "servers" folder is missing — ${unnamed} of ${guilds.length} servers have no name, only an ID. `
     + `You can name them by hand in the dashboard.`);
}

const totalVoiceSec = S.d.reduce((a, b) => a + b, 0);
const fillSec = S.d.reduce((a, b, i) => a + (S.f[i] ? b : 0), 0);

// Note on what is deliberately NOT in here: your own user ID, your display
// name, and the path to the package. The dashboard never reads them, and the
// output file is meant to be movable — so they would only ever be a leak.
const data = {
  v: 1,
  generatedAt: new Date().toISOString(),
  guilds, channels,
  sessions: S,
  messages: M,
  quality: {
    sessions: S.d.length,
    voiceSeconds: totalVoiceSec,
    gapFilledSeconds: fillSec,
    trimmedOverlapSeconds: sec(trimmedMs),
    reattributedChannels: reattributed,
    eventFiles: stats.files,
    eventLines: stats.lines,
    duplicateEvents: stats.duplicates,
    eventTypes: stats.byType,
    messagesTotal: msgArr.length,
    messagesFromPackageOnly: pkgOnly,
    messageChannelsInIndex: idxCount,
    messageFoldersExtracted: msgFoldersFound,
    guildsNamed: guilds.filter((g) => g.named).length,
    guildsTotal: guilds.length,
    hasServerFolder: !!dirServers,
    warnings,
  },
};

// ------------------------------------------------------------- Writing -----

fs.mkdirSync(OUT, { recursive: true });
const payload = JSON.stringify(data);
const jsonPath = path.join(OUT, 'data.json');
fs.writeFileSync(jsonPath, payload);

// Embedded in HTML: a bare "<" would end the script tag, and U+2028/U+2029
// count as line terminators in JS source and would tear the expression apart.
const BS = String.fromCharCode(92);
const ESCAPE = {
  '<': BS + 'u003c',
  [String.fromCharCode(0x2028)]: BS + 'u2028',
  [String.fromCharCode(0x2029)]: BS + 'u2029',
};
// One pass. A split/join chain would hold the payload three times over.
// Built from the keys so this file itself stays free of the two characters:
// a literal U+2028 in the source would be a line break to the parser.
const ESCAPE_RE = new RegExp('[' + Object.keys(ESCAPE).join('') + ']', 'g');
const inline = payload.replace(ESCAPE_RE, (c) => ESCAPE[c]);

const tplPath = path.join(__dirname, 'src', 'app.html');
const tpl = fs.readFileSync(tplPath, 'utf8');
if (!tpl.includes('/*__DATA__*/')) {
  console.error('src/app.html has no /*__DATA__*/ placeholder.');
  process.exit(1);
}
const htmlPath = path.join(OUT, 'discord-voice-ledger.html');
// Written in three pieces on purpose: tpl.replace() would build the whole
// file, payload included, a second time in memory.
const cut = tpl.indexOf('/*__DATA__*/');
fs.writeFileSync(htmlPath, tpl.slice(0, cut));
fs.appendFileSync(htmlPath, inline);
fs.appendFileSync(htmlPath, tpl.slice(cut + '/*__DATA__*/'.length));

// -------------------------------------------------------------- Report -----

const fmtH = (s) => (s / 3600).toLocaleString('en-US', { maximumFractionDigits: 1 });
log('\n─── Result ─────────────────────────────────────────────');
log(`Sessions         : ${int(S.d.length)}`);
log(`Voice time       : ${fmtH(totalVoiceSec)} h  (of which ${fmtH(fillSec)} h from gap filling)`);
log(`Period           : ${S.s.length ? new Date(S.s[0] * 1000).toISOString().slice(0, 10) : '—'} to ${S.s.length ? new Date((S.s[S.s.length - 1] + S.d[S.d.length - 1]) * 1000).toISOString().slice(0, 10) : '—'}`);
log(`Messages         : ${int(msgArr.length)} (${int(pkgOnly)} from the messages folder only)`);
log(`Servers          : ${guilds.length} (${guilds.filter((g) => g.named).length} with a name)`);
log(`Channels         : ${channels.length}`);
log(`Channel fixes    : ${reattributed} (voice_disconnect checked against join_voice_channel)`);
log('');
log(`data.json        : ${jsonPath} (${(fs.statSync(jsonPath).size / 1048576).toFixed(2)} MB)`);
log(`Dashboard        : ${htmlPath} (${(fs.statSync(htmlPath).size / 1048576).toFixed(2)} MB)`);
if (warnings.length) log(`\n${warnings.length} note(s) — see above; they also appear in the dashboard under "Data quality".`);
