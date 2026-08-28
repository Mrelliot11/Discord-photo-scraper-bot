'use strict';

const {
  EmbedBuilder,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require('discord.js');

const PAGE_SIZE = 25;

function totalPages(session) {
  return Math.max(1, Math.ceil(session.authors.length / PAGE_SIZE));
}

/**
 * Builds the embed + components for the current page of a backup session's
 * user picker.
 */
function buildBackupUI(session) {
  const pages = totalPages(session);
  const page = Math.min(Math.max(session.page, 0), pages - 1);
  session.page = page;

  const start = page * PAGE_SIZE;
  const pageAuthors = session.authors.slice(start, start + PAGE_SIZE);
  const totalImages = session.authors.reduce((sum, a) => sum + a.count, 0);

  const embed = new EmbedBuilder()
    .setTitle('📸 Choose someone to back up')
    .setColor(0x5865f2)
    .setDescription(
      `Found **${totalImages}** image(s) from **${session.authors.length}** user(s) in <#${session.channelId}>.\n` +
        'Pick a user from the dropdown below to back up just their photos, or use **Back Up Everyone**.'
    )
    .setFooter({ text: `Page ${page + 1} of ${pages}` });

  for (const author of pageAuthors) {
    embed.addFields({
      name: author.displayName,
      value: `${author.count} image${author.count === 1 ? '' : 's'}`,
      inline: true,
    });
  }

  const select = new StringSelectMenuBuilder()
    .setCustomId(`bkp:sel:${session.id}`)
    .setPlaceholder('Select a user to back up...')
    .addOptions(
      pageAuthors.map((author) => ({
        label: author.displayName.slice(0, 100),
        description: `${author.count} image${author.count === 1 ? '' : 's'}`,
        value: author.id,
      }))
    );

  const selectRow = new ActionRowBuilder().addComponents(select);

  const buttonRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`bkp:prev:${session.id}`)
      .setLabel('◀ Prev')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page === 0),
    new ButtonBuilder()
      .setCustomId(`bkp:next:${session.id}`)
      .setLabel('Next ▶')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page >= pages - 1),
    new ButtonBuilder()
      .setCustomId(`bkp:all:${session.id}`)
      .setLabel('Back Up Everyone')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`bkp:cancel:${session.id}`)
      .setLabel('Cancel')
      .setStyle(ButtonStyle.Danger)
  );

  return { embeds: [embed], components: [selectRow, buttonRow] };
}

module.exports = { buildBackupUI, PAGE_SIZE };
