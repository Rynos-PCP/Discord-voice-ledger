#!/usr/bin/env node
/**
 * Discord Voice Ledger — synthetic data package
 *
 * Builds a fake Discord data package so you can try the dashboard without
 * waiting days for your own export. Everything in here is invented: the
 * people, the servers, the conversations.
 *
 *   node tools/make-sample-package.mjs [--out <path>] [--seed <n>]
 *   node build.mjs --package sample-package
 *
 * The generator deliberately reproduces the awkward parts of a real package,
 * because that is what makes it useful as a test fixture:
 *   - voice_disconnect that names the channel of the PREVIOUS session
 *   - stretches covered only by voice_disconnect, never by leave_voice_channel
 *   - Go Live connections running in parallel with the session they belong to
 *   - message IDs written as JSON numbers larger than 2^53
 *   - the same events duplicated across two reporting files
 *   - one server you left, for which no name survives anywhere
 */

import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const OUT = path.resolve(arg('--out', 'sample-package'));
const SEED = Number(arg('--seed', '20260819')) >>> 0;

// Deterministic PRNG — same seed, same package.
let _s = SEED;
function rnd() {
  _s = (_s + 0x6d2b79f5) >>> 0;
  let t = _s;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const between = (lo, hi) => lo + rnd() * (hi - lo);
const chance = (p) => rnd() < p;

// Snowflake-shaped IDs: 19 digits, well beyond 2^53.
let idCounter = 0;
function snowflake(base = 1180000000000000000n) {
  idCounter += Math.floor(between(1000, 90000));
  return (base + BigInt(idCounter)).toString();
}

// ------------------------------------------------------------- Cast -------

const SELF = snowflake();

const CONTACTS = [
  { name: 'aurelia', id: snowflake() },
  { name: 'brambleforge', id: snowflake() },
  { name: 'nightjar', id: snowflake() },
  { name: 'quillon', id: snowflake() },
  { name: 'sundry_moth', id: snowflake() },
];

const SERVERS = [
  { name: 'The Lantern Room', id: snowflake(), named: true,  weight: 4.0 },
  { name: 'Cartography Club', id: snowflake(), named: true,  weight: 2.0 },
  { name: 'Bad Movie Night',  id: snowflake(), named: true,  weight: 1.0 },
  { name: null,               id: snowflake(), named: false, weight: 0.6 }, // left it — no name anywhere
];

const VOICE_CHANNELS = [];
const TEXT_CHANNELS = [];
for (const s of SERVERS) {
  for (const n of ['general-voice', 'the-back-room']) {
    VOICE_CHANNELS.push({ id: snowflake(), name: n, guild: s, type: '2', weight: s.weight * between(0.5, 1.5) });
  }
  TEXT_CHANNELS.push({ id: snowflake(), name: 'general', guild: s, type: '0', weight: s.weight });
}

const DMS = CONTACTS.map((c, i) => ({
  id: snowflake(), name: null, type: '1', contact: c,
  weight: [3.5, 2.2, 1.4, 0.8, 0.4][i],
}));

const GROUP = {
  id: snowflake(), name: null, type: '3',
  members: [CONTACTS[0], CONTACTS[1], CONTACTS[3]],
  weight: 1.1,
};

const VOICE_TARGETS = [
  ...VOICE_CHANNELS.map((c) => ({ kind: 'guild', ch: c })),
  ...DMS.map((d) => ({ kind: 'dm', ch: d })),
  { kind: 'group', ch: GROUP },
];
const TOTAL_WEIGHT = VOICE_TARGETS.reduce((a, t) => a + t.ch.weight, 0);
function pickVoiceTarget() {
  let r = rnd() * TOTAL_WEIGHT;
  for (const t of VOICE_TARGETS) { r -= t.ch.weight; if (r <= 0) return t; }
  return VOICE_TARGETS[0];
}

// --------------------------------------------------------- Timeline -------

const START = Date.UTC(2024, 0, 1);
const END = Date.UTC(2024, 8, 30);
const HOUR = 3600000, MINUTE = 60000;

// People talk in the evening. Weight the start hour accordingly.
const HOUR_WEIGHT = [3,2,1,1,1,1,1,1,2,3,4,5,6,7,8,9,12,18,26,34,38,34,22,10];
const HOUR_TOTAL = HOUR_WEIGHT.reduce((a, b) => a + b, 0);
function pickHour() {
  let r = rnd() * HOUR_TOTAL;
  for (let h = 0; h < 24; h++) { r -= HOUR_WEIGHT[h]; if (r <= 0) return h; }
  return 20;
}

const sessions = [];
for (let day = START; day <= END; day += 86400000) {
  const d = new Date(day);
  const weekend = d.getUTCDay() === 0 || d.getUTCDay() === 6;
  let n = 0;
  if (chance(weekend ? 0.82 : 0.55)) n = 1;
  if (n && chance(weekend ? 0.45 : 0.22)) n = 2;
  for (let i = 0; i < n; i++) {
    const start = day + pickHour() * HOUR + Math.floor(between(0, 59)) * MINUTE;
    // Mostly ordinary evenings, occasionally a session that runs into the night.
    const dur = chance(0.08)
      ? Math.floor(between(3, 7) * HOUR)
      : Math.floor(between(6, 150) * MINUTE);
    sessions.push({ start, dur, target: pickVoiceTarget() });
  }
}
sessions.sort((a, b) => a.start - b.start);

// Remove overlaps at the source, the way reality does it: you leave one call
// before you join the next.
for (let i = 1; i < sessions.length; i++) {
  const prev = sessions[i - 1], cur = sessions[i];
  const prevEnd = prev.start + prev.dur;
  if (cur.start < prevEnd + MINUTE) cur.start = prevEnd + Math.floor(between(1, 40) * MINUTE);
}

// ----------------------------------------------------------- Events -------

const events = [];
const ts = (ms) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
let eventNo = 0;
const push = (o) => events.push({ event_id: `evt_${SEED}_${eventNo++}`, ...o });

const chFields = (t) => t.kind === 'guild'
  ? { channel_id: t.ch.id, channel_name: t.ch.name, guild_id: t.ch.guild.id, channel_type: 2,
      ...(t.ch.guild.named ? { guild_name: t.ch.guild.name } : {}) }
  : { channel_id: t.ch.id, channel_type: t.kind === 'dm' ? 1 : 3 };

let previousTarget = null;
let leaveMissing = 0, wrongChannel = 0, streams = 0;

for (const s of sessions) {
  const end = s.start + s.dur;
  const speaking = Math.floor(s.dur * between(0.15, 0.55));
  const listening = Math.floor(s.dur * between(0.4, 0.85));

  push({ event_type: 'join_voice_channel', timestamp: ts(s.start), ...chFields(s.target) });

  // 10 % of sessions never produce a leave event — a crash, a killed client,
  // an event lost in transit. Those are exactly the gaps the filler covers.
  if (chance(0.9)) {
    push({ event_type: 'leave_voice_channel', timestamp: ts(end), duration: s.dur, ...chFields(s.target) });
  } else {
    leaveMissing++;
  }

  // The 2022/2023 bug: voice_disconnect names the previous session's channel.
  const misattribute = previousTarget && chance(0.2);
  if (misattribute) wrongChannel++;
  push({
    event_type: 'voice_disconnect', timestamp: ts(end), duration: s.dur,
    context: 'default',
    duration_speaking_ms: speaking, duration_listening_ms: listening,
    ...chFields(misattribute ? previousTarget : s.target),
  });

  // Go Live runs in parallel with the session it belongs to.
  if (s.dur > 20 * MINUTE && chance(0.12)) {
    streams++;
    const sd = Math.floor(s.dur * between(0.2, 0.7));
    push({
      event_type: 'voice_disconnect', timestamp: ts(s.start + sd), duration: sd,
      context: 'stream', ...chFields(s.target),
    });
  }

  previousTarget = s.target;
}

// ---------------------------------------------------------- Messages ------

const MSG_TARGETS = [
  ...TEXT_CHANNELS.map((c) => ({ kind: 'guild', ch: c })),
  ...DMS.map((d) => ({ kind: 'dm', ch: d })),
  { kind: 'group', ch: GROUP },
];
const byChannel = new Map(); // channel id -> [{id, t}]

for (const t of MSG_TARGETS) {
  const n = Math.floor(t.ch.weight * between(120, 320));
  for (let i = 0; i < n; i++) {
    const at = Math.floor(between(START, END)) + pickHour() * HOUR;
    const id = snowflake(1200000000000000000n);
    const len = Math.floor(between(3, 220));
    const att = chance(0.06) ? 1 : 0;

    // Source A: the analytics event. Present for ~92 % — the rest are the
    // messages that only survive in the messages folder.
    if (chance(0.92)) {
      push({
        event_type: 'send_message', timestamp: ts(at), message_id: id,
        channel: t.ch.id, channel_type: t.kind === 'guild' ? 0 : t.kind === 'dm' ? 1 : 3,
        length: len, word_count: Math.max(1, Math.round(len / 5)), num_attachments: att,
        ...(t.kind === 'guild' ? { server: t.ch.guild.id } : {}),
      });
    }

    // Source B: the messages folder. Deleted messages are missing here but
    // still present as an event — that is the whole point of the union.
    if (chance(0.88)) {
      if (!byChannel.has(t.ch.id)) byChannel.set(t.ch.id, []);
      byChannel.get(t.ch.id).push({ id, t: at });
    }
  }
}

events.sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp)));

