# How the numbers are made

Everything a dashboard claims should be checkable. This document says where
each figure comes from, which source was rejected and why, and where the
remaining uncertainty sits.

> **About the percentages below.** They were measured against one reference
> package covering roughly four years of use. They describe how the *sources*
> behave, not how much anyone talked, and your own package will land on slightly
> different values. `build.mjs` computes the equivalent diagnostics for whatever
> package you feed it and prints them under *Data quality* in the dashboard.

---

## 1. What is actually in the package

| Folder | What it holds | Used for |
| --- | --- | --- |
| `activity/` | Newline-delimited analytics events, several files | Voice time, sent messages, names |
| `messages/` | One folder per channel, plus `index.json` | Message history, names, DM participants |
| `servers/` | One folder per server with `guild.json` | Server names |
| `account/` | `user.json` | Your user ID, and nothing else |

The folder names are translated into your Discord language. The build looks for
the names it knows and, failing that, identifies each folder by its contents —
Discord translates folder names but never file names, so `events-*.json`,
`channel.json`, `guild.json` and `user.json` are a reliable fingerprint.

Only four event types are read: `join_voice_channel`, `leave_voice_channel`,
`voice_disconnect` and `send_message`. Everything else is skipped on a cheap
substring test before the line is ever parsed as JSON, which is what keeps a
1.7 GB package down to about ten seconds.

The activity folder ships several reporting streams (`reporting`, `tns`) whose
contents overlap heavily. They are deduplicated by `event_id`.

---

## 2. Voice time

### The source that was rejected

`voice_disconnect` is the intuitive choice. It carries a `duration`, a
`channel_id`, and even `duration_speaking_ms` / `duration_listening_ms`. It is
also, in the 2022 and 2023 client builds, **wrong about the channel roughly 30 %
of the time** — it reports the channel of the *previous* session.

The failure is systematic, not random: the timestamps and durations are correct,
only the attribution slips. Which makes it exactly the kind of defect that
produces a plausible-looking dashboard full of misplaced hours.

### The source that was used

`leave_voice_channel` carries a `duration` in milliseconds, so a session is

```
[ timestamp − duration ,  timestamp ]
```

Validated against `join_voice_channel`, which is the ground truth for *which*
channel you entered:

| Check | Agreement |
| --- | --- |
| Computed start lands on a join event, ±5 seconds | **94.7 %** |
| Computed start lands on a join event, ±60 seconds | **97.4 %** |
| The channel matches the join event's channel | **98.4 %** |

For cross-checking the totals: summing all `leave_voice_channel` durations and
summing all non-stream `voice_disconnect` durations produce results **within
2 % of each other**, and within 2 % of their union. The two sources
independently confirm the amount of time. They disagree only about *where* it
was spent — which is why one of them decides the attribution and the other one
only fills gaps.

### Gap filling

Crashes, killed clients and lost events leave stretches that no
`leave_voice_channel` covers. Those are reconstructed from `voice_disconnect`
under three restrictions:

1. **`context = "stream"` is excluded** — Go Live runs in parallel with the
   session it belongs to and would double-count (see below).
2. **The channel is corrected** via the nearest `join_voice_channel` within
   10 seconds of the computed start. In the reference package this rewrote the
   channel on a substantial minority of fill candidates — every one of them an
   instance of the defect described above.
3. **Only genuinely uncovered time is adopted.** The union of the base timeline
   is subtracted from each candidate first; what remains must still be at least
   one minute long to be kept.

In the reference package gap filling contributed **about 1.8 %** of total voice
time. The dashboard's *Gap filling* switch removes it again, so you can see
exactly what it is doing to your own numbers.

### Making the timeline honest

- **No overlaps.** You cannot be in two voice channels at once. Overlapping
  intervals are trimmed so every second belongs to exactly one channel. The
  amount trimmed is reported as `trimmedOverlapSeconds`.
- **Sessions under 5 seconds are dropped** — misclicks, not conversations.
- **Go Live is separate.** A `voice_disconnect` with `context = "stream"` is
  laid onto the session it overlaps and recorded as its own metric. It never
  adds time, because you were already in that call.
