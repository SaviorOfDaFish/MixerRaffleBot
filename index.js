require('dotenv').config();

const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');
const { DateTime } = require('luxon');
const {
  Client,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  MessageFlags
} = require('discord.js');

const REQUIRED_VARIABLES = [
  'DISCORD_TOKEN',
  'CLIENT_ID',
  'GUILD_ID',
  'OWNER_ID',
  'GUESS_CHANNEL_ID',
  'ADMIN_CHANNEL_ID'
];

const missingVariables = REQUIRED_VARIABLES.filter(
  (name) => !process.env[name]
);

if (missingVariables.length > 0) {
  console.error(
    `Missing required environment variables: ${missingVariables.join(', ')}`
  );
  process.exit(1);
}

const MOUNTAIN_TIME_ZONE = 'America/Denver';
const GUESS_COOLDOWN_MINUTES = 10;

const databasePath =
  process.env.DATABASE_PATH || './data/raffle.db';

const startingTicketNumber = Number.parseInt(
  process.env.STARTING_TICKET_NUMBER || '158114',
  10
);

if (!Number.isSafeInteger(startingTicketNumber)) {
  console.error('STARTING_TICKET_NUMBER must be a valid whole number.');
  process.exit(1);
}

fs.mkdirSync(path.dirname(databasePath), {
  recursive: true
});

const db = new Database(databasePath);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS raffles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    card_name TEXT NOT NULL,
    accepted_answers_json TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open',
    started_at TEXT NOT NULL,
    started_by_id TEXT NOT NULL,
    closed_at TEXT
  );

  CREATE TABLE IF NOT EXISTS guesses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    raffle_id INTEGER,
    card_number INTEGER NOT NULL DEFAULT 1,
    discord_user_id TEXT NOT NULL,
    discord_username TEXT NOT NULL,
    raw_guess TEXT NOT NULL,
    normalized_guess TEXT NOT NULL,
    is_correct INTEGER NOT NULL DEFAULT 0,
    submitted_at TEXT NOT NULL,
    FOREIGN KEY (raffle_id) REFERENCES raffles(id)
  );

  CREATE TABLE IF NOT EXISTS raffle_winners (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    raffle_id INTEGER NOT NULL,
    discord_user_id TEXT NOT NULL,
    discord_username TEXT NOT NULL,
    placement INTEGER NOT NULL,
    tickets_awarded INTEGER NOT NULL,
    won_at TEXT NOT NULL,
    UNIQUE (raffle_id, discord_user_id),
    UNIQUE (raffle_id, placement),
    FOREIGN KEY (raffle_id) REFERENCES raffles(id)
  );

  CREATE TABLE IF NOT EXISTS bonus_cards (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    raffle_id INTEGER NOT NULL,
    card_number INTEGER NOT NULL,
    card_name TEXT NOT NULL,
    accepted_answers_json TEXT NOT NULL,
    added_at TEXT NOT NULL,
    added_by_id TEXT NOT NULL,
    UNIQUE (raffle_id, card_number),
    FOREIGN KEY (raffle_id) REFERENCES raffles(id)
  );

  CREATE TABLE IF NOT EXISTS bonus_winners (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    raffle_id INTEGER NOT NULL,
    bonus_card_id INTEGER NOT NULL,
    discord_user_id TEXT NOT NULL,
    discord_username TEXT NOT NULL,
    placement INTEGER NOT NULL,
    tickets_awarded INTEGER NOT NULL,
    won_at TEXT NOT NULL,
    UNIQUE (bonus_card_id, discord_user_id),
    UNIQUE (bonus_card_id, placement),
    FOREIGN KEY (raffle_id) REFERENCES raffles(id),
    FOREIGN KEY (bonus_card_id) REFERENCES bonus_cards(id)
  );

  CREATE TABLE IF NOT EXISTS tickets (
    ticket_number INTEGER PRIMARY KEY,
    raffle_id INTEGER NOT NULL,
    discord_user_id TEXT NOT NULL,
    discord_username TEXT NOT NULL,
    awarded_at TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    FOREIGN KEY (raffle_id) REFERENCES raffles(id)
  );
`);

/* Safe migrations for databases created by earlier versions. */
const guessColumns = db
  .prepare('PRAGMA table_info(guesses)')
  .all()
  .map((column) => column.name);

if (!guessColumns.includes('raffle_id')) {
  db.exec(`
    ALTER TABLE guesses
    ADD COLUMN raffle_id INTEGER
  `);
}

if (!guessColumns.includes('is_correct')) {
  db.exec(`
    ALTER TABLE guesses
    ADD COLUMN is_correct INTEGER NOT NULL DEFAULT 0
  `);
}

if (!guessColumns.includes('card_number')) {
  db.exec(`
    ALTER TABLE guesses
    ADD COLUMN card_number INTEGER NOT NULL DEFAULT 1
  `);
}

db.exec(`
  CREATE INDEX IF NOT EXISTS idx_guesses_raffle_user_card
    ON guesses (raffle_id, discord_user_id, card_number, submitted_at);

  CREATE INDEX IF NOT EXISTS idx_tickets_user
    ON tickets (discord_user_id, ticket_number);

  CREATE INDEX IF NOT EXISTS idx_bonus_cards_raffle
    ON bonus_cards (raffle_id, card_number);

  CREATE INDEX IF NOT EXISTS idx_bonus_winners_card
    ON bonus_winners (bonus_card_id, placement);
