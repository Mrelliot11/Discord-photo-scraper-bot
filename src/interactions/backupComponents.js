'use strict';

const path = require('path');
const fs = require('fs');
const { EmbedBuilder, AttachmentBuilder } = require('discord.js');
const { getSession, deleteSession } = require('../lib/sessionStore');
const { buildBackupUI } = require('../lib/menuBuilder');
const { backupChannelImages } = require('../lib/scraper');

const MAX_MESSAGES_TO_SCAN = Number(process.env.MAX_MESSAGES_TO_SCAN) || 10000;
const MAX_DISCORD_UPLOAD_BYTES = Number(process.env.MAX_DISCORD_UPLOAD_BYTES) || 8 * 1024 * 1024;
const PROGRESS_UPDATE_INTERVAL_MS = 2500;

function sanitize(name) {
  return String(name).replace(/[^a-z0-9_-]/gi, '_').slice(0, 64);
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

async function handleBackupComponent(interaction) {
  const [, action, sessionId] = interaction.customId.split(':');
  const session = getSession(sessionId);

  if (!session) {
    await interaction.update({
      content: '⏱️ This backup session has expired. Run `/backup` again to start a new one.',
      embeds: [],
      components: [],
    });
    return;
  }

  if (interaction.user.id !== session.requesterId) {
    await interaction.reply({
      content: 'Only the person who ran `/backup` can use these controls.',
      ephemeral: true,
    });
    return;
  }

  if (action === 'prev' || action === 'next') {
    session.page += action === 'prev' ? -1 : 1;
    await interaction.update(buildBackupUI(session));
    return;
  }

  if (action === 'cancel') {
    deleteSession(sessionId);
    await interaction.update({ content: '❌ Backup cancelled.', embeds: [], components: [] });
    return;
  }

  let authorId = null;
  let authorLabel = 'everyone';
  if (action === 'sel') {
    authorId = interaction.values[0];
    const author = session.authors.find((a) => a.id === authorId);
    authorLabel = author ? author.displayName : authorId;
  }

  await interaction.update({
    embeds: [
      new EmbedBuilder()
        .setTitle('📦 Starting backup...')
        .setColor(0x5865f2)
        .setDescription(`Preparing to back up images for **${authorLabel}**.`),
    ],
    components: [],
  });

  const channel = await interaction.client.channels.fetch(session.channelId).catch(() => null);
  if (!channel) {
    await interaction.editReply({
      content: 'I could not access that channel anymore (it may have been deleted or I lost access).',
      embeds: [],
    });
    deleteSession(sessionId);
    return;
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const zipFileName = `${sanitize(channel.name || channel.id)}_${sanitize(authorLabel)}_${timestamp}.zip`;
  const zipPath = path.join(process.cwd(), 'backups', sanitize(session.guildId || 'dm'), zipFileName);

  let lastUpdate = 0;
  let result;
  try {
    result = await backupChannelImages(channel, authorId, zipPath, {
      maxMessages: MAX_MESSAGES_TO_SCAN,
      onProgress: async ({ scanned, fileCount }) => {
        const now = Date.now();
        if (now - lastUpdate < PROGRESS_UPDATE_INTERVAL_MS) return;
        lastUpdate = now;
        await interaction.editReply({
          embeds: [
            new EmbedBuilder()
              .setTitle('📦 Backing up images...')
              .setColor(0x5865f2)
              .setDescription(`Scanned **${scanned}** messages, downloaded **${fileCount}** image(s) so far.`),
          ],
        }).catch(() => {});
      },
    });
  } catch (err) {
    console.error('Backup failed:', err);
    await interaction.editReply({
      content: `Something went wrong while building the backup: ${err.message}`,
      embeds: [],
    });
    deleteSession(sessionId);
    return;
  }

  deleteSession(sessionId);

  if (result.fileCount === 0) {
    await fs.promises.rm(zipPath, { force: true });
    await interaction.editReply({
      content: `No images found for **${authorLabel}** in <#${channel.id}>.`,
      embeds: [],
    });
    return;
  }

  const summary = new EmbedBuilder()
    .setTitle('✅ Backup complete')
    .setColor(0x57f287)
    .addFields(
      { name: 'User', value: authorLabel, inline: true },
      { name: 'Images', value: String(result.fileCount), inline: true },
      { name: 'Zip size', value: formatBytes(result.zipSizeBytes), inline: true },
      { name: 'Saved on host at', value: `\`${zipPath}\`` }
    );

  if (result.zipSizeBytes <= MAX_DISCORD_UPLOAD_BYTES) {
    const attachment = new AttachmentBuilder(zipPath, { name: zipFileName });
    await interaction.editReply({ embeds: [summary], files: [attachment] });
  } else {
    summary.addFields({
      name: 'Note',
      value: `The zip (${formatBytes(result.zipSizeBytes)}) is larger than the ${formatBytes(
        MAX_DISCORD_UPLOAD_BYTES
      )} upload limit, so it was kept on disk only.`,
    });
    await interaction.editReply({ embeds: [summary] });
  }
}

module.exports = { handleBackupComponent };