- **Speaking and listening time** are taken from the `voice_disconnect` that
  overlaps a session, and scaled proportionally when a session is clipped by the
  selected period.

### Splitting at period boundaries

A session that starts at 23:40 on the last day of a month and ends at 02:15 does
not belong to either month alone. In the *Over time* chart such sessions are cut
at the boundary and each part is counted where it happened.

---

## 3. Messages

Two sources, unioned by message ID:

- **The `messages` folder** — the complete history of what still exists on
  Discord, but only for channels that were actually extracted into the package.
- **`send_message` events** — limited to the analytics window, but covering all
  channels, including messages you have since deleted.

In the reference package roughly **79 %** of messages appeared in both sources,
**11 %** only in the events (mostly deleted), and **10 %** only in the messages
folder (mostly older than the analytics window). The sources largely agree and
complement each other at the edges — which is precisely why the union is worth
building and why deduplication has to be exact.

### The trap that makes the union silently useless

In `messages.json`, Discord writes the message ID as a JSON **number**. Discord
snowflakes exceed 2^53, so `JSON.parse` rounds them:

```js
JSON.parse('{"ID": 1176134705371263006}').ID   //  1176134705371263000
```

Two distinct messages can round to the same value, and the same message rounds
differently from the string ID the events carry. The deduplication would then
match nothing, and every message present in both sources would be counted twice
— a silent 80 % overcount that looks entirely plausible.

`build.mjs` therefore quotes the IDs in the raw text before parsing:

```js
raw.replace(/"ID"(\s*):(\s*)(\d+)/g, '"ID"$1:$2"$3"')
```

Events and `channel.json` already deliver their IDs as strings.

---

## 4. Names

Nothing in the package gives you one clean table of names, so they are assembled
from whatever survives, in order of trustworthiness.

**Servers**

1. `servers/<id>/guild.json` — authoritative, present for servers you are still in.
2. `guild_name` on any event that happens to carry it.
3. `messages/index.json`, whose labels read `channel in Server name`; the
   channel ID links back to the server.

Servers you have left leave nothing behind in any of the three. They appear as
`Server #1234` and can be renamed by hand in the dashboard.

**People**

1. `messages/index.json` gives `Direct Message with name#0` for one-to-one
   chats.
2. Cross-referencing that with `channel.json`, which lists the participant IDs,
   yields a user-ID → name mapping.
3. That mapping then labels group chats that have no name of their own:
   `Group: alice, bob +2`.

What is left over are groups you never wrote in — Discord ships no channel
folder for those, so there is nothing to cross-reference. They are marked
*unnamed* and can be renamed in the dashboard. The name is stored in the
browser's `localStorage` and changes nothing in the package.

**Direct call ↔ person**

The channel type comes from the events themselves: `1` = one-to-one DM,
`3` = group DM, anything else belongs to a server.

---

## 5. What comes out

`dist/data.json` is column-oriented to stay small:

```
sessions.s   session start, Unix seconds
sessions.d   duration in seconds
sessions.c   index into channels[]
sessions.f   1 = this session came from gap filling
sessions.sp  speaking time, seconds
sessions.li  listening time, seconds
sessions.st  Go Live time, seconds

messages.t   timestamp, Unix seconds
messages.c   index into channels[]
messages.l   length in characters (−1 = unknown)
messages.a   attachment count (−1 = unknown)
messages.s   source: 1 = events, 2 = messages folder, 3 = both
```

Plus `guilds[]`, `channels[]` and a `quality` block carrying the diagnostics the
dashboard shows.

Deliberately **not** in the output: your user ID, your display name, and the
path to your package. The dashboard never reads them, and the file is built to
be moved around — so they would only ever be a leak.

---

## 6. Checking it yourself

The dashboard's *Data quality* section reports, for your package: event lines
read, duplicate events discarded, sessions reconstructed, the share of voice
time that came from gap filling, how many channel attributions were corrected,
and how many servers could be named. Every warning `build.mjs` printed while
running appears there too.

If a number looks wrong, the two switches to reach for first are *Gap filling*
(removes reconstructed time) and *Hide short sessions* (drops anything under a
minute). If the totals move a lot, that tells you which part of the
reconstruction your package is leaning on.
