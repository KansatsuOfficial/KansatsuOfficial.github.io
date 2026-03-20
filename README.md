# KansatsuOfficial.github.io

Static site for https://kansatsuofficial.github.io.

## Fan list automation

- Source data comes from the public Bilibili fan-members and guard-members APIs.
- Run `node scripts/update-fans.mjs` to incrementally refresh `fans.txt` and `fans.json` locally.
- The updater keeps existing records and only adds or upgrades entries from the latest API response, so old fans and old guards are preserved.
- `.github/workflows/update-fans.yml` refreshes the files every 6 hours and also supports manual runs from GitHub Actions.
- Update `BILIBILI_UID` in the workflow or environment if the channel UID changes later.
