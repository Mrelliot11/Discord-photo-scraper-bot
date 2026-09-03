'use strict';

const {
  SlashCommandBuilder,
  PermissionFlagsBits,
  ChannelType,
  EmbedBuilder,
  InteractionContextType,
  MessageFlags,
} = require('discord.js');
const { scanChannelForImageAuthors } = require('../lib/scraper');
const { createSession, getSession } = require('../lib/sessionStore');
const { buildBackupUI } = require('../lib/menuBuilder');
const { auditBotPermissions } = require('../lib/security');
const { tryAcquire, release } = require('../lib/concurrencyLock');
const { logAuditEvent } = require('../lib/auditLog');
const { createProgressReporter } = require('../lib/progress');

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
    .setContexts(InteractionContextType.Guild)
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
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const channel = interaction.options.getChannel('channel', true);

    // A channel the bot can't see (e.g. a private thread it isn't in)
    // resolves to a bare API object with no permissionsFor/messages.
    if (typeof channel.permissionsFor !== 'function' || typeof channel.isTextBased !== 'function' || !channel.isTextBased()) {
      await interaction.reply({
        content: `I can't access <#${channel.id}>. Make sure I have **View Channel** there (and am added to it, if it's a private thread).`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    // Acknowledge before doing any REST calls: Discord only gives us 3s.
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const unsafeAudit = await auditBotPermissions(interaction.guild, channel);
    if (unsafeAudit) {
      console.warn(
        `[security] Refusing /backup in guild ${interaction.guildId}: excess permissions detected (${unsafeAudit.scope}): ${unsafeAudit.excess.join(', ')}`
      );
      await interaction.editReply({ content: excessPermissionMessage(unsafeAudit) });
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
      await interaction.editReply({
        content: `I need **View Channel** and **Read Message History** permissions in <#${channel.id}> to scan it.`,
      });
      return;
    }

    if (!tryAcquire(interaction.guildId)) {
      await interaction.editReply({
        content: 'A backup is already running in this server. Please wait for it to finish.',
      });
      return;
    }

    try {
      const progress = createProgressReporter(interaction, PROGRESS_UPDATE_INTERVAL_MS, ({ scanned, imagesFound }) => ({
        embeds: [
          new EmbedBuilder()
            .setTitle('🔎 Scanning channel...')
            .setColor(0x5865f2)
            .setDescription(`Scanned **${scanned}** messages, found **${imagesFound}** image(s) so far.`),
        ],
      }));

      const authorsMap = await scanChannelForImageAuthors(channel, {
        maxMessages: MAX_MESSAGES_TO_SCAN,
        onProgress: progress.report,
      });
      await progress.flush();

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

      await interaction.editReply(buildBackupUI(getSession(sessionId)));
    } finally {
      // Only the scan phase holds the lock; the download/zip phase
      // (triggered by picking a user) re-acquires it in backupComponents.js
      // so the lock isn't held open-ended while the user thinks.
      release(interaction.guildId);
    }
  },
};
