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

const MAX_MESSAGES_TO_SCAN = Number(process.env.MAX_MESSAGES_TO_SCAN) || 10000;
const PROGRESS_UPDATE_INTERVAL_MS = 2000;

module.exports = {
  data: new SlashCommandBuilder()
    .setName('backup')
    .setDescription('Scan a channel for images and back up a user\'s photos into a zip file.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
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
    const channel = interaction.options.getChannel('channel', true);

    const botPermissions = channel.permissionsFor(interaction.client.user);
    if (!botPermissions?.has(PermissionFlagsBits.ViewChannel) || !botPermissions.has(PermissionFlagsBits.ReadMessageHistory)) {
      await interaction.reply({
        content: `I need **View Channel** and **Read Message History** permissions in <#${channel.id}> to scan it.`,
        ephemeral: true,
      });
      return;
    }

    await interaction.deferReply({ ephemeral: true });

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
  },
};
