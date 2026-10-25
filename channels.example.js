/*
 * XTV channel lineup — example. Copy this file to channels.js and fill in your own streams.
 * ------------------
 * This is the default lineup. Replace the sample streams below with your own
 * .m3u8 (HLS) or direct video links. Any channel added/edited from the in-app
 * "Lineup" screen is saved in the browser and takes priority over this file
 * (use "Reset to channels.js" in that screen to come back to this file).
 *
 * Channel fields:
 *   number        Channel number (optional, auto-assigned if missing)
 *   name          Display name
 *   callsign      Short ID shown in the banner (optional)
 *   group         Category used by the guide filters (optional)
 *   logo          Image URL for the channel logo (optional)
 *   url           Stream URL: .m3u8 (HLS) or .mp4 / .webm   (required)
 *   defaultTitle  Program title used when nothing is scheduled (optional)
 *   description   Fallback program description (optional)
 *   schedule      Daily repeating program list (optional):
 *                   { start: "HH:MM", end: "HH:MM", title, desc, days: [0-6] }
 *                 days is optional (0 = Sunday). end <= start means it runs past midnight.
 *   iptvId        iptv-org channel ID, e.g. "DisneyXD.us" (optional; needs node server.js). Fills in a
 *                 missing logo and category from https://github.com/iptv-org/api
 *   epg           Live guide URL (optional). An Xtream Codes player_api.php link:
 *                   http://HOST/player_api.php?username=U&password=P&action=get_simple_data_table&stream_id=ID
 *                 Overrides `schedule` once loaded; refreshed every 30 minutes.
 *
 * playlistUrl: optional path/URL to an .m3u playlist that gets appended to
 * the channels below at startup (e.g. "channels.m3u" next to this file).
 */
window.XTV_CONFIG = {
  networkName: "XTV",
  playlistUrl: "",
  // Free iptv-org channels to add for these countries (change it in the app under Lineup → Countries).
  iptvCountries: ["US", "UK"],
  // Your own channels (e.g. from an IPTV provider). Uncomment and fill in to add one.
  channels: [
    // {
    //   number: 301,
    //   name: "Disney XD",
    //   callsign: "DXD",
    //   group: "Kids",
    //   url: "http://YOUR-PROVIDER:PORT/USERNAME/PASSWORD/STREAM_ID",
    //   iptvId: "DisneyXD.us",
    //   epg: "http://YOUR-PROVIDER:PORT/player_api.php?username=USERNAME&password=PASSWORD&action=get_simple_data_table&stream_id=STREAM_ID",
    //   defaultTitle: "Disney XD"
    // }
  ]
};
