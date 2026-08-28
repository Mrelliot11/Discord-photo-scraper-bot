'use strict';

const path = require('path');
const fs = require('fs');
const { EmbedBuilder, AttachmentBuilder } = require('discord.js');
const { getSession, deleteSession } = require('../lib/sessionStore');
const { buildBackupUI } = require('../lib/menuBuilder');
const { backupChannelImages, BackupLimitExceededError } = require('../lib/scraper');
const { auditGuildPermissions, auditChannelPermissions } = require('../lib/security');
const { tryAcquire, release } = require('../lib/concurrencyLock');
const { logAuditEvent } = require('../lib/auditLog');

const MAX_MESSAGES_TO_SCAN = Number(process.env.MAX_MESSAGES_TO_SCAN) || 10000;
const MAX_DISCORD_UPLOAD_BYTES = Number(process.env.MAX_DISCORD_UPLOAD_BYTES) || 8 * 1024 * 1024;
const PROGRESS_UPDATE_INTERVAL_MS = 2500;

const BACKUPS_ROOT = path.join(process.cwd(), 'backups');

function sanitize(name) {
  return String(name).replace(/[^a-z0-9_-]/gi, '_').slice(0, 64);
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Belt-and-braces check that the resolved zip path can never land outside backups/. */
function assertWithinBackupsRoot(candidatePath) {
  const resolved = path.resolve(candidatePath);
  const rootWithSep = path.resolve(BACKUPS_ROOT) + path.sep;
  if (!resolved.startsWith(rootWithSep)) {
    throw new Error(`Refusing to write backup outside of backups/: ${resolved}`);
  }
  return resolved;
}

function excessPermissionMessage(audit) {
  return (
    `🔒 **Aborting backup.** Permissions changed since this session started and this bot now has ` +
    `access beyond what a read-only photo backup needs (${audit.excess.join(', ')}) at the ${audit.scope} level.\n\n` +
    'A server admin needs to remove those permissions before backups can run again.'
  );
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

  // Permissions can change at any time after the session was created (up to
  // 15 minutes ago); re-check fresh, live permissions before touching a
  // single byte rather than trusting a stale state.
  const guild = interaction.guild;
  const guildAudit = await auditGuildPermissions(guild);
  const channel = await interaction.client.channels.fetch(session.channelId).catch(() => null);
  if (!channel) {
    deleteSession(sessionId);
    await interaction.update({
      content: 'I could not access that channel anymore (it may have been deleted or I lost access).',
      embeds: [],
      components: [],
    });
    return;
  }
  const channelAudit = auditChannelPermissions(channel, guild.members.me);
  const unsafeAudit = !guildAudit.safe ? guildAudit : !channelAudit.safe ? channelAudit : null;
  if (unsafeAudit) {
    console.warn(
      `[security] Aborting backup in guild ${session.guildId}: excess permissions detected (${unsafeAudit.scope}): ${unsafeAudit.excess.join(', ')}`
    );
    deleteSession(sessionId);
    await interaction.update({ content: excessPermissionMessage(unsafeAudit), embeds: [], components: [] });
    await logAuditEvent({
      action: 'backup_run',
      outcome: 'blocked_excess_permissions',
      guildId: session.guildId,
      channelId: session.channelId,
      requesterId: session.requesterId,
      target: authorLabel,
      excess: unsafeAudit.excess,
    });
    return;
  }

  if (!tryAcquire(session.guildId)) {
    await interaction.update({
      content: 'A backup is already running in this server. Please wait for it to finish and try again.',
      embeds: [],
      components: [],
    });
    return;
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

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const zipFileName = `${sanitize(channel.name || channel.id)}_${sanitize(authorLabel)}_${timestamp}.zip`;
  let zipPath;
  try {
    zipPath = assertWithinBackupsRoot(
      path.join(BACKUPS_ROOT, sanitize(session.guildId || 'dm'), zipFileName)
    );
  } catch (err) {
    console.error('Refusing unsafe backup path:', err);
    deleteSession(sessionId);
    release(session.guildId);
    await interaction.editReply({ content: 'Internal error building a safe backup path. Aborting.', embeds: [] });
    return;
  }

  let lastUpdate = 0;
  let result;
  try {
    result = await backupChannelImages(channel, authorId, zipPath, {
      maxMessages: MAX_MESSAGES_TO_SCAN,
      onProgress: async ({ scanned, fileCount, skipped }) => {
        const now = Date.now();
        if (now - lastUpdate < PROGRESS_UPDATE_INTERVAL_MS) return;
        lastUpdate = now;
        await interaction.editReply({
          embeds: [
            new EmbedBuilder()
              .setTitle('📦 Backing up images...')
              .setColor(0x5865f2)
              .setDescription(
                `Scanned **${scanned}** messages, downloaded **${fileCount}** image(s) so far` +
                  (skipped ? ` (${skipped} skipped as unsafe/oversized).` : '.')
              ),
          ],
        }).catch(() => {});
      },
    });
  } catch (err) {
    const isLimitError = err instanceof BackupLimitExceededError;
    console.error('Backup failed:', err);
    await interaction.editReply({
      content: isLimitError
        ? `⚠️ ${err.message} The partial zip was discarded; narrow the scope (pick a single user, or lower MAX_MESSAGES_TO_SCAN) and try again.`
        : `Something went wrong while building the backup: ${err.message}`,
      embeds: [],
    });
    deleteSession(sessionId);
    await logAuditEvent({
      action: 'backup_run',
      outcome: isLimitError ? 'blocked_size_limit' : 'error',
      guildId: session.guildId,
      channelId: session.channelId,
      requesterId: session.requesterId,
      target: authorLabel,
      error: err.message,
    });
    release(session.guildId);
    return;
  }

  deleteSession(sessionId);
  release(session.guildId);

  if (result.fileCount === 0) {
    await fs.promises.rm(zipPath, { force: true });
    await interaction.editReply({
      content: `No images found for **${authorLabel}** in <#${channel.id}>.`,
      embeds: [],
    });
    await logAuditEvent({
      action: 'backup_run',
      outcome: 'empty',
      guildId: session.guildId,
      channelId: session.channelId,
      requesterId: session.requesterId,
      target: authorLabel,
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
  if (result.skipped) {
    summary.addFields({
      name: 'Skipped',
      value: `${result.skipped} attachment(s) skipped (not from Discord's CDN, or over the per-file size limit).`,
    });
  }

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

  await logAuditEvent({
    action: 'backup_run',
    outcome: 'success',
    guildId: session.guildId,
    channelId: session.channelId,
    requesterId: session.requesterId,
    target: authorLabel,
    fileCount: result.fileCount,
    zipSizeBytes: result.zipSizeBytes,
    skipped: result.skipped,
    zipPath,
  });
}

module.exports = { handleBackupComponent };