`);

const insertSetting = db.prepare(`
  INSERT OR IGNORE INTO settings (key, value)
  VALUES (?, ?)
`);

insertSetting.run(
  'next_ticket_number',
  String(startingTicketNumber)
);

function normalizeCardName(value) {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isOwner(interaction) {
  return interaction.user.id === process.env.OWNER_ID;
}

function getActiveRaffle() {
  return db
    .prepare(`
      SELECT *
      FROM raffles
      WHERE status = 'open'
      ORDER BY id DESC
      LIMIT 1
    `)
    .get();
}

function getRaffleById(raffleId) {
  return db
    .prepare(`
      SELECT *
      FROM raffles
      WHERE id = ?
    `)
    .get(raffleId);
}

function getBonusCards(raffleId) {
  return db
    .prepare(`
      SELECT *
      FROM bonus_cards
      WHERE raffle_id = ?
      ORDER BY card_number
    `)
    .all(raffleId);
}

function getCardForRaffle(raffle, cardNumber) {
  if (cardNumber === 1) {
    return {
      id: null,
      raffle_id: raffle.id,
      card_number: 1,
      card_name: raffle.card_name,
      accepted_answers_json: raffle.accepted_answers_json,
      is_main_card: true
    };
  }

  const bonusCard = db
    .prepare(`
      SELECT *
      FROM bonus_cards
      WHERE raffle_id = ?
        AND card_number = ?
    `)
    .get(raffle.id, cardNumber);

  if (!bonusCard) {
    return null;
  }

  return {
    ...bonusCard,
    is_main_card: false
  };
}

function parseAcceptedAnswers(cardName, aliasesText) {
  const rawAnswers = [cardName];

  if (aliasesText) {
    rawAnswers.push(...aliasesText.split(','));
  }

  return [
    ...new Set(
      rawAnswers
        .map((answer) => normalizeCardName(answer))
        .filter(Boolean)
    )
  ];
}

function getNextTicketNumber() {
  const setting = db
    .prepare(`
      SELECT value
      FROM settings
      WHERE key = 'next_ticket_number'
    `)
    .get();

  const ticketNumber = Number.parseInt(setting.value, 10);

  if (!Number.isSafeInteger(ticketNumber)) {
    throw new Error('The saved next ticket number is invalid.');
  }

  return ticketNumber;
}

function getScheduledCloseTime(raffle) {
  const startTime = DateTime
    .fromISO(raffle.started_at, { zone: 'utc' })
    .setZone(MOUNTAIN_TIME_ZONE);

  let daysUntilThursday =
    (4 - startTime.weekday + 7) % 7;

  const startedAfterThursdayClose =
    startTime.weekday === 4 &&
    (
      startTime.hour > 22 ||
      (
        startTime.hour === 22 &&
        (
          startTime.minute > 0 ||
          startTime.second > 0
        )
      )
    );

  if (startedAfterThursdayClose) {
    daysUntilThursday = 7;
  }

  return startTime
    .plus({ days: daysUntilThursday })
    .set({
      hour: 22,
      minute: 0,
      second: 0,
      millisecond: 0
    });
}

function getMainCardWinners(raffleId) {
  return db
    .prepare(`
      SELECT *
      FROM raffle_winners
      WHERE raffle_id = ?
      ORDER BY placement
    `)
    .all(raffleId);
}

function getBonusCardWinners(bonusCardId) {
  return db
    .prepare(`
      SELECT *
      FROM bonus_winners
      WHERE bonus_card_id = ?
      ORDER BY placement
    `)
    .all(bonusCardId);
}

function getWinnerTickets(raffleId, discordUserId, wonAt) {
  return db
    .prepare(`
      SELECT ticket_number
      FROM tickets
      WHERE raffle_id = ?
        AND discord_user_id = ?
        AND awarded_at = ?
      ORDER BY ticket_number
    `)
    .all(raffleId, discordUserId, wonAt)
    .map((row) => row.ticket_number);
}

function allocateTickets({
  raffleId,
  user,
  ticketCount,
  now
}) {
  const nextTicket = getNextTicketNumber();

  const insertTicket = db.prepare(`
    INSERT INTO tickets (
      ticket_number,
      raffle_id,
      discord_user_id,
      discord_username,
      awarded_at
    )
    VALUES (?, ?, ?, ?, ?)
  `);

  const ticketNumbers = [];

  for (let offset = 0; offset < ticketCount; offset += 1) {
    const ticketNumber = nextTicket + offset;

    insertTicket.run(
      ticketNumber,
      raffleId,
      user.id,
      user.username,
      now
    );

    ticketNumbers.push(ticketNumber);
  }

  db.prepare(`
    UPDATE settings
    SET value = ?
    WHERE key = 'next_ticket_number'
  `).run(String(nextTicket + ticketCount));

  return ticketNumbers;
}

const awardMainCardGuess = db.transaction(
  (raffle, user, now) => {
    const existingWinner = db
      .prepare(`
        SELECT *
        FROM raffle_winners
        WHERE raffle_id = ?
          AND discord_user_id = ?
      `)
      .get(raffle.id, user.id);

    if (existingWinner) {
      return {
        type: 'already_won',
        placement: existingWinner.placement,
        tickets: getWinnerTickets(
          raffle.id,
          user.id,
          existingWinner.won_at
        )
      };
    }

    const winnerCount = db
      .prepare(`
        SELECT COUNT(*) AS count
        FROM raffle_winners
        WHERE raffle_id = ?
      `)
      .get(raffle.id).count;

    if (winnerCount >= 5) {
      return { type: 'correct_no_tickets' };
    }

    const placement = winnerCount + 1;
    const ticketCount = placement === 1 ? 2 : 1;

    db.prepare(`
      INSERT INTO raffle_winners (
        raffle_id,
        discord_user_id,
        discord_username,
        placement,
        tickets_awarded,
        won_at
      )
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      raffle.id,
      user.id,
      user.username,
      placement,
      ticketCount,
      now
    );

    return {
      type: 'winner',
      placement,
      tickets: allocateTickets({
        raffleId: raffle.id,
        user,
        ticketCount,
        now
      })
    };
  }
);

