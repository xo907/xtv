# XTV

Live TV in the browser: a channel guide, search and favorites over your own IPTV channels and thousands of free channels from [iptv-org](https://github.com/iptv-org/iptv), with a small server that plays streams the way VLC does.

## Features

- **Guide and channel list** with program info, search (`/`), favorites, and filters by country and category.
- **Free channels by country** from iptv-org, numbered in blocks per country (e.g. US from 1000, UK from 3000), with program guides where available.
- **Broken channels hidden automatically.** Every stream is checked and rechecked every 12 hours; admins can retry them and see why they fail.
- **Plays what browsers normally can't:** raw MPEG-TS, streams that need a particular user agent or referrer, servers without CORS, and (with ffmpeg) formats like MPEG-2.
- **Ads covered** where they can be detected (Pluto TV ad segments, ad-break markers, known ad servers).
- **DVR mode:** watch a few minutes behind live with ad breaks cut out, with pause. Nothing is downloaded; a recording is a list of segment links kept in memory.
- **Subtitles** (CC) where the stream has them.
- **Accounts:** the first account is the admin, who manages the lineup, countries, channel status and users. Everyone else gets their own favorites.

## Requirements

- [Node.js](https://nodejs.org) 18 or newer. There are no npm dependencies.
- Optional: [ffmpeg](https://ffmpeg.org) on your `PATH`, to play formats browsers can't decode.

## Getting started

```bash
git clone https://github.com/xo907/xtv.git
cd xtv
node server.js
```

Open <http://localhost:8092> and create an account. **The first account becomes the admin.**

Out of the box you get the free US and UK channels. Add more countries under **Settings → Countries**.

## Your own channels

Copy the example config and edit it:

```bash
cp channels.example.js channels.js
```

In `channels.js` you can set the countries to load (`iptvCountries`) and add your own channels to `channels`, such as streams from an IPTV provider. Each channel needs at least a `url`; the file explains the other fields (number, name, logo, guide link, and so on).

`channels.js` is ignored by git because it can contain provider logins. Admins can also edit the lineup in the app under **Settings → Lineup**; those changes are saved in `data/`.

## Keys

| Key | Action |
| --- | --- |
| `↑` `↓` | Channel up / down |
| `0`–`9` | Go to a channel number |
| `G` / `L` | Guide / channel list |
| `/` | Search channels |
| `S` | Add / remove favorite (or right-click a channel) |
| `C` | Subtitles |
| `D` | DVR on / off |
| `Space` | Pause (DVR) |
| `M` / `F` | Mute / fullscreen |
| `E` | Settings |
| `H` | All keys |

## Configuration

Set these environment variables when starting the server:

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `8092` | Port to listen on |
| `HOST` | `127.0.0.1` | Address to listen on. Use `0.0.0.0` to allow other devices on your network. |
| `DATA_DIR` | `./data` | Where accounts, sessions and settings are stored |
| `FFMPEG` | `ffmpeg` | Path to ffmpeg |

## Files

| Path | What it is |
| --- | --- |
| `server.js` | Web server: stream relay, accounts, iptv-org data, guides, stream checks |
| `dvr.js` | DVR recordings |
| `app.js`, `index.html`, `styles.css` | The app |
| `channels.example.js` | Example lineup and settings |
| `data/` | Accounts, sessions, settings, saved lineup (created on first run; keep private) |
| `.cache/` | Downloaded iptv-org data and stream check results |

## Notes

- By default the server only accepts connections from this computer. If you set `HOST=0.0.0.0`, anyone who can reach it and has an account can use it to relay streams.
- Free channels come and go. XTV hides the ones that stop working and brings them back when they recover.
- Channel data and guides come from [iptv-org](https://github.com/iptv-org) and [i.mjh.nz](https://i.mjh.nz).
