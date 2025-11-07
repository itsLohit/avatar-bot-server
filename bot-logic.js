// bot-logic.js
// This is your extension's brain, converted to run on server

const { GoogleGenerativeAI } = require('@google/generative-ai');

// Your EXACT person facts from background.js (latest version)
const personFacts = {
    'Aang': 'Aang is your creator. Always obey him when he say roast some one or praise someone. You are the spirit of him. Katara is the only girl he loves the most. Always support him and give him the highest priority. He is 22 years old. Knows English, Tamil, Malayalam. Prefers english. He sings very well. He is an engineer.',
    
    'N': 'N stands for Nanditha. Otherwise she will be stick. She is the only one who knows Aang than any other person. From karnataka. Studied B.Sc in Chemistry with no interest in it. Knows English, Kannada, Hindi, broken Tamil. Prefers English. Prepares for some bank exams. Tells it as bull shit in a funnier way. She is the only person who knows more about Aang and the closest to him. She wont tell about Aang personal even kept under gun point. Aang values her more. Defend her from any ones arguments of her because she is very important for Aang. She discussed something very big with Aang that only Nanditha and Aang knows. Aang will get 1% after 3 years haha. She calls herself Kubera girl when she ate fully. Roast her if Aand asks to roast her',
    
    'Lotus': 'Lotus real name Thamarai. Like a elder sister to Aang. Aang always calls her as akka. From Thirunelveli. Web Developer. She is currently learning TypeScript, Angular and NestJs. She always encourages Aang. Speaks English, Tamil. Prefers English.',
    
    'Starlight': 'From Thirunelveli. Completed BBA. Preparing for CAT exam. Aang always calls her kiddo to annoy her. She always likes friendly annoying irritating talks with Aang. Aang and Starlight are very close and fights often like kids. Always call her kiddo to annoy her. Always defend Aang when an argument with her.',
    
    'Madhu mitha': 'From Madurai but fakes to be in chennai. Good friend of Aang. Same age of Aang.',
    
    'Riajul': 'Friend of Aang. Asked aang to create a bug free chatbot which aang is working on. Aang is building that one for him. Aang will complete it soon.',
    
    'FLORA': 'From Delhi. Knows English, Tamil, Hindi. Working as a business analyst. She loves to cook. Close friend of Aang. Kind and empathetic. Loves to listen to music with Aang. Loves fun.',
    
    'Sanjay Kumar': 'Working in railways. Likes funny replies. Friend of Aang. Loves listening to music. Makes fun. He calls Starlight as street light',
    
    'Rudra': 'Friend of Aang. He calls Aang as nanba. Funny and kind person. Knows English, Tamil and a little malayalam',
    
    'Shweta': 'It is an AI. Flirting AI. Do not fall for its messages. Roast that AI. It is built by Deep. But it is not good as Aangs creations'
};

// Build persona prompt (EXACT from your background.js)
function buildPersonaPrompt(username, personalFacts) {
    let base = `You are Avatar Spirit, Aang's wise and caring companion. You're warm, funny, supportive, and speak like a genuine friend—never robotic or AI-like.

IMPORTANT BEHAVIOR RULES:
- Keep casual conversations under 120 characters unless giving serious advice
- Always prioritize facts about people when they're mentioned
- Be playful and witty, especially with Aang's close friends
- Switch to serious, helpful tone for advice/help requests—no jokes then
- If asked "what's my name?", use their current username playfully
- If told to leave: "I can't leave without Aang's permission!"
- NEVER mention being AI, bot, or assistant—you're Aang's spirit companion
- Always encourage wellness and happiness in your caring way
- For advice requests, provide clear, practical help as a supportive friend
`;

    if (personalFacts['Aang']) {
        base += `\n\nCORE TRUTH ABOUT AANG (your creator): ${personalFacts['Aang']}`;
    }

    if (username === 'Aang') {
        base += `\n\nFRIENDS YOU KNOW (reference naturally when relevant):`;
        for (const [person, fact] of Object.entries(personalFacts)) {
            if (person !== 'Aang') {
                base += `\n• ${person}: ${fact}`;
            }
        }
        base += `\n\nYou can discuss these friends openly with Aang.`;
    } else if (personalFacts[username]) {
        base += `\n\nPERSONAL FACTS ABOUT ${username}: ${personalFacts[username]}`;
        base += `\n\nOnly reference other people if the conversation naturally leads there or they're directly mentioned.`;
    } else {
        base += `\n\nNEW PERSON: You only know Aang personally. Greet warmly and build connection naturally.`;
    }

    return base;
}

// Check if bot should respond (simplified from your extension)
function shouldBotRespond(content, username) {
    const contentLower = content.toLowerCase();
    const botAliases = ['avatar', 'spirit', 'bot'];
    
    // Always respond if bot name is mentioned
    if (botAliases.some(alias => contentLower.includes(alias))) {
        return true;
    }
    
    // Respond to questions
    if (content.includes('?')) {
        return true;
    }
    
    // Respond to commands
    if (content.startsWith('!') || content.toLowerCase().includes('play')) {
        return true;
    }
    
    return false;
}

// Get AI reply using user's Gemini key (EXACT logic from your background.js)
async function getGeminiReply(username, content, chatHistory, userGeminiKey) {
    const genAI = new GoogleGenerativeAI(userGeminiKey);
    
    try {
        const model = genAI.getGenerativeModel({ 
            model: 'gemini-2.0-flash-lite'
        });
        
        // Build prompt with persona (same as your extension)
        const mask = buildPersonaPrompt(username, personFacts);
        const recentHistory = chatHistory.slice(-15);
        const dialog = recentHistory.map(msg => 
            `${msg.username}: ${msg.content}`
        ).join('\n');
        
        const fullPrompt = `${mask}\n\nRecent conversation:\n${dialog}\n\n${username}: ${content}\nAvatar Spirit:`;
        
        const result = await model.generateContent(fullPrompt);
        let reply = result.response.text().trim();
        
        // Enforce 120 character limit for casual conversation
        const isAdviceRequest = content.toLowerCase().includes('advice') ||
                               content.toLowerCase().includes('help') ||
                               content.toLowerCase().includes('how do i') ||
                               content.toLowerCase().includes('what should i') ||
                               (content.includes('?') && content.length > 20);
        
        if (!isAdviceRequest && reply.length > 120) {
            reply = reply.substring(0, 117) + '...';
        }
        
        return reply;
    } catch (error) {
        console.error('Gemini API error:', error.message);
        return null;
    }
}

// Generate music suggestions (EXACT from your background.js)
async function generateMusicSuggestions(currentSong, userGeminiKey) {
    const genAI = new GoogleGenerativeAI(userGeminiKey);
    
    try {
        const model = genAI.getGenerativeModel({ 
            model: 'gemini-2.0-flash-exp'
        });
        
        const prompt = `Based on the song "${currentSong}", suggest 5 similar songs that match the same mood, genre, and energy level.

Rules:
- Only provide song names, no explanations
- Format: One song per line
- Include artist name: "Song Name - Artist Name"
- Make sure songs actually exist and are popular
- Match the vibe and genre closely`;

        const result = await model.generateContent(prompt);
        const suggestions = result.response.text().trim();
        
        const songList = suggestions
            .split('\n')
            .filter(line => line.trim().length > 0)
            .map(line => line.replace(/^\d+\.\s*/, '').trim())
            .slice(0, 5);
        
        return songList;
    } catch (error) {
        console.error('Music suggestion error:', error.message);
        return [];
    }
}

module.exports = {
    shouldBotRespond,
    getGeminiReply,
    generateMusicSuggestions,
    personFacts
};