// ------------------------------------------------------------ Write -------

fs.rmSync(OUT, { recursive: true, force: true });
const mk = (...p) => { const d = path.join(OUT, ...p); fs.mkdirSync(d, { recursive: true }); return d; };
const write = (file, text) => fs.writeFileSync(file, text);

// activity/ — two reporting files that overlap heavily, as in a real package.
const actA = mk('activity', 'reporting');
const actB = mk('activity', 'tns');
const lines = events.map((e) => JSON.stringify(e));
write(path.join(actA, 'events-0000.json'), lines.join('\n') + '\n');
// The second file repeats 60 % of the events verbatim. Dedup happens by event_id.
const echoed = lines.filter(() => chance(0.6));
write(path.join(actB, 'events-0001.json'), echoed.join('\n') + '\n');

// servers/ — the server you left is deliberately absent.
for (const s of SERVERS) {
  if (!s.named) continue;
  const d = mk('servers', s.id);
  write(path.join(d, 'guild.json'), JSON.stringify({ id: s.id, name: s.name }, null, 2));
}

// messages/
const msgRoot = mk('messages');
const index = {};
// A server you left keeps no name anywhere: Discord writes the placeholder,
// not "channel in <server>". That is what makes it show up as "Server #1234".
for (const c of TEXT_CHANNELS) index[c.id] = c.guild.named ? `${c.name} in ${c.guild.name}` : 'Unknown channel';
for (const d of DMS) index[d.id] = `Direct Message with ${d.contact.name}#0`;
index[GROUP.id] = 'Unknown channel'; // an unnamed group — the dashboard labels it from its members
write(path.join(msgRoot, 'index.json'), JSON.stringify(index, null, 2));