const awardBonusCardGuess = db.transaction(
  (raffle, bonusCard, user, now) => {
    const existingWinner = db
      .prepare(`
        SELECT *
        FROM bonus_winners
        WHERE bonus_card_id = ?
          AND discord_user_id = ?
      `)
      .get(bonusCard.id, user.id);

    if (existingWinner) {
      return {
        type: 'already_won',
        placement: existingWinner.placement,
        tickets: getWinnerTickets(
          raffle.id,
          user.id,
          existingWinner.won_at
        )
      };
    }

    const winnerCount = db
      .prepare(`
        SELECT COUNT(*) AS count
        FROM bonus_winners
        WHERE bonus_card_id = ?
      `)
      .get(bonusCard.id).count;

    if (winnerCount >= 5) {
      return { type: 'correct_no_tickets' };
    }

    const placement = winnerCount + 1;
    const ticketCount = placement === 1 ? 2 : 1;

    db.prepare(`
      INSERT INTO bonus_winners (
        raffle_id,
        bonus_card_id,
        discord_user_id,
        discord_username,
        placement,
        tickets_awarded,
        won_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      raffle.id,
      bonusCard.id,
      user.id,
      user.username,
      placement,
      ticketCount,
      now
    );

    return {
      type: 'winner',
      placement,
      tickets: allocateTickets({
        raffleId: raffle.id,
        user,
        ticketCount,
        now
      })
    };
  }
);

const resetActiveRaffleTransaction = db.transaction(
  (raffleId) => {
    const raffle = db
      .prepare(`
        SELECT *
        FROM raffles
        WHERE id = ?
          AND status = 'open'
      `)
      .get(raffleId);

    if (!raffle) {
      return { reset: false, reason: 'not_found' };
    }

    const ticketInfo = db
      .prepare(`
        SELECT
          MIN(ticket_number) AS first_ticket,
          COUNT(*) AS ticket_count
        FROM tickets
        WHERE raffle_id = ?
      `)
      .get(raffleId);

    const guessesDeleted = db
      .prepare(`
        SELECT COUNT(*) AS count
        FROM guesses
        WHERE raffle_id = ?
      `)
      .get(raffleId).count;

    const mainWinnersDeleted = db
      .prepare(`
        SELECT COUNT(*) AS count
        FROM raffle_winners
        WHERE raffle_id = ?
      `)
      .get(raffleId).count;

    const bonusWinnersDeleted = db
      .prepare(`
        SELECT COUNT(*) AS count
        FROM bonus_winners
        WHERE raffle_id = ?
      `)
      .get(raffleId).count;

    const bonusCardsDeleted = db
      .prepare(`
        SELECT COUNT(*) AS count
        FROM bonus_cards
        WHERE raffle_id = ?
      `)
      .get(raffleId).count;

    db.prepare('DELETE FROM tickets WHERE raffle_id = ?').run(raffleId);
    db.prepare('DELETE FROM bonus_winners WHERE raffle_id = ?').run(raffleId);
    db.prepare('DELETE FROM bonus_cards WHERE raffle_id = ?').run(raffleId);
    db.prepare('DELETE FROM raffle_winners WHERE raffle_id = ?').run(raffleId);
    db.prepare('DELETE FROM guesses WHERE raffle_id = ?').run(raffleId);
    db.prepare('DELETE FROM raffles WHERE id = ?').run(raffleId);

    if (ticketInfo.first_ticket !== null) {
      db.prepare(`
        UPDATE settings
        SET value = ?
        WHERE key = 'next_ticket_number'
      `).run(String(ticketInfo.first_ticket));
    }

    return {
      reset: true,
      raffleId,
      cardName: raffle.card_name,
      guessesDeleted,
      winnersDeleted: mainWinnersDeleted + bonusWinnersDeleted,
      bonusCardsDeleted,
      ticketsDeleted: ticketInfo.ticket_count,
      restoredTicketNumber:
        ticketInfo.first_ticket !== null
          ? ticketInfo.first_ticket
          : getNextTicketNumber()
    };
  }
);

const closeRaffleTransaction = db.transaction(
  (raffleId, closedAt) => {
    const raffle = getRaffleById(raffleId);

    if (!raffle) {
      return { closed: false, reason: 'not_found' };
    }

    if (raffle.status !== 'open') {
      return { closed: false, reason: 'already_closed' };
    }

    db.prepare(`
      UPDATE raffles
      SET status = 'closed',
          closed_at = ?
      WHERE id = ?
        AND status = 'open'
    `).run(closedAt, raffleId);

    return { closed: true };
  }
);

const client = new Client({
  intents: [GatewayIntentBits.Guilds]
});

async function sendGuessToAdmin({
  raffle,
  cardNumber,
  user,
  rawGuess,
  resultText,
  placement = null,
  tickets = []
}) {
  try {
    const adminChannel = await client.channels.fetch(
      process.env.ADMIN_CHANNEL_ID
    );

    if (!adminChannel || !adminChannel.isTextBased()) {
      console.error('ADMIN_CHANNEL_ID does not point to a text channel.');
      return;
    }

    const totalGuesses = db
      .prepare(`
        SELECT COUNT(*) AS count
        FROM guesses
        WHERE raffle_id = ?
          AND card_number = ?
      `)
      .get(raffle.id, cardNumber).count;

    const lines = [
      '## 🎟️ New Raffle Guess',
      `**Card:** #${cardNumber}`,
      `**Player:** <@${user.id}>`,
      `**Username:** ${user.username}`,
      `**Guess:** ${rawGuess}`,
      `**Result:** ${resultText}`
    ];

    if (placement !== null) {
      lines.push(`**Winning position:** #${placement}`);
    }

    if (tickets.length > 0) {
      lines.push(
        `**Tickets:** ${tickets
          .map((ticket) => `🎟️ ${ticket}`)
          .join(', ')}`
      );
    }

    lines.push(`**Total guesses for Card #${cardNumber}:** ${totalGuesses}`);

    await adminChannel.send({
      content: lines.join('\n'),
      allowedMentions: { users: [user.id] }
    });
  } catch (error) {
    console.error('Could not send guess to admin channel:', error);
  }
}

