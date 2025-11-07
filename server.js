const express = require('express');
const { chromium } = require('playwright');
const crypto = require('crypto');
const fs = require('fs').promises;
const path = require('path');
const botLogic = require('./bot-logic');

const app = express();
app.use(express.json());
app.use(express.static('public'));

const AUTH_STATE_FILE = path.join(__dirname, 'auth-state.json');
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'avatar-spirit-bot-key-2025-secure';

let globalBrowser = null;
let globalContext = null;
const activeBots = new Map();

// ====================
// ENCRYPTION
// ====================
function encrypt(text) {
    const key = crypto.scryptSync(ENCRYPTION_KEY, 'salt', 32);
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    return iv.toString('hex') + ':' + encrypted;
}

function decrypt(encrypted) {
    const parts = encrypted.split(':');
    const iv = Buffer.from(parts[0], 'hex');
    const encryptedText = parts[1];
    const key = crypto.scryptSync(ENCRYPTION_KEY, 'salt', 32);
    const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
    let decrypted = decipher.update(encryptedText, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
}

// ====================
// BROWSER INIT
// ====================
async function initBrowser() {
    console.log('🚀 Initializing Playwright browser...');
    
    try {
        globalBrowser = await chromium.launch({
            headless: true,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-blink-features=AutomationControlled',
                '--disable-infobars',
                '--disable-dev-shm-usage',
                '--window-size=1920,1080'
            ]
        });
        
        console.log('✅ Browser initialized');
        
        // Load auth or do manual login
        try {
            const authStateExists = await fs.access(AUTH_STATE_FILE).then(() => true).catch(() => false);
            if (authStateExists) {
                const authState = JSON.parse(await fs.readFile(AUTH_STATE_FILE, 'utf8'));
                globalContext = await globalBrowser.newContext({ storageState: authState });
                console.log('✓ Loaded saved auth');
            } else {
                throw new Error('No auth file');
            }
        } catch (e) {
            console.log('⚠️ Need manual login');
            await performManualLogin();
        }
    } catch (error) {
        console.error('❌ Browser init failed:', error.message);
        throw error;
    }
}

async function performManualLogin() {
    console.log('\n🔐 FIRST-TIME SETUP: Manual Login\n');
    console.log('Browser opening at Free4Talk...');
    
    globalContext = await globalBrowser.newContext();
    const loginPage = await globalContext.newPage();
    await loginPage.goto('https://www.free4talk.com');
    
    console.log('Please login in the browser window');
    console.log('Then press ENTER here when done...\n');
    
    await new Promise(resolve => {
        const readline = require('readline').createInterface({
            input: process.stdin,
            output: process.stdout
        });
        readline.question('> ', () => {
            readline.close();
            resolve();
        });
    });
    
    const authState = await globalContext.storageState();
    await fs.writeFile(AUTH_STATE_FILE, JSON.stringify(authState, null, 2));
    console.log('✅ Auth saved!\n');
    
    await loginPage.close();
}

// ====================
// API ENDPOINTS
// ====================
app.get('/health', (req, res) => {
    res.json({ 
        status: 'ok', 
        activeBots: activeBots.size,
        uptime: Math.floor(process.uptime()),
        memory: Math.round(process.memoryUsage().heapUsed / 1024 / 1024) + ' MB'
    });
});

app.get('/api/bots', (req, res) => {
    const bots = Array.from(activeBots.entries()).map(([id, bot]) => ({
        subscriptionId: id,
        roomKey: bot.roomKey,
        joinedAt: new Date(bot.joinedAt).toISOString(),
        messageCount: bot.chatHistory.length
    }));
    res.json({ bots });
});