function channelJson(t) {
  if (t.kind === 'guild') {
    return { id: t.ch.id, type: 'GUILD_TEXT', name: t.ch.name,
             guild: t.ch.guild.named ? { id: t.ch.guild.id, name: t.ch.guild.name } : { id: t.ch.guild.id } };
  }
  if (t.kind === 'dm') return { id: t.ch.id, type: 'DM', recipients: [SELF, t.ch.contact.id] };
  return { id: t.ch.id, type: 'GROUP_DM', recipients: [SELF, ...t.ch.members.map((m) => m.id)] };
}

for (const t of MSG_TARGETS) {
  const list = byChannel.get(t.ch.id) || [];
  const d = mk('messages', 'c' + t.ch.id);
  write(path.join(d, 'channel.json'), JSON.stringify(channelJson(t), null, 2));
  // Written as raw text on purpose: the ID has to stay an unrounded JSON
  // NUMBER larger than 2^53, which JSON.stringify could not preserve.
  const rows = list
    .sort((a, b) => a.t - b.t)
    .map((m) => `  {\n    "ID": ${m.id},\n    "Timestamp": "${new Date(m.t).toISOString()}",\n`
              + `    "Contents": "(sample message)",\n    "Attachments": ""\n  }`);
  write(path.join(d, 'messages.json'), `[\n${rows.join(',\n')}\n]\n`);
}

// account/
const acc = mk('account');
write(path.join(acc, 'user.json'), JSON.stringify({
  id: SELF, username: 'sample_user', global_name: 'Sample User',
}, null, 2));

// ----------------------------------------------------------- Report -------

const voiceHours = sessions.reduce((a, s) => a + s.dur, 0) / 3600000;
const msgCount = [...byChannel.values()].reduce((a, l) => a + l.length, 0);
console.log(`Sample package written to ${OUT}`);
console.log(`  seed             : ${SEED}  (same seed -> same package)`);
console.log(`  period           : 2024-01-01 to 2024-09-30`);
console.log(`  sessions         : ${sessions.length}  (~${voiceHours.toFixed(0)} h before dedup)`);
console.log(`  events written   : ${events.length} + ${echoed.length} duplicated`);
console.log(`  messages in folder: ${msgCount}`);
console.log(`  quirks baked in  : ${leaveMissing} sessions without a leave event,`);
console.log(`                     ${wrongChannel} misattributed voice_disconnect, ${streams} Go Live overlaps`);
console.log(`\nNext:  node build.mjs --package "${path.relative(process.cwd(), OUT) || OUT}"`);
