require('dotenv').config();  // Load environment variables from .env file

const { Client, GatewayIntentBits, REST, Routes, ActivityType } = require('discord.js');
const Groq = require('groq-sdk');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { pipeline } = require('stream');
const { createWriteStream } = require('fs');
const fetch = require('node-fetch');

// Your bot token, client ID, and guild ID from environment variables
const token = process.env.DISCORD_TOKEN;
const clientId = process.env.DISCORD_CLIENT_ID;

// Use platform-independent temp directory
const tempDir = os.tmpdir();

// Groq API configuration
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// Create a new client instance
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] });

// When the client is ready, run this code (only once)
client.once('ready', () => {
    console.log('Bot is ready!');
    client.user.setActivity('/help', { type: ActivityType.Watching });
});

// Clear all global commands, then register the new ones
client.once('ready', async () => {
    const rest = new REST({ version: '10' }).setToken(token);

    try {
        console.log('Starting to clear global commands...');

        // Clear all global commands
        await rest.put(Routes.applicationCommands(clientId), { body: [] });
        console.log('Cleared all global commands.');

        // Register the new global commands
        const newCommands = [
            {
                name: 'ask',
                description: 'Ask a question to the AI model',
                options: [
                    {
                        name: 'question',
                        type: 3, // STRING
                        description: 'The question you want to ask',
                        required: true,
                    },
                    {
                        name: 'model',
                        type: 3, // STRING
                        description: 'The model you want to use (gemma2-9b-it, mixtral-8x7b-32768, llama-3.1-70b-versatile)',
                        required: false,
                        choices: [
                            { name: 'gemma2-9b-it', value: 'gemma2-9b-it' },
                            { name: 'mixtral-8x7b-32768', value: 'mixtral-8x7b-32768' },
                            { name: 'llama-3.1-70b-versatile', value: 'llama-3.1-70b-versatile' },
                        ],
                    },
                ],
            },
            {
                name: 'speechtotext',
                description: 'Convert speech in an audio file to text using AI',
                options: [
                    {
                        name: 'audio',
                        type: 11, // ATTACHMENT
                        description: 'The audio file you want to transcribe',
                        required: true,
                    },
                ],
            }
        ];

        await rest.put(Routes.applicationCommands(clientId), { body: newCommands });
        console.log('Successfully registered new global application commands.');

    } catch (error) {
        console.error('Error during global command registration process:', error);
    }
});

// Function to send long messages in chunks
async function sendLongMessage(interaction, message) {
    const maxLength = 2000; // Discord message character limit
    while (message.length > 0) {
        const part = message.slice(0, maxLength);
        message = message.slice(maxLength);
        await interaction.followUp(part);
    }
}

// Listen for slash commands
client.on('interactionCreate', async interaction => {
    if (!interaction.isCommand()) return;

    const { commandName, options } = interaction;

    if (commandName === 'ask') {
        const question = options.getString('question');
        const model = options.getString('model') || 'llama-3.1-70b-versatile'; // Default to llama if no model is provided

        try {
            // Defer the reply to avoid interaction timeout
            await interaction.deferReply();

            // Prepare and make the Groq API request
            const chatCompletion = await getGroqChatCompletion(question, model);
            const reply = chatCompletion.choices[0]?.message?.content || "No response from AI model.";

            // Send the response to Discord in chunks if it's too long
            await sendLongMessage(interaction, reply);

        } catch (error) {
            console.error('Error during interaction handling:', error);
            try {
                await interaction.followUp("There was an error with the API request.");
            } catch (followUpError) {
                console.error("Error sending follow-up:", followUpError);
            }
        }
    } else if (commandName === 'speechtotext') {
        const audio = options.getAttachment('audio');
        const tempFilePath = path.join(tempDir, audio.name);

        try {
            // Defer the reply to avoid interaction timeout
            await interaction.deferReply();

            // Download the audio file to the temp directory
            const response = await fetch(audio.url);
            await new Promise((resolve, reject) => {
                pipeline(response.body, createWriteStream(tempFilePath), (err) => {
                    if (err) reject(err);
                    else resolve();
                });
            });

            // Perform transcription using Groq API
            const transcription = await getGroqTranscription(tempFilePath);
            const reply = transcription.text || "No transcription could be generated.";

            // Send the transcription to Discord
            await sendLongMessage(interaction, reply);

            // Cleanup: Remove the temp file after processing
            fs.unlinkSync(tempFilePath);

        } catch (error) {
            console.error('Error during speech-to-text interaction handling:', error);
            try {
                await interaction.followUp("There was an error processing the audio file.");
            } catch (followUpError) {
                console.error("Error sending follow-up:", followUpError);
            }
        }
    }
});

// Function to get chat completion from Groq with a selected model
async function getGroqChatCompletion(question, model) {
    return groq.chat.completions.create({
        messages: [
            {
                role: "user",
                content: question,
            },
        ],
        model: model, // Use the selected model or default to llama
    });
}

// Function to get audio transcription from Groq
async function getGroqTranscription(filePath) {
    return groq.audio.transcriptions.create({
        file: fs.createReadStream(filePath),
        model: "whisper-large-v3",
        prompt: "", // Optional context or spelling prompt
        response_format: "json", // Optional
        language: "en", // Optional
        temperature: 0.0, // Optional
    });
}

// Login to Discord with your bot's token
client.login(token).then(() => {
    console.log('Logged in successfully!');
}).catch(error => {
    console.error('Error logging in:', error);
});