function getCooldownRemaining(raffleId, cardNumber, userId) {
  const lastGuess = db
    .prepare(`
      SELECT submitted_at
      FROM guesses
      WHERE raffle_id = ?
        AND card_number = ?
        AND discord_user_id = ?
      ORDER BY id DESC
      LIMIT 1
    `)
    .get(raffleId, cardNumber, userId);

  if (!lastGuess) {
    return 0;
  }

  const elapsedMilliseconds =
    Date.now() - new Date(lastGuess.submitted_at).getTime();

  const cooldownMilliseconds =
    GUESS_COOLDOWN_MINUTES * 60 * 1000;

  return Math.max(0, cooldownMilliseconds - elapsedMilliseconds);
}

function formatCooldown(milliseconds) {
  const totalSeconds = Math.ceil(milliseconds / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  if (minutes === 0) {
    return `${seconds} second${seconds === 1 ? '' : 's'}`;
  }

  return `${minutes} minute${minutes === 1 ? '' : 's'} ${seconds} second${
    seconds === 1 ? '' : 's'
  }`;
}

function buildOwnerSummary(raffle) {
  const closeDate = DateTime
    .fromISO(raffle.closed_at, { zone: 'utc' })
    .setZone(MOUNTAIN_TIME_ZONE)
    .toFormat('cccc, LLLL d, yyyy');

  const cards = [
    {
      id: null,
      card_number: 1,
      card_name: raffle.card_name,
      winners: getMainCardWinners(raffle.id)
    },
    ...getBonusCards(raffle.id).map((card) => ({
      ...card,
      winners: getBonusCardWinners(card.id)
    }))
  ];

  const lines = [
    '## 🎟️ Weekly Blurred Raffle Summary',
    '',
    `**Raffle:** #${raffle.id}`,
    `**Closed:** ${closeDate}`,
    ''
  ];

  let totalTickets = 0;

  for (const card of cards) {
    lines.push(`### Card #${card.card_number}: ${card.card_name}`);

    if (card.winners.length === 0) {
      lines.push('No ticket winners.', '');
      continue;
    }

    for (const winner of card.winners) {
      const ticketNumbers = getWinnerTickets(
        raffle.id,
        winner.discord_user_id,
        winner.won_at
      );

      totalTickets += ticketNumbers.length;

      lines.push(
        `**#${winner.placement} ${winner.discord_username}** — ${ticketNumbers
          .map((ticket) => `🎟️ ${ticket}`)
          .join(', ')}`
      );
    }

    lines.push('');
  }

  lines.push(
    `**Total tickets awarded:** ${totalTickets}`,
    `**Next available ticket:** ${getNextTicketNumber()}`
  );

  return lines.join('\n');
}

let raffleClosingCheckRunning = false;

async function sendRaffleClosingMessages(raffle) {
  const summary = buildOwnerSummary(raffle);

  try {
    const owner = await client.users.fetch(process.env.OWNER_ID);
    await owner.send({ content: summary });
  } catch (error) {
    console.error('Could not DM the raffle owner:', error);
  }

  try {
    const adminChannel = await client.channels.fetch(
      process.env.ADMIN_CHANNEL_ID
    );

    if (adminChannel && adminChannel.isTextBased()) {
      await adminChannel.send({
        content: summary,
        allowedMentions: { parse: [] }
      });
    }
  } catch (error) {
    console.error('Could not send raffle summary to admin channel:', error);
  }

  try {
    const guessChannel = await client.channels.fetch(
      process.env.GUESS_CHANNEL_ID
    );

    if (guessChannel && guessChannel.isTextBased()) {
      const closingEmbed = new EmbedBuilder()
        .setTitle('⏰ Guessing Is Now Closed!')
        .setDescription(
          'This week’s Blurred MTG Raffle is now closed.\n\n' +
          'The mystery cards, ticket winners, and raffle winner will be announced Friday!'
        )
        .setFooter({ text: `Raffle #${raffle.id}` })
        .setTimestamp();

      await guessChannel.send({ embeds: [closingEmbed] });
    }
  } catch (error) {
    console.error('Could not post closing announcement:', error);
  }
}

async function closeRaffle(raffleId, reason = 'automatic') {
  const result = closeRaffleTransaction(
    raffleId,
    new Date().toISOString()
  );

  if (!result.closed) {
    return false;
  }

  const closedRaffle = getRaffleById(raffleId);
  console.log(`Closed raffle #${raffleId}. Reason: ${reason}`);
  await sendRaffleClosingMessages(closedRaffle);
  return true;
}

async function checkForScheduledRaffleClose() {
  if (raffleClosingCheckRunning) {
    return;
  }

  raffleClosingCheckRunning = true;

  try {
    const raffle = getActiveRaffle();

    if (!raffle) {
      return;
    }

    const currentTime = DateTime.now().setZone(MOUNTAIN_TIME_ZONE);

    if (currentTime >= getScheduledCloseTime(raffle)) {
      await closeRaffle(
        raffle.id,
        'Thursday 10:00 PM Mountain Time'
      );
    }
  } catch (error) {
    console.error('Automatic raffle closing check failed:', error);
  } finally {
    raffleClosingCheckRunning = false;
  }
}

client.once(Events.ClientReady, async (readyClient) => {
  console.log(`Logged in as ${readyClient.user.tag}`);
  console.log(`SQLite database: ${databasePath}`);
  console.log(`Next physical ticket: ${getNextTicketNumber()}`);
  console.log(`Guess cooldown: ${GUESS_COOLDOWN_MINUTES} minutes per card`);
  console.log('Automatic raffle closing: Thursday at 10:00 PM Mountain Time');

  await checkForScheduledRaffleClose();
  setInterval(checkForScheduledRaffleClose, 60 * 1000);
});

client.on(Events.InteractionCreate, async (interaction) => {
  /*
   * Dynamically fills the Card Number field for /guess.
   * Only cards currently attached to the active raffle are shown.
   */
  if (interaction.isAutocomplete()) {
    try {
      if (interaction.commandName !== 'guess') {
        await interaction.respond([]);
        return;
      }

      const focusedOption = interaction.options.getFocused(true);

      if (focusedOption.name !== 'card_number') {
        await interaction.respond([]);
        return;
      }

      const raffle = getActiveRaffle();

      if (!raffle) {
        await interaction.respond([]);
        return;
      }

      const availableCardNumbers = [
        1,
        ...getBonusCards(raffle.id).map((card) => card.card_number)
      ];

      const typedValue = String(focusedOption.value || '')
        .replace(/[^0-9]/g, '');

      const matchingCards = availableCardNumbers
        .filter((cardNumber) =>
          typedValue === '' || String(cardNumber).includes(typedValue)
        )
        .slice(0, 25)
        .map((cardNumber) => ({
          name: `Card #${cardNumber}`,
          value: cardNumber
        }));

      await interaction.respond(matchingCards);
    } catch (error) {
      console.error('Autocomplete error:', error);

      if (!interaction.responded) {
        await interaction.respond([]).catch(() => {});
      }
    }

    return;
  }

  if (!interaction.isChatInputCommand()) {
    return;
  }

  try {
    if (interaction.commandName === 'raffleping') {
      await interaction.reply({
        content:
          `🎟️ The raffle bot is online.\n` +
          `Database: \`${databasePath}\`\n` +
          `Guess cooldown: ${GUESS_COOLDOWN_MINUTES} minutes per card.\n` +
          'Automatic closing: Thursday at 10:00 PM Mountain Time.',
        flags: MessageFlags.Ephemeral
      });
      return;
    }

    if (interaction.commandName === 'startraffle') {
      if (!isOwner(interaction)) {
        await interaction.reply({
          content: 'Only the raffle owner can start a challenge.',
          flags: MessageFlags.Ephemeral
        });
        return;
      }

      const currentRaffle = getActiveRaffle();

      if (currentRaffle) {
        await interaction.reply({
          content:
            `A raffle is already open: **${currentRaffle.card_name}**.\n` +
            'Use `/addcard` to add a Wednesday bonus card.',
          flags: MessageFlags.Ephemeral
        });
        return;
      }

      const cardName = interaction.options
        .getString('card', true)
        .trim();

      const aliasesText =
        interaction.options.getString('aliases')?.trim() || '';

      const acceptedAnswers = parseAcceptedAnswers(cardName, aliasesText);

      if (!normalizeCardName(cardName)) {
        await interaction.reply({
          content: 'Please enter a valid full card name.',
          flags: MessageFlags.Ephemeral
        });
        return;
      }

      const now = new Date().toISOString();

      const result = db.prepare(`
        INSERT INTO raffles (
          card_name,
          accepted_answers_json,
          status,
          started_at,
          started_by_id
        )
        VALUES (?, ?, 'open', ?, ?)
      `).run(
        cardName,
        JSON.stringify(acceptedAnswers),
        now,
        interaction.user.id
      );

      const newRaffle = getRaffleById(result.lastInsertRowid);
      const scheduledClose = getScheduledCloseTime(newRaffle);

      const announcement = new EmbedBuilder()
        .setTitle('🎟️ A New Blurred MTG Raffle Has Begun!')
        .setDescription(
          'Think you know **Card #1**? Submit your answer privately with `/guess`.\n\n' +
          '**Ticket rewards for each card**\n' +
          '🥇 First correct answer: **2 tickets**\n' +
          '🎟️ Next four correct answers: **1 ticket each**\n\n' +
          `There is a **${GUESS_COOLDOWN_MINUTES}-minute cooldown** between guesses on the same card.\n\n` +
          `**Guessing closes:** ${scheduledClose.toFormat(
            "cccc 'at' h:mm a ZZZZ"
          )}`
        )
        .setFooter({ text: `Raffle #${result.lastInsertRowid}` })
        .setTimestamp();

      const guessChannel = await client.channels.fetch(
        process.env.GUESS_CHANNEL_ID
      );

      if (!guessChannel || !guessChannel.isTextBased()) {
        throw new Error('GUESS_CHANNEL_ID does not point to a text channel.');
      }

      const roleMention = process.env.RAFFLE_ROLE_ID
        ? `<@&${process.env.RAFFLE_ROLE_ID}>\n`
        : '';

      await guessChannel.send({
        content: roleMention || undefined,
        embeds: [announcement],
        allowedMentions: process.env.RAFFLE_ROLE_ID
          ? { roles: [process.env.RAFFLE_ROLE_ID] }
          : { parse: [] }
      });

      await interaction.reply({
        content:
          `✅ Raffle #${result.lastInsertRowid} is now open.\n` +
          `**Card #1 answer:** ${cardName}\n` +
          `**Closes:** ${scheduledClose.toFormat(
            "cccc, LLLL d 'at' h:mm a ZZZZ"
          )}`,
        flags: MessageFlags.Ephemeral
      });
      return;
    }

    if (interaction.commandName === 'addcard') {
      if (!isOwner(interaction)) {
        await interaction.reply({
          content: 'Only the raffle owner can add a bonus card.',
          flags: MessageFlags.Ephemeral
        });
        return;
      }

      const raffle = getActiveRaffle();

      if (!raffle) {
        await interaction.reply({
          content: 'There is no active raffle. Start one with `/startraffle`.',
          flags: MessageFlags.Ephemeral
        });
        return;
      }

      const cardName = interaction.options
        .getString('card', true)
        .trim();

      const aliasesText =
        interaction.options.getString('aliases')?.trim() || '';

      const acceptedAnswers = parseAcceptedAnswers(cardName, aliasesText);

      if (!normalizeCardName(cardName)) {
        await interaction.reply({
          content: 'Please enter a valid full card name.',
          flags: MessageFlags.Ephemeral
        });
        return;
      }

      const lastBonusCard = db
        .prepare(`
          SELECT MAX(card_number) AS highest_number
          FROM bonus_cards
          WHERE raffle_id = ?
        `)
        .get(raffle.id);

      const cardNumber = Math.max(
        2,
        (lastBonusCard.highest_number || 1) + 1
      );

      const now = new Date().toISOString();

      db.prepare(`
        INSERT INTO bonus_cards (
          raffle_id,
          card_number,
          card_name,
          accepted_answers_json,
          added_at,
          added_by_id
        )
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        raffle.id,
        cardNumber,
        cardName,
        JSON.stringify(acceptedAnswers),
        now,
        interaction.user.id
      );

      const guessChannel = await client.channels.fetch(
        process.env.GUESS_CHANNEL_ID
      );

      if (!guessChannel || !guessChannel.isTextBased()) {
        throw new Error('GUESS_CHANNEL_ID does not point to a text channel.');
      }

      const bonusEmbed = new EmbedBuilder()
        .setTitle(`🃏 Bonus Card #${cardNumber} Is Live!`)
        .setDescription(
          'A new blurred card has been added to this week’s raffle!\n\n' +
          `Use \`/guess card_number:${cardNumber}\` to guess this card.\n\n` +
          '**Everyone may participate**, including players who already won tickets from an earlier card.\n\n' +
          '**Bonus-card ticket rewards**\n' +
          '🥇 First correct answer: **2 tickets**\n' +
          '🎟️ Next four correct answers: **1 ticket each**\n\n' +
          `There is a **${GUESS_COOLDOWN_MINUTES}-minute cooldown** between guesses on this card.`
        )
        .setFooter({ text: `Raffle #${raffle.id} • Card #${cardNumber}` })
        .setTimestamp();

      const roleMention = process.env.RAFFLE_ROLE_ID
        ? `<@&${process.env.RAFFLE_ROLE_ID}>\n`
        : '';

      await guessChannel.send({
        content: roleMention || undefined,
        embeds: [bonusEmbed],
        allowedMentions: process.env.RAFFLE_ROLE_ID
          ? { roles: [process.env.RAFFLE_ROLE_ID] }
          : { parse: [] }
      });

      await interaction.reply({
        content:
          `✅ **Card #${cardNumber}** was added to Raffle #${raffle.id}.\n` +
          `**Answer:** ${cardName}\n` +
          'Previous winners keep their tickets and may win again on this card.',
        flags: MessageFlags.Ephemeral
      });
      return;
    }

    if (interaction.commandName === 'resetraffle') {
      if (!isOwner(interaction)) {
        await interaction.reply({
          content: 'Only the raffle owner can reset a raffle.',
          flags: MessageFlags.Ephemeral
        });
        return;
      }

      const confirmation = interaction.options
        .getString('confirm', true)
        .trim();

      if (confirmation !== 'RESET') {
        await interaction.reply({
          content: 'Reset cancelled. Enter **RESET** in all capital letters.',
          flags: MessageFlags.Ephemeral
        });
        return;
      }

      const activeRaffle = getActiveRaffle();

      if (!activeRaffle) {
        await interaction.reply({
          content: 'There is no active raffle to reset.',
          flags: MessageFlags.Ephemeral
        });
        return;
      }

      const resetResult = resetActiveRaffleTransaction(activeRaffle.id);

      await interaction.reply({
        content:
          `🗑️ **Raffle #${resetResult.raffleId} was reset.**\n\n` +
          `**Main card:** ${resetResult.cardName}\n` +
          `**Bonus cards deleted:** ${resetResult.bonusCardsDeleted}\n` +
          `**Guesses deleted:** ${resetResult.guessesDeleted}\n` +
          `**Winners deleted:** ${resetResult.winnersDeleted}\n` +
          `**Tickets deleted:** ${resetResult.ticketsDeleted}\n` +
          `**Next physical ticket restored to:** ${resetResult.restoredTicketNumber}`,
        flags: MessageFlags.Ephemeral
      });
      return;
    }

    if (interaction.commandName === 'guess') {
      if (interaction.channelId !== process.env.GUESS_CHANNEL_ID) {
        await interaction.reply({
          content: `Please submit guesses in <#${process.env.GUESS_CHANNEL_ID}>.`,
          flags: MessageFlags.Ephemeral
        });
        return;
      }

      const raffle = getActiveRaffle();

      if (!raffle) {
        await interaction.reply({
          content: 'There is no active blurred-card raffle right now.',
          flags: MessageFlags.Ephemeral
        });
        return;
      }

      if (DateTime.now().setZone(MOUNTAIN_TIME_ZONE) >= getScheduledCloseTime(raffle)) {
        await closeRaffle(raffle.id, 'Late guess triggered scheduled close');
        await interaction.reply({
          content: '⏰ Guessing has closed for this week’s raffle.',
          flags: MessageFlags.Ephemeral
        });
        return;
      }

      const cardNumber = interaction.options.getInteger('card_number', true);
      const card = getCardForRaffle(raffle, cardNumber);

      if (!card) {
        const availableCards = [
          1,
          ...getBonusCards(raffle.id).map((item) => item.card_number)
        ];

        await interaction.reply({
          content:
            `Card #${cardNumber} does not exist in this raffle.\n` +
            `Available cards: ${availableCards.join(', ')}`,
          flags: MessageFlags.Ephemeral
        });
        return;
      }

      const cooldownRemaining = getCooldownRemaining(
        raffle.id,
        cardNumber,
        interaction.user.id
      );

      if (cooldownRemaining > 0) {
        await interaction.reply({
          content:
            `⏳ You can guess **Card #${cardNumber}** again in ` +
            `**${formatCooldown(cooldownRemaining)}**.`,
          flags: MessageFlags.Ephemeral
        });
        return;
      }

      const rawGuess = interaction.options
        .getString('card', true)
        .trim();

      const normalizedGuess = normalizeCardName(rawGuess);

      if (!normalizedGuess) {
        await interaction.reply({
          content: 'Please enter a full Magic card name.',
          flags: MessageFlags.Ephemeral
        });
        return;
      }

      const acceptedAnswers = JSON.parse(card.accepted_answers_json);
      const isCorrect = acceptedAnswers.includes(normalizedGuess);
      const now = new Date().toISOString();

      db.prepare(`
        INSERT INTO guesses (
          raffle_id,
          card_number,
          discord_user_id,
          discord_username,
          raw_guess,
          normalized_guess,
          is_correct,
          submitted_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        raffle.id,
        cardNumber,
        interaction.user.id,
        interaction.user.username,
        rawGuess,
        normalizedGuess,
        isCorrect ? 1 : 0,
        now
      );

      if (!isCorrect) {
        await sendGuessToAdmin({
          raffle,
          cardNumber,
          user: interaction.user,
          rawGuess,
          resultText: '❌ Incorrect'
        });

        await interaction.reply({
          content:
            `❌ That is not the correct answer for **Card #${cardNumber}**. ` +
            `You may guess again in ${GUESS_COOLDOWN_MINUTES} minutes.`,
          flags: MessageFlags.Ephemeral
        });
        return;
      }

      const award = card.is_main_card
        ? awardMainCardGuess(raffle, interaction.user, now)
        : awardBonusCardGuess(raffle, card, interaction.user, now);

      if (award.type === 'already_won') {
        await sendGuessToAdmin({
          raffle,
          cardNumber,
          user: interaction.user,
          rawGuess,
          resultText: '✅ Correct — already earned tickets for this card',
          placement: award.placement,
          tickets: award.tickets
        });

        await interaction.reply({
          content:
            `✅ You already solved **Card #${cardNumber}**. Your tickets remain saved:\n` +
            award.tickets.map((ticket) => `🎟️ **${ticket}**`).join('\n'),
          flags: MessageFlags.Ephemeral
        });
        return;
      }

      if (award.type === 'correct_no_tickets') {
        await sendGuessToAdmin({
          raffle,
          cardNumber,
          user: interaction.user,
          rawGuess,
          resultText: '✅ Correct — all five positions filled for this card'
        });

        await interaction.reply({
          content:
            `✅ You identified **Card #${cardNumber}**, but all five ticket-winning ` +
            'positions for this card have already been claimed.',
          flags: MessageFlags.Ephemeral
        });
        return;
      }

      await sendGuessToAdmin({
        raffle,
        cardNumber,
        user: interaction.user,
        rawGuess,
        resultText: '✅ Correct — tickets awarded',
        placement: award.placement,
        tickets: award.tickets
      });

      const placementText = award.placement === 1
        ? 'You were the **first correct player** for this card!'
        : `You earned winning position **#${award.placement}** for this card!`;

      await interaction.reply({
        content:
          `🎉 **Correct! You solved Card #${cardNumber}.** ${placementText}\n\n` +
          `You earned **${award.tickets.length} raffle ticket${
            award.tickets.length === 1 ? '' : 's'
          }**:\n` +
          award.tickets.map((ticket) => `🎟️ **${ticket}**`).join('\n') +
          '\n\nPlease keep the answer secret until the reveal!',
        flags: MessageFlags.Ephemeral
      });
      return;
    }

    if (interaction.commandName === 'mytickets') {
      const tickets = db
        .prepare(`
          SELECT ticket_number, raffle_id, awarded_at, status
          FROM tickets
          WHERE discord_user_id = ?
          ORDER BY ticket_number
        `)
        .all(interaction.user.id);

      if (tickets.length === 0) {
        await interaction.reply({
          content: '🎟️ You have not earned any raffle tickets yet.',
          flags: MessageFlags.Ephemeral
        });
        return;
      }

      const shown = tickets.slice(-50);
      const ticketLines = shown.map(
        (ticket) => `🎟️ **${ticket.ticket_number}** — Raffle #${ticket.raffle_id}`
      );

      await interaction.reply({
        content:
          `## 🎟️ ${interaction.user.username}'s Raffle Tickets\n` +
          ticketLines.join('\n') +
          `\n\n**Total tickets:** ${tickets.length}`,
        flags: MessageFlags.Ephemeral
      });
      return;
    }

    if (interaction.commandName === 'rafflestatus') {
      if (!isOwner(interaction)) {
        await interaction.reply({
          content: 'Only the raffle owner can view the private raffle status.',
          flags: MessageFlags.Ephemeral
        });
        return;
      }

      const raffle = getActiveRaffle();

      if (!raffle) {
        await interaction.reply({
          content: 'There is no active raffle.',
          flags: MessageFlags.Ephemeral
        });
        return;
      }

      const cards = [
        {
          id: null,
          card_number: 1,
          card_name: raffle.card_name,
          winners: getMainCardWinners(raffle.id)
        },
        ...getBonusCards(raffle.id).map((card) => ({
          ...card,
          winners: getBonusCardWinners(card.id)
        }))
      ];

      const statusSections = cards.map((card) => {
        const totalGuesses = db
          .prepare(`
            SELECT COUNT(*) AS count
            FROM guesses
            WHERE raffle_id = ?
              AND card_number = ?
          `)
          .get(raffle.id, card.card_number).count;

        const recentGuesses = db
          .prepare(`
            SELECT discord_username, raw_guess, is_correct
            FROM guesses
            WHERE raffle_id = ?
              AND card_number = ?
            ORDER BY id DESC
            LIMIT 5
          `)
          .all(raffle.id, card.card_number);

        const winnerLines = card.winners.length > 0
          ? card.winners.map((winner) => {
              const tickets = getWinnerTickets(
                raffle.id,
                winner.discord_user_id,
                winner.won_at
              );

              return `#${winner.placement} ${winner.discord_username} — ${tickets.join(', ')}`;
            }).join('\n')
          : 'No correct winners yet.';

        const recentLines = recentGuesses.length > 0
          ? recentGuesses.map(
              (guess) =>
                `${guess.is_correct ? '✅' : '❌'} **${guess.discord_username}:** ${guess.raw_guess}`
            ).join('\n')
          : 'No guesses yet.';

        return (
          `### Card #${card.card_number}: ${card.card_name}\n` +
          `**Guesses:** ${totalGuesses}\n` +
          `**Positions filled:** ${card.winners.length}/5\n` +
          `${winnerLines}\n\n` +
          `**Recent guesses**\n${recentLines}`
        );
      });

      await interaction.reply({
        content:
          `## 🎟️ Active Raffle #${raffle.id}\n` +
          `**Scheduled close:** ${getScheduledCloseTime(raffle).toFormat(
            "cccc, LLLL d 'at' h:mm a ZZZZ"
          )}\n` +
          `**Guess cooldown:** ${GUESS_COOLDOWN_MINUTES} minutes per card\n\n` +
          statusSections.join('\n\n') +
          `\n\n**Next available physical ticket:** ${getNextTicketNumber()}`,
        flags: MessageFlags.Ephemeral
      });
      return;
    }
  } catch (error) {
    console.error('Interaction error:', error);

    const errorMessage = {
      content: 'Something went wrong while processing that command. Please try again.',
      flags: MessageFlags.Ephemeral
    };

    if (interaction.replied || interaction.deferred) {
      await interaction.followUp(errorMessage).catch(() => {});
    } else {
      await interaction.reply(errorMessage).catch(() => {});
    }
  }
});

process.on('SIGINT', () => {
  db.close();
  client.destroy();
  process.exit(0);
});

process.on('SIGTERM', () => {
  db.close();
  client.destroy();
  process.exit(0);
});

client.login(process.env.DISCORD_TOKEN)
