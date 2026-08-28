'use strict';

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { REST, Routes } = require('discord.js');
const { buildMinimalInviteURL } = require('./lib/security');

const { DISCORD_TOKEN, DISCORD_CLIENT_ID, DISCORD_GUILD_ID } = process.env;

if (!DISCORD_TOKEN || !DISCORD_CLIENT_ID) {
  console.error('Missing DISCORD_TOKEN or DISCORD_CLIENT_ID in environment. Copy .env.example to .env and fill it in.');
  process.exit(1);
}

const commandsDir = path.join(__dirname, 'commands');
const commands = fs
  .readdirSync(commandsDir)
  .filter((f) => f.endsWith('.js'))
  .map((file) => require(path.join(commandsDir, file)).data.toJSON());

const rest = new REST().setToken(DISCORD_TOKEN);

(async () => {
  try {
    const route = DISCORD_GUILD_ID
      ? Routes.applicationGuildCommands(DISCORD_CLIENT_ID, DISCORD_GUILD_ID)
      : Routes.applicationCommands(DISCORD_CLIENT_ID);

    const data = await rest.put(route, { body: commands });
    console.log(
      `Registered ${data.length} command(s) ${DISCORD_GUILD_ID ? `to guild ${DISCORD_GUILD_ID}` : 'globally'}.`
    );
    console.log('\nMinimal-permission invite link (use this, not "Administrator"):');
    console.log(buildMinimalInviteURL(DISCORD_CLIENT_ID));
  } catch (err) {
    console.error('Failed to register commands:', err);
    process.exit(1);
  }
})();
