'use strict';

const {
  SlashCommandBuilder,
  PermissionFlagsBits,
  ChannelType,
  EmbedBuilder,
} = require('discord.js');
const { scanChannelForImageAuthors } = require('../lib/scraper');
const { createSession, getSession } = require('../lib/sessionStore');
const { buildBackupUI } = require('../lib/menuBuilder');
const { auditGuildPermissions, auditChannelPermissions } = require('../lib/security');
const { tryAcquire, release } = require('../lib/concurrencyLock');
const { logAuditEvent } = require('../lib/auditLog');

const MAX_MESSAGES_TO_SCAN = Number(process.env.MAX_MESSAGES_TO_SCAN) || 10000;
const PROGRESS_UPDATE_INTERVAL_MS = 2000;

function excessPermissionMessage(audit) {
  return (
    `🔒 **Refusing to run.** This bot detected permissions beyond what a read-only photo backup ` +
    `needs (${audit.excess.join(', ')}) at the ${audit.scope} level.\n\n` +
    'To limit the damage a leaked bot token could do, this command will not run until a server ' +
    'admin removes those permissions from the bot\'s role (or the channel override) in ' +
    '**Server Settings > Roles**, or **Edit Channel > Permissions**.'
  );
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('backup')
    .setDescription('Scan a channel for images and back up a user\'s photos into a zip file.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setDMPermission(false)
    .addChannelOption((option) =>
      option
        .setName('channel')
        .setDescription('The channel to scan for images')
        .addChannelTypes(
          ChannelType.GuildText,
          ChannelType.GuildAnnouncement,
          ChannelType.PublicThread,
          ChannelType.PrivateThread
        )
        .setRequired(true)
    ),

  async execute(interaction) {
    // Defense in depth: enforce the permission requirement in code too, in
    // case a server admin has loosened the command's default permissions
    // via Integrations settings after the bot was invited.
    if (!interaction.inGuild() || !interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
      await interaction.reply({
        content: 'You need the **Manage Server** permission to run `/backup`.',
        ephemeral: true,
      });
      return;
    }

    const channel = interaction.options.getChannel('channel', true);

    const guildAudit = await auditGuildPermissions(interaction.guild);
    const channelAudit = auditChannelPermissions(channel, interaction.guild.members.me);
    const unsafeAudit = !guildAudit.safe ? guildAudit : !channelAudit.safe ? channelAudit : null;
    if (unsafeAudit) {
      console.warn(
        `[security] Refusing /backup in guild ${interaction.guildId}: excess permissions detected (${unsafeAudit.scope}): ${unsafeAudit.excess.join(', ')}`
      );
      await interaction.reply({ content: excessPermissionMessage(unsafeAudit), ephemeral: true });
      await logAuditEvent({
        action: 'backup_command',
        outcome: 'blocked_excess_permissions',
        guildId: interaction.guildId,
        channelId: channel.id,
        requesterId: interaction.user.id,
        excess: unsafeAudit.excess,
      });
      return;
    }

    const botPermissions = channel.permissionsFor(interaction.client.user);
    if (!botPermissions?.has(PermissionFlagsBits.ViewChannel) || !botPermissions.has(PermissionFlagsBits.ReadMessageHistory)) {
      await interaction.reply({
        content: `I need **View Channel** and **Read Message History** permissions in <#${channel.id}> to scan it.`,
        ephemeral: true,
      });
      return;
    }

    if (!tryAcquire(interaction.guildId)) {
      await interaction.reply({
        content: 'A backup is already running in this server. Please wait for it to finish.',
        ephemeral: true,
      });
      return;
    }

    await interaction.deferReply({ ephemeral: true });

    try {
      let lastUpdate = 0;
      const authorsMap = await scanChannelForImageAuthors(channel, {
        maxMessages: MAX_MESSAGES_TO_SCAN,
        onProgress: async ({ scanned, imagesFound }) => {
          const now = Date.now();
          if (now - lastUpdate < PROGRESS_UPDATE_INTERVAL_MS) return;
          lastUpdate = now;
          await interaction.editReply({
            embeds: [
              new EmbedBuilder()
                .setTitle('🔎 Scanning channel...')
                .setColor(0x5865f2)
                .setDescription(`Scanned **${scanned}** messages, found **${imagesFound}** image(s) so far.`),
            ],
          }).catch(() => {});
        },
      });

      if (authorsMap.size === 0) {
        await interaction.editReply({
          content: `No image attachments were found in <#${channel.id}> (scanned up to ${MAX_MESSAGES_TO_SCAN} messages).`,
          embeds: [],
        });
        return;
      }

      const authors = [...authorsMap.values()].sort((a, b) => b.count - a.count);

      const sessionId = createSession({
        channelId: channel.id,
        guildId: interaction.guildId,
        requesterId: interaction.user.id,
        authors,
        page: 0,
      });

      const session = getSession(sessionId);
      await interaction.editReply(buildBackupUI(session));
    } finally {
      // Only the scan phase holds the lock; the download/zip phase
      // (triggered by picking a user) re-acquires it in backupComponents.js
      // so the lock isn't held open-ended while the user thinks.
      release(interaction.guildId);
    }
  },
};
