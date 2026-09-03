# Discord Photo Scraper Bot

A Discord bot that scans a channel for image attachments, lets you visually
pick a user from a dropdown of everyone who's posted photos there, and backs
up their images (or everyone's) into a zip file for storage.

## Features

- `/backup channel:#some-channel` scans the channel's full history for image
  attachments and groups them by author.
- Presents a paginated select-menu embed showing each user and how many
  images they've posted, plus a **Back Up Everyone** button.
- Downloads the chosen user's (or everyone's) images and zips them into
  `backups/<guild-id>/<channel>_<user>_<timestamp>.zip` on disk.
- Uploads the zip back into Discord if it's under the configured size limit;
  otherwise it's still saved on disk and the bot tells you where.

## Setup

1. **Create a Discord application & bot**
   - Go to the [Discord Developer Portal](https://discord.com/developers/applications), create a new application, then add a Bot.
   - Under **Bot**, enable the **Message Content Intent** (required to read attachments on messages the bot didn't send).
   - Copy the bot token and the application's Client ID.

2. **Configure environment variables**
   ```bash
   cp .env.example .env
   ```
   Fill in `DISCORD_TOKEN`, `DISCORD_CLIENT_ID`, and (recommended during development) `DISCORD_GUILD_ID` for your test server so slash commands register instantly.

3. **Install dependencies** (Node 18.17 or newer)
   ```bash
   npm install
   ```

4. **Register the slash command and get your invite link**
   ```bash
   npm run deploy-commands
   ```
   This registers `/backup` and prints a ready-to-use invite link built from the exact minimal permission set the bot needs (`View Channels`, `Read Message History`, `Send Messages`, `Attach Files`, `Embed Links`).

5. **Invite the bot to your server**
   - Open the invite link printed in the previous step.
   - If building the link by hand instead, in **OAuth2 > URL Generator** select the `bot` and `applications.commands` scopes, and grant only those same permissions.
   - **Never grant `Administrator`** or broad moderation permissions (Manage Server/Roles/Channels, Kick/Ban/Timeout Members, Manage Webhooks, etc.) — the bot doesn't need them, and it will refuse to run `/backup` in any server where it detects them (see **Security Model** below).

6. **Run the bot**
   ```bash
   npm start
   ```

To run the unit tests (mocked Discord objects, no token needed):
```bash
npm test
```

## Usage

1. Run `/backup channel:#photos` (requires the **Manage Server** permission by default).
2. The bot scans the channel and shows an embed listing everyone who has
   posted images there, with a dropdown to pick a specific person, Prev/Next
   buttons if there are more than 25 users, a **Back Up Everyone** button,
   and Cancel.
3. Pick a user (or Back Up Everyone) — the bot downloads their images,
   zips them, saves the zip under `backups/`, and uploads it back to you if
   it's small enough.

## Configuration

See `.env.example` for all options, including the max number of messages
scanned per run (`MAX_MESSAGES_TO_SCAN`) and the max zip size the bot will
try to re-upload to Discord (`MAX_DISCORD_UPLOAD_BYTES`).

## Notes

- The `/backup` command defaults to requiring the **Manage Server**
  permission, since it can pull every image a user has posted in a channel.
  Server admins can adjust this under **Server Settings > Integrations**.
- The select-menu picker is ephemeral (only visible to whoever ran the
  command), and only that person can interact with its buttons/dropdown.
- Backup sessions (the scanned user list) expire after 15 minutes of
  inactivity.

## Security Model

This bot is built to limit the damage a leaked token, an over-permissioned
invite, or a malicious attachment could do, at every stage from creating the
bot to backing up a channel:

**Bot key / credentials**
- The token lives only in `.env`, which is git-ignored (never commit it).
- If the token ever leaks, reset it immediately in the Developer Portal's
  Bot page — this instantly invalidates the old one.
- On startup the bot does a loose sanity check on `DISCORD_TOKEN`'s shape
  and warns (without ever logging the token itself) if it looks malformed.

**Least-privilege permissions, enforced at runtime**
- `src/lib/security.js` defines the exact permission set the bot needs
  (`REQUIRED_PERMISSIONS`) and a list of permissions it should never hold
  (`DANGEROUS_PERMISSIONS`: Administrator, Manage Server/Roles/Channels,
  Kick/Ban/Timeout Members, Manage Webhooks/Messages, View Audit Log, and
  more). Permissions Discord turns on for `@everyone` by default (Create
  Invite, Mention Everyone, reactions, voice) are deliberately not on that
  list, so the guard doesn't false-positive on a normally configured server.
- On login, and whenever the bot joins a new server, it checks its actual
  granted permissions and logs a warning naming exactly which dangerous
  permission(s) are present, if any.
- Before scanning a channel (`/backup`) **and again** right before
  downloading anything (after you pick a user), it re-checks live — not
  cached — permissions at both the server-role level and the specific
  channel's level. If a dangerous permission is present at either level, it
  refuses to run and tells you (and the server) what to remove.
- Optionally set `AUTO_LEAVE_ON_EXCESS_PERMISSIONS=true` to have the bot
  immediately leave any server that over-permissions it.
- The command's own required permission (**Manage Server**, by default) is
  enforced twice: once by Discord's slash-command permission system, and
  once again in the command's code — so loosening it in **Integrations**
  settings doesn't quietly open the command to everyone.

**Backing up safely**
- Attachments are only ever fetched from Discord's own CDN hosts
  (`cdn.discordapp.com` / `media.discordapp.net`); anything else is skipped.
- Per-file (`MAX_ATTACHMENT_BYTES`) and total-backup (`MAX_TOTAL_BACKUP_BYTES`)
  size caps stop a disguised huge "image" or a huge channel from exhausting
  the host's memory or disk. Downloads are streamed and cut off the moment
  they pass the per-file cap, and each has a 30-second timeout. A run that
  hits the total cap discards the partial zip rather than leaving a
  truncated one behind.
- Zip entry names have every path separator (forward and back slash),
  control character, and leading dot stripped before use, so a crafted
  filename can't zip-slip outside the archive. A weird filename or a failed
  download skips that one file; it never aborts the whole backup.
- Every backup's output path is resolved and verified to stay inside
  `backups/` before anything is written.
- A per-server lock (`src/lib/concurrencyLock.js`) stops two `/backup` runs
  from hammering the same server at once.
- Every backup attempt — success, blocked, or error — is appended to
  `logs/audit.log` (who ran it, on what channel/user, and the outcome) for
  after-the-fact review.
- Only the person who ran `/backup` can use its dropdown/buttons, and a
  backup session expires after 15 minutes.
