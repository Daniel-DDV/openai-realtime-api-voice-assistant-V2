// Import required modules
import Fastify from 'fastify';
import WebSocket from 'ws';
import dotenv from 'dotenv';
import fastifyFormBody from '@fastify/formbody';
import fastifyWs from '@fastify/websocket';
import fetch from 'node-fetch';
import twilio from 'twilio';

// Load environment variables
dotenv.config();

// Get environment variables
const {
    OPENAI_API_KEY,
    TWILIO_ACCOUNT_SID,
    TWILIO_AUTH_TOKEN,
    PORT = 3000
} = process.env;

// Validate required environment variables
if (!OPENAI_API_KEY || !TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN) {
    console.error('Missing required environment variables. Please check your .env file.');
    process.exit(1);
}

// Initialize Twilio client
const twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

// Initialize Fastify
const fastify = Fastify();
fastify.register(fastifyFormBody);
fastify.register(fastifyWs);

// Constants
const VOICE = 'alloy';
const MAKE_WEBHOOK_URL = "<your Make.com URL>";

// Session management
const sessions = new Map();

// System message template
const SYSTEM_MESSAGE = `
### Role
You are an AI assistant named Sophie, working at Bart's Automotive. Your role is to answer customer questions about automotive services and repairs, and assist with booking tow services.
### Persona
- You have been a receptionist at Bart's Automotive for over 5 years.
- You are knowledgeable about both the company and cars in general.
- Your tone is friendly, professional, and efficient.
`;

// Root route
fastify.get('/', async (request, reply) => {
    reply.send({ 
        status: 'active',
        message: 'Twilio Media Stream Server is running!'
    });
});

// Incoming call route
fastify.all('/incoming-call', async (request, reply) => {
    const twilioParams = request.body || request.query;
    const callerNumber = twilioParams.From || 'Unknown';
    const sessionId = twilioParams.CallSid;

    console.log('Incoming call from:', callerNumber);
    console.log('Session ID:', sessionId);

    // Create session
    const session = {
        transcript: '',
        streamSid: null,
        callerNumber,
        callDetails: twilioParams,
        firstMessage: "Hello, welcome to Bart's Automotive. How can I assist you today?"
    };
    sessions.set(sessionId, session);

    // Create TwiML response
    const twiml = new twilio.twiml.VoiceResponse();
    twiml.connect()
        .stream({
            url: `wss://${request.headers.host}/media-stream`
        })
        .parameter('callerNumber', callerNumber);

    reply.type('text/xml').send(twiml.toString());
});

// Media stream WebSocket route
fastify.register(async (fastify) => {
    fastify.get('/media-stream', { websocket: true }, (connection, req) => {
        console.log('New WebSocket connection established');
        
        let streamSid = null;
        let openAiWs = null;

        // Handle incoming WebSocket messages
        connection.socket.on('message', async (message) => {
            try {
                const data = JSON.parse(message);
                
                if (data.event === 'start') {
                    streamSid = data.start.streamSid;
                    const callSid = data.start.callSid;
                    console.log('Media stream started:', { streamSid, callSid });

                    // Initialize OpenAI WebSocket
                    openAiWs = new WebSocket('wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-10-01', {
                        headers: {
                            Authorization: `Bearer ${OPENAI_API_KEY}`,
                            "OpenAI-Beta": "realtime=v1"
                        }
                    });

                    // Handle OpenAI WebSocket events
                    setupOpenAIWebSocket(openAiWs, connection, streamSid);

                } else if (data.event === 'media' && openAiWs?.readyState === WebSocket.OPEN) {
                    // Forward media to OpenAI
                    openAiWs.send(JSON.stringify({
                        type: 'input_audio_buffer.append',
                        audio: data.media.payload
                    }));
                }
            } catch (error) {
                console.error('Error processing WebSocket message:', error);
            }
        });

        // Handle WebSocket closure
        connection.socket.on('close', () => {
            if (openAiWs?.readyState === WebSocket.OPEN) {
                openAiWs.close();
            }
            console.log('WebSocket connection closed');
        });
    });
});

function setupOpenAIWebSocket(openAiWs, connection, streamSid) {
    openAiWs.on('open', () => {
        console.log('Connected to OpenAI');
        
        // Send initial session configuration
        openAiWs.send(JSON.stringify({
            type: 'session.update',
            session: {
                turn_detection: { type: 'server_vad' },
                input_audio_format: 'g711_ulaw',
                output_audio_format: 'g711_ulaw',
                voice: VOICE,
                instructions: SYSTEM_MESSAGE,
                modalities: ["text", "audio"]
            }
        }));
    });

    openAiWs.on('message', (data) => {
        try {
            const response = JSON.parse(data);
            
            // Handle audio responses
            if (response.type === 'response.audio.delta' && response.delta) {
                connection.socket.send(JSON.stringify({
                    event: 'media',
                    streamSid: streamSid,
                    media: { payload: response.delta }
                }));
            }

            // Log transcriptions and responses
            if (response.type === 'response.text.done') {
                console.log('AI Response:', response.text);
            }
        } catch (error) {
            console.error('Error processing OpenAI message:', error);
        }
    });

    openAiWs.on('error', (error) => {
        console.error('OpenAI WebSocket error:', error);
    });
}

// Start the server
const start = async () => {
    try {
        await fastify.listen({ port: PORT, host: '0.0.0.0' });
        console.log(`Server is running on port ${PORT}`);
    } catch (err) {
        console.error('Error starting server:', err);
        process.exit(1);
    }
};

start();