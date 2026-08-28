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

2. **Invite the bot to your server**
   - In **OAuth2 > URL Generator**, select the `bot` and `applications.commands` scopes.
   - Under bot permissions, select at least: `View Channels`, `Read Message History`, `Send Messages`, `Attach Files`, `Use Slash Commands`.
   - Open the generated URL and add the bot to your server.

3. **Configure environment variables**
   ```bash
   cp .env.example .env
   ```
   Fill in `DISCORD_TOKEN`, `DISCORD_CLIENT_ID`, and (recommended during development) `DISCORD_GUILD_ID` for your test server so slash commands register instantly.

4. **Install dependencies**
   ```bash
   npm install
   ```

5. **Register the slash command**
   ```bash
   npm run deploy-commands
   ```

6. **Run the bot**
   ```bash
   npm start
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