app.post('/api/activate', async (req, res) => {
    const { subscriptionId, geminiKey, roomLink } = req.body;
    
    console.log(`📥 Activation: ${subscriptionId}`);
    
    if (!subscriptionId || !geminiKey || !roomLink) {
        return res.status(400).json({ error: 'Missing fields' });
    }
    
    if (subscriptionId.length < 5) {
        return res.status(400).json({ error: 'Invalid ID' });
    }
    
    const roomMatch = roomLink.match(/room\/([a-zA-Z0-9-]+)/);
    const keyMatch = roomLink.match(/key=([0-9]+)/);
    
    if (!roomMatch) {
        return res.status(400).json({ error: 'Invalid room link' });
    }
    
    const roomKey = roomMatch[1];
    const accessKey = keyMatch ? keyMatch[1] : null;
    const fullRoomUrl = accessKey 
        ? `https://www.free4talk.com/room/${roomKey}?key=${accessKey}`
        : `https://www.free4talk.com/room/${roomKey}`;
    
    if (activeBots.has(subscriptionId)) {
        const existing = activeBots.get(subscriptionId);
        if (existing.roomKey === roomKey) {
            return res.json({ success: true, message: 'Already active', status: 'active' });
        }
        await removeBot(subscriptionId);
    }
    
    try {
        await joinRoom(subscriptionId, {
            roomKey,
            fullRoomUrl,
            geminiKey: encrypt(geminiKey)
        });
        
        res.json({ success: true, message: 'Bot joining room!', roomKey });
    } catch (error) {
        console.error('❌ Activate failed:', error.message);
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/deactivate', async (req, res) => {
    const { subscriptionId } = req.body;
    if (!subscriptionId) return res.status(400).json({ error: 'Missing ID' });
    
    if (activeBots.has(subscriptionId)) {
        await removeBot(subscriptionId);
        res.json({ success: true });
    } else {
        res.status(404).json({ error: 'Bot not found' });
    }
});

// ====================
// BOT MANAGEMENT
// ====================
async function joinRoom(subscriptionId, config) {
    console.log(`🔌 Joining: ${config.roomKey}`);
    
    const context = await globalBrowser.newContext({
        storageState: await globalContext.storageState()
    });
    
    const page = await context.newPage();
    
    try {
        await page.goto(config.fullRoomUrl, { waitUntil: 'networkidle', timeout: 30000 });
        await page.waitForTimeout(3000);
        
        try {
            await page.keyboard.press('Enter');
            await page.waitForTimeout(2000);
        } catch (e) {}
        
        await sendMessageInRoom(page, '👋 Avatar Spirit Bot is active!');
        await setupMessageListener(page, subscriptionId, config);
        
        activeBots.set(subscriptionId, {
            context,
            page,
            config,
            roomKey: config.roomKey,
            chatHistory: [],
            joinedAt: Date.now()
        });
        
        console.log(`✅ Bot active in ${config.roomKey}`);
    } catch (error) {
        await page.close();
        await context.close();
        throw error;
    }
}

async function setupMessageListener(page, subscriptionId, config) {
    console.log(`👂 Listening for messages...`);
    
    await page.evaluate(() => {
        window.messageQueue = [];
        setInterval(() => {
            const blocks = document.querySelectorAll('.system-message');
            blocks.forEach(block => {
                if (block.dataset.replied) return;
                
                const isPm = block.classList.contains('pm-mode');
                if (isPm && block.querySelector('.quote-content')) {
                    block.dataset.replied = 'true';
                    return;
                }
                
                const message = block.querySelector('.text.main-content p');
                const userName = block.querySelector('.name.primary span');
                
                if (userName && 
                    userName.textContent !== 'Avatar Spirit' && 
                    userName.textContent !== 'AvatarSpiritBot' &&
                    userName.textContent !== 'Free4Talk System' &&
                    message && 
                    !block.dataset.replied) {
                    
                    window.messageQueue.push({ 
                        username: userName.textContent.trim(),
                        content: message.textContent.trim(),
                        isPM: isPm
                    });
                    
                    block.dataset.replied = 'true';
                }
            });
        }, 2000);
    });
    
    const pollInterval = setInterval(async () => {
        try {
            if (!activeBots.has(subscriptionId)) {
                clearInterval(pollInterval);
                return;
            }
            
            const bot = activeBots.get(subscriptionId);
            if (bot.page.isClosed()) {
                clearInterval(pollInterval);
                activeBots.delete(subscriptionId);
                return;
            }
            
            const messages = await page.evaluate(() => {
                const msgs = window.messageQueue || [];
                window.messageQueue = [];
                return msgs;
            });
            
            for (const msg of messages) {
                await handleMessage(page, subscriptionId, config, msg);
            }
        } catch (error) {
            if (!error.message.includes('closed')) {
                console.error('Polling error:', error.message);
            } else {
                clearInterval(pollInterval);
                activeBots.delete(subscriptionId);
            }
        }
    }, 2000);
}

async function handleMessage(page, subscriptionId, config, message) {
    const bot = activeBots.get(subscriptionId);
    if (!bot) return;
    
    console.log(`[${subscriptionId}] ${message.username}: ${message.content}`);
    
    bot.chatHistory.push(message);
    if (bot.chatHistory.length > 100) bot.chatHistory.shift();
    
    if (!botLogic.shouldBotRespond(message.content, message.username)) return;
    
    try {
        const geminiKey = decrypt(config.geminiKey);
        const reply = await botLogic.getGeminiReply(
            message.username,
            message.content,
            bot.chatHistory,
            geminiKey
        );
        
        if (reply) {
            await sendMessageInRoom(page, reply);
            bot.chatHistory.push({ username: 'AvatarSpiritBot', content: reply });
        }
    } catch (error) {
        console.error('AI error:', error.message);
    }
}

async function sendMessageInRoom(page, text) {
    try {
        const chatInput = await page.$('.input-send-box textarea');
        if (!chatInput) {
            console.error('Chat input not found');
            return;
        }
        
        await chatInput.fill(text);
        await page.waitForTimeout(100);
        
        const sendButton = await page.$('.input-send-box button[type="button"]');
        if (sendButton) {
            await sendButton.click();
            console.log('✓ Sent:', text.substring(0, 40));
            await page.waitForTimeout(1500);
        }
    } catch (error) {
        console.error('Send error:', error.message);
    }
}

async function removeBot(subscriptionId) {
    const bot = activeBots.get(subscriptionId);
    if (bot) {
        console.log(`🚪 Removing: ${subscriptionId}`);
        try {
            await bot.page.close();
            await bot.context.close();
        } catch (e) {}
        activeBots.delete(subscriptionId);
    }
}

// ====================
// START SERVER
// ====================
const PORT = process.env.PORT || 3000;

initBrowser().then(() => {
    app.listen(PORT, () => {
        console.log('\n' + '='.repeat(60));
        console.log('✅ Avatar Spirit Bot Server RUNNING');
        console.log('='.repeat(60));
        console.log(`📊 Health: http://localhost:${PORT}/health`);
        console.log(`🤖 Bots: http://localhost:${PORT}/api/bots`);
        console.log(`🌐 Activate: http://localhost:${PORT}`);
        console.log('='.repeat(60) + '\n');
    });
}).catch(error => {
    console.error('❌ Failed:', error);
    process.exit(1);
});

process.on('SIGINT', async () => {
    console.log('\n🛑 Shutting down...');
    for (const [id] of activeBots) {
        await removeBot(id);
    }
    if (globalContext) await globalContext.close();
    if (globalBrowser) await globalBrowser.close();
    console.log('✅ Done');
    process.exit(0);
});
