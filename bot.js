const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
} = require('discord.js');
const {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  NoSubscriberBehavior,
  AudioPlayerStatus,
  entersState,
  VoiceConnectionStatus,
  getVoiceConnection,
} = require('@discordjs/voice');
const { spawn } = require('child_process');
const ffmpeg = require('ffmpeg-static');

const TOKEN = process.env.DISCORD_TOKEN;
const GUILD_ID = process.env.GUILD_ID;
const CHANNEL_ID = process.env.CHANNEL_ID;

if (!TOKEN) {
  console.error('Missing DISCORD_TOKEN environment variable.');
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
  ],
});

const player = createAudioPlayer({
  behaviors: { noSubscriber: NoSubscriberBehavior.Play },
});

function createSilentStream() {
  const proc = spawn(ffmpeg, [
    '-f', 'lavfi',
    '-i', 'anullsrc=r=48000:cl=stereo',
    '-f', 's16le',
    '-ar', '48000',
    '-ac', '2',
    'pipe:1',
  ]);
  proc.stderr.on('data', () => {});
  return createAudioResource(proc.stdout);
}

function startSilentAudio(connection) {
  connection.subscribe(player);

  function playSilent() {
    player.play(createSilentStream());
  }
  playSilent();

  player.off(AudioPlayerStatus.Idle, playSilent);
  player.on(AudioPlayerStatus.Idle, () => {
    console.log('Restarting silent audio...');
    playSilent();
  });

  player.on('error', (err) => {
    console.error('Player error:', err.message);
    playSilent();
  });
}

async function joinChannel(channelId, guildId, adapterCreator) {
  const existing = getVoiceConnection(guildId);
  if (existing) existing.destroy();

  const connection = joinVoiceChannel({
    channelId,
    guildId,
    adapterCreator,
    selfDeaf: false,
    selfMute: false,
  });

  await entersState(connection, VoiceConnectionStatus.Ready, 30_000);

  connection.on(VoiceConnectionStatus.Disconnected, async () => {
    console.log('Disconnected. Attempting to reconnect...');
    try {
      await entersState(connection, VoiceConnectionStatus.Signalling, 5_000);
    } catch {
      try { connection.rejoin(); } catch (err) {
        console.error('Rejoin failed:', err.message);
      }
    }
  });

  startSilentAudio(connection);
  return connection;
}

async function registerCommands(clientId) {
  const commands = [
    new SlashCommandBuilder()
      .setName('join')
      .setDescription('Bot joins your current voice channel'),
    new SlashCommandBuilder()
      .setName('leave')
      .setDescription('Bot leaves the voice channel'),
  ].map(c => c.toJSON());

  const rest = new REST({ version: '10' }).setToken(TOKEN);

  if (GUILD_ID) {
    await rest.put(Routes.applicationGuildCommands(clientId, GUILD_ID), { body: commands });
    console.log('Slash commands registered to guild.');
  } else {
    await rest.put(Routes.applicationCommands(clientId), { body: commands });
    console.log('Slash commands registered globally (may take up to 1 hour).');
  }
}

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === 'join') {
    const member = interaction.member;
    const voiceChannel = member?.voice?.channel;

    if (!voiceChannel) {
      return interaction.reply({ content: 'You need to be in a voice channel first!', ephemeral: true });
    }

    await interaction.deferReply({ ephemeral: true });

    try {
      await joinChannel(voiceChannel.id, voiceChannel.guild.id, voiceChannel.guild.voiceAdapterCreator);
      console.log(`Joined voice channel: ${voiceChannel.name}`);
      await interaction.editReply(`Joined **${voiceChannel.name}**!`);
    } catch (err) {
      console.error('Failed to join channel:', err.message);
      await interaction.editReply('Failed to join the voice channel. Check my permissions.');
    }
  }

  if (interaction.commandName === 'leave') {
    const connection = getVoiceConnection(interaction.guildId);
    if (connection) {
      connection.destroy();
      console.log('Left voice channel.');
      await interaction.reply({ content: 'Left the voice channel.', ephemeral: true });
    } else {
      await interaction.reply({ content: "I'm not in a voice channel.", ephemeral: true });
    }
  }
});

client.once('ready', async () => {
  console.log(`Logged in as ${client.user.tag}`);

  try {
    await registerCommands(client.user.id);
  } catch (err) {
    console.error('Failed to register slash commands:', err.message);
  }

  if (GUILD_ID && CHANNEL_ID) {
    try {
      const guild = await client.guilds.fetch(GUILD_ID);
      await joinChannel(CHANNEL_ID, GUILD_ID, guild.voiceAdapterCreator);
      console.log('Auto-joined voice channel on startup.');
    } catch (err) {
      console.error('Auto-join failed:', err.message);
      console.log('Use /join in Discord to manually connect the bot.');
    }
  } else {
    console.log('No GUILD_ID/CHANNEL_ID set — use /join in Discord to connect.');
  }
});

client.on('error', (err) => {
  console.error('Discord client error:', err.message);
});

client.login(TOKEN);
