'use strict';

const path = require('path');
const fs = require('fs');
const { EmbedBuilder, AttachmentBuilder, MessageFlags } = require('discord.js');
const { getSession, deleteSession } = require('../lib/sessionStore');
const { buildBackupUI } = require('../lib/menuBuilder');
const { backupChannelImages, BackupLimitExceededError } = require('../lib/scraper');
const { auditBotPermissions } = require('../lib/security');
const { tryAcquire, release } = require('../lib/concurrencyLock');
const { logAuditEvent } = require('../lib/auditLog');
const { createProgressReporter } = require('../lib/progress');

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
      flags: MessageFlags.Ephemeral,
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

  if (action !== 'sel' && action !== 'all') return;

  let authorId = null;
  let authorLabel = 'everyone';
  if (action === 'sel') {
    authorId = interaction.values[0];
    const author = session.authors.find((a) => a.id === authorId);
    if (!author) {
      await interaction.update({ content: 'That user is not in this backup session.', embeds: [], components: [] });
      return;
    }
    authorLabel = author.displayName;
  }

  // Acknowledge before doing any REST calls: Discord only gives us 3s.
  await interaction.deferUpdate();
  await interaction.editReply({
    embeds: [
      new EmbedBuilder()
        .setTitle('📦 Starting backup...')
        .setColor(0x5865f2)
        .setDescription(`Checking permissions before backing up images for **${authorLabel}**.`),
    ],
    components: [],
  });

  const channel = await interaction.client.channels.fetch(session.channelId).catch(() => null);
  if (!channel || typeof channel.isTextBased !== 'function' || !channel.isTextBased()) {
    deleteSession(sessionId);
    await interaction.editReply({
      content: 'I could not access that channel anymore (it may have been deleted or I lost access).',
      embeds: [],
    });
    return;
  }

  // Permissions can change at any time after the session was created (up to
  // 15 minutes ago); re-check fresh, live permissions before touching a
  // single byte rather than trusting a stale state.
  const unsafeAudit = await auditBotPermissions(interaction.guild, channel);
  if (unsafeAudit) {
    console.warn(
      `[security] Aborting backup in guild ${session.guildId}: excess permissions detected (${unsafeAudit.scope}): ${unsafeAudit.excess.join(', ')}`
    );
    deleteSession(sessionId);
    await interaction.editReply({ content: excessPermissionMessage(unsafeAudit), embeds: [] });
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
    await interaction.editReply({
      content: 'A backup is already running in this server. Please wait for it to finish and try again.',
      embeds: [],
    });
    return;
  }

  // From here on the lock is held: every exit path must go through `finally`.
  const baseAuditFields = {
    action: 'backup_run',
    guildId: session.guildId,
    channelId: session.channelId,
    requesterId: session.requesterId,
    target: authorLabel,
  };

  try {
    deleteSession(sessionId);

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const zipFileName = `${sanitize(channel.name || channel.id)}_${sanitize(authorLabel)}_${timestamp}.zip`;
    const zipPath = assertWithinBackupsRoot(
      path.join(BACKUPS_ROOT, sanitize(session.guildId || 'dm'), zipFileName)
    );

    const progress = createProgressReporter(
      interaction,
      PROGRESS_UPDATE_INTERVAL_MS,
      ({ scanned, fileCount, skipped }) => ({
        embeds: [
          new EmbedBuilder()
            .setTitle('📦 Backing up images...')
            .setColor(0x5865f2)
            .setDescription(
              `Scanned **${scanned}** messages, downloaded **${fileCount}** image(s) so far` +
                (skipped ? ` (${skipped} skipped as unsafe/oversized).` : '.')
            ),
        ],
      })
    );

    let result;
    try {
      result = await backupChannelImages(channel, authorId, zipPath, {
        maxMessages: MAX_MESSAGES_TO_SCAN,
        onProgress: progress.report,
      });
    } catch (err) {
      await progress.flush();
      const isLimitError = err instanceof BackupLimitExceededError;
      console.error('Backup failed:', err);
      await logAuditEvent({
        ...baseAuditFields,
        outcome: isLimitError ? 'blocked_size_limit' : 'error',
        error: err.message,
      });
      await interaction.editReply({
        content: isLimitError
          ? `⚠️ ${err.message} The partial zip was discarded; narrow the scope (pick a single user, or lower MAX_MESSAGES_TO_SCAN) and try again.`
          : `Something went wrong while building the backup: ${err.message}`,
        embeds: [],
      });
      return;
    }
    await progress.flush();

    if (result.fileCount === 0) {
      await fs.promises.rm(zipPath, { force: true });
      await logAuditEvent({ ...baseAuditFields, outcome: 'empty' });
      await interaction.editReply({
        content: `No images found for **${authorLabel}** in <#${channel.id}>.`,
        embeds: [],
      });
      return;
    }

    await logAuditEvent({
      ...baseAuditFields,
      outcome: 'success',
      fileCount: result.fileCount,
      zipSizeBytes: result.zipSizeBytes,
      skipped: result.skipped,
      zipPath,
    });

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
        value: `${result.skipped} attachment(s) skipped (not from Discord's CDN, over the per-file size limit, or failed to download).`,
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
  } finally {
    release(session.guildId);
  }
}

module.exports = { handleBackupComponent };
