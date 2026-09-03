'use strict';

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Client, GatewayIntentBits, Collection, MessageFlags } = require('discord.js');
const { handleBackupComponent } = require('./interactions/backupComponents');
const { auditGuildPermissions } = require('./lib/security');

const token = process.env.DISCORD_TOKEN?.trim();
if (!token) {
  console.error('Missing DISCORD_TOKEN in environment. Copy .env.example to .env and fill it in.');
  process.exit(1);
}
// Loose sanity check only (Discord's token format has shifted before) —
// never log the token itself, just flag if it looks obviously wrong.
if (!/^[\w-]+\.[\w-]+\.[\w-]+$/.test(token)) {
  console.warn(
    '[security] DISCORD_TOKEN does not look like a well-formed bot token. ' +
      'If login fails, re-copy it from the Developer Portal and make sure .env has no extra quotes/spaces.'
  );
}

const AUTO_LEAVE_ON_EXCESS_PERMISSIONS = process.env.AUTO_LEAVE_ON_EXCESS_PERMISSIONS === 'true';

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

client.commands = new Collection();
const commandsDir = path.join(__dirname, 'commands');
for (const file of fs.readdirSync(commandsDir).filter((f) => f.endsWith('.js'))) {
  const command = require(path.join(commandsDir, file));
  client.commands.set(command.data.name, command);
}

/**
 * Warns loudly (and optionally leaves) when this bot has been granted
 * permissions it doesn't need. This is a visibility check on top of the
 * live re-checks done at command/component time — those are what actually
 * block `/backup` from running.
 */
async function auditAndWarnGuild(guild) {
  try {
    const audit = await auditGuildPermissions(guild);
    if (audit.safe) return;

    console.warn(
      `[security] Guild "${guild.name}" (${guild.id}) has granted this bot excess permissions: ` +
        `${audit.excess.join(', ')}. /backup will refuse to run here until an admin removes them.`
    );

    if (AUTO_LEAVE_ON_EXCESS_PERMISSIONS) {
      console.warn(`[security] AUTO_LEAVE_ON_EXCESS_PERMISSIONS is set — leaving guild ${guild.id}.`);
      await guild.leave().catch((err) => console.error('Failed to leave guild:', err));
    }
  } catch (err) {
    console.error(`Failed to audit permissions for guild ${guild.id}:`, err);
  }
}

client.once('clientReady', async () => {
  console.log(`Logged in as ${client.user.tag}`);
  for (const guild of client.guilds.cache.values()) {
    await auditAndWarnGuild(guild);
  }
});

client.on('guildCreate', (guild) => {
  auditAndWarnGuild(guild);
});

client.on('interactionCreate', async (interaction) => {
  try {
    if (interaction.isChatInputCommand()) {
      const command = client.commands.get(interaction.commandName);
      if (!command) return;
      await command.execute(interaction);
      return;
    }

    if ((interaction.isStringSelectMenu() || interaction.isButton()) && interaction.customId.startsWith('bkp:')) {
      await handleBackupComponent(interaction);
      return;
    }
  } catch (err) {
    console.error('Error handling interaction:', err);
    const payload = { content: 'Something went wrong handling that.', flags: MessageFlags.Ephemeral };
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply({ content: payload.content }).catch(() => {});
    } else {
      await interaction.reply(payload).catch(() => {});
    }
  }
});

client.login(token);
