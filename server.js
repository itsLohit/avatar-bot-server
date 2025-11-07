// server.js
// Avatar Spirit Bot Server with Playwright Authentication

const express = require('express');
const { chromium } = require('playwright');
const crypto = require('crypto');
const fs = require('fs').promises;
const path = require('path');
const botLogic = require('./bot-logic');

const app = express();
app.use(express.json());
app.use(express.static('public'));

// Configuration
const AUTH_STATE_FILE = path.join(__dirname, 'auth-state.json');
const subscriptions = new Map();
const activeBots = new Map();

let globalBrowser = null;
let globalContext = null;

// ====================
// ENCRYPTION (Updated for Node.js 22)
// ====================

const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'avatar-spirit-bot-key-2025-secure';

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
// PLAYWRIGHT BROWSER WITH AUTH
// ====================

async function initBrowser() {
    console.log('🚀 Initializing Playwright browser...');

    const isProduction = process.env.NODE_ENV === 'production';
    
    // Launch browser
    globalBrowser = await chromium.launch({
    headless: 'new',  // ADD THIS LINE - uses Chromium Headless Shell
    args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-blink-features=AutomationControlled',
        '--disable-infobars',
        '--disable-dev-shm-usage',
        '--window-size=1920,1080'
    ]
});
    console.log(`🔧 Running in ${isProduction ? 'PRODUCTION' : 'DEVELOPMENT'} mode`);
    
    // Check if we have saved auth state
    try {
        const authStateExists = await fs.access(AUTH_STATE_FILE).then(() => true).catch(() => false);
        
        if (authStateExists) {
            // Load saved authentication state
            console.log('📂 Loading saved authentication...');
            const authState = JSON.parse(await fs.readFile(AUTH_STATE_FILE, 'utf8'));
            globalContext = await globalBrowser.newContext({ storageState: authState });
            console.log('✓ Logged in using saved session');
            
            // Verify login is still valid
            const testPage = await globalContext.newPage();
            await testPage.goto('https://www.free4talk.com');
            await testPage.waitForTimeout(2000);
            
            // Check if still logged in
            const isLoggedIn = await testPage.evaluate(() => {
                return !document.body.innerText.includes('Sign in');
            });
            
            await testPage.close();
            
            if (!isLoggedIn) {
                console.log('⚠️  Saved session expired. Need to login again.');
                await globalContext.close();
                globalContext = null;
            }
        }
    } catch (error) {
        console.log('⚠️  No saved auth or invalid. First-time setup required.');
    }
    
    // If not logged in, do manual login
    if (!globalContext) {
        await performManualLogin();
    }
    
    console.log('✅ Browser ready with authentication');
}

async function performManualLogin() {
    console.log('\n' + '='.repeat(70));
    console.log('🔐 FIRST-TIME SETUP: Manual Login Required');
    console.log('='.repeat(70));
    console.log('');
    console.log('A Chrome window will open in 3 seconds...');
    console.log('');
    console.log('Please follow these steps:');
    console.log('1. The browser will navigate to Free4Talk');
    console.log('2. Click "Sign in with Google"');
    console.log('3. Login with your bot Gmail account');
    console.log('4. Complete any verification if asked');
    console.log('5. Wait until you see the Free4Talk homepage');
    console.log('6. Come back here and press ENTER in terminal');
    console.log('');
    console.log('⏰ This is ONE-TIME ONLY. After this, bot will auto-login!');
    console.log('='.repeat(70) + '\n');
    
    await new Promise(resolve => setTimeout(resolve, 3000));
    
    // Create new context for manual login
    globalContext = await globalBrowser.newContext();
    const loginPage = await globalContext.newPage();
    
    // Navigate to Free4Talk
    await loginPage.goto('https://www.free4talk.com');
    console.log('📄 Browser opened at Free4Talk...');
    console.log('⏳ Waiting for you to login...\n');
    
    // Wait for user to press Enter
    await new Promise(resolve => {
        const readline = require('readline').createInterface({
            input: process.stdin,
            output: process.stdout
        });
        readline.question('Press ENTER after you have logged in: ', () => {
            readline.close();
            resolve();
        });
    });
    
    // Save authentication state
    console.log('💾 Saving authentication state...');
    const authState = await globalContext.storageState();
    await fs.writeFile(AUTH_STATE_FILE, JSON.stringify(authState, null, 2));
    console.log('✅ Authentication saved! Future runs will auto-login.');
    
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
    const botList = Array.from(activeBots.entries()).map(([id, bot]) => ({
        subscriptionId: id,
        roomKey: bot.roomKey,
        joinedAt: new Date(bot.joinedAt).toISOString(),
        messageCount: bot.chatHistory.length
    }));
    res.json({ bots: botList });
});

app.post('/api/activate', async (req, res) => {
    const { subscriptionId, geminiKey, roomLink } = req.body;
    
    console.log(`📥 Activation request: ${subscriptionId}`);
    
    if (!subscriptionId || !geminiKey || !roomLink) {
        return res.status(400).json({ error: 'Missing required fields' });
    }
    
    if (subscriptionId.length < 5) {
        return res.status(401).json({ error: 'Invalid subscription ID' });
    }
    
    // Extract room info
    const roomMatch = roomLink.match(/room\/([a-zA-Z0-9-]+)/);
    const keyMatch = roomLink.match(/key=([0-9]+)/);
    
    if (!roomMatch) {
        return res.status(400).json({ 
            error: 'Invalid room link format' 
        });
    }
    
    const roomKey = roomMatch[1];
    const accessKey = keyMatch ? keyMatch[1] : null;
    const fullRoomUrl = accessKey 
        ? `https://www.free4talk.com/room/${roomKey}?key=${accessKey}`
        : `https://www.free4talk.com/room/${roomKey}`;
    
    // Check if already active
    if (activeBots.has(subscriptionId)) {
        const existing = activeBots.get(subscriptionId);
        if (existing.roomKey === roomKey) {
            return res.json({ 
                success: true,
                message: 'Bot is already active in this room!',
                status: 'already-active'
            });
        }
        await removeBot(subscriptionId);
    }
    
    // Join the room
    try {
        await joinRoom(subscriptionId, {
            roomKey,
            fullRoomUrl,
            geminiKey: encrypt(geminiKey),
            tier: 'premium'
        });
        
        res.json({ 
            success: true,
            message: 'Bot is joining your room! Check in 30 seconds.',
            roomKey: roomKey
        });
    } catch (error) {
        console.error('❌ Failed to join room:', error);
        res.status(500).json({ 
            error: 'Failed to activate bot: ' + error.message 
        });
    }
});

app.post('/api/deactivate', async (req, res) => {
    const { subscriptionId } = req.body;
    if (!subscriptionId) {
        return res.status(400).json({ error: 'Missing subscription ID' });
    }
    if (activeBots.has(subscriptionId)) {
        await removeBot(subscriptionId);
        res.json({ success: true, message: 'Bot deactivated' });
    } else {
        res.status(404).json({ error: 'Bot not found' });
    }
});

// ====================
// BOT ROOM MANAGEMENT
// ====================

async function joinRoom(subscriptionId, config) {
    console.log(`🔌 Joining room: ${config.roomKey}`);
    
    // Create a NEW browser context (separate "device") with copied auth
    // This is like opening Free4Talk on a different computer/phone
    const context = await globalBrowser.newContext({
        storageState: await globalContext.storageState() // Copy the login session
    });
    
    const page = await context.newPage();
    
    try {
        console.log(`🌐 Navigating to: ${config.fullRoomUrl}`);
        await page.goto(config.fullRoomUrl, { waitUntil: 'networkidle', timeout: 30000 });
        
        console.log(`📄 Page loaded in separate context (like a new device)`);
        await page.waitForTimeout(3000);
        
        // Handle welcome screen
        try {
            await page.keyboard.press('Enter');
            console.log('✓ Pressed Enter on welcome screen');
            await page.waitForTimeout(2000);
        } catch (e) {
            console.log('No welcome screen detected');
        }
        
        console.log(`✓ Bot in room: ${config.roomKey}`);
        await page.waitForTimeout(3000);
        
        // Send intro message
        await sendMessageInRoom(page, '👋 Avatar Spirit Bot is active!');
        
        // Setup message listener
        await setupMessageListener(page, subscriptionId, config);
        
        // Store bot with CONTEXT (important for cleanup)
        activeBots.set(subscriptionId, {
            context,  // Store the context so we can close it later
            page,
            config,
            roomKey: config.roomKey,
            chatHistory: [],
            joinedAt: Date.now()
        });
        
        console.log(`✅ Bot fully active in ${config.roomKey} (separate browser context)`);
        
    } catch (error) {
        console.error(`❌ Error joining room:`, error.message);
        await page.close();
        await context.close(); // Clean up context on error
        throw error;
    }
}


async function setupMessageListener(page, subscriptionId, config) {
    console.log(`👂 Setting up message listener for ${subscriptionId}`);
    
    // Use EXACT selectors from your working extension
    await page.evaluate(() => {
        window.messageQueue = [];
        
        // Check for messages every 2 seconds (same as your extension)
        setInterval(() => {
            const messageBlocks = document.querySelectorAll('.system-message');
            
            messageBlocks.forEach(block => {
                // Skip if already processed
                if (block.dataset.replied) return;
                
                // Skip PM mode messages with quotes (same as your extension)
                const isPmMode = block.classList.contains('pm-mode');
                if (isPmMode) {
                    const hasQuote = block.querySelector('.quote-content');
                    if (hasQuote) {
                        console.log('Skipping PM reply message');
                        block.dataset.replied = 'true';
                        return;
                    }
                }
                
                // Extract message details (EXACT selectors from your extension)
                const message = block.querySelector('.text.main-content p');
                const userName = block.querySelector('.name.primary span');
                const time = block.querySelector('.time span');
                const messageId = block.getAttribute('data-message-id');
                
                if (userName && 
                    userName.textContent !== 'Avatar Spirit' && 
                    userName.textContent !== 'AvatarSpiritBot' &&
                    userName.textContent !== 'Free4Talk System' &&
                    message && 
                    !block.dataset.replied) {
                    
                    const username = userName.textContent.trim();
                    const content = message.textContent.trim();
                    
                    console.log('New message detected:', username, '-', content);
                    
                    window.messageQueue.push({ 
                        username, 
                        content,
                        messageId,
                        isPM: isPmMode
                    });
                    
                    block.dataset.replied = 'true';
                }
            });
        }, 2000);
    });
    
    // Poll for queued messages
    const pollInterval = setInterval(async () => {
        try {
            if (!activeBots.has(subscriptionId)) {
                clearInterval(pollInterval);
                return;
            }
            
            const bot = activeBots.get(subscriptionId);
            
            if (bot.page.isClosed()) {
                console.log(`⚠️ Page closed for ${subscriptionId}`);
                clearInterval(pollInterval);
                activeBots.delete(subscriptionId);
                return;
            }
            
            const messages = await page.evaluate(() => {
                const msgs = window.messageQueue || [];
                window.messageQueue = [];
                return msgs;
            });
            
            if (messages.length > 0) {
                console.log(`📨 Processing ${messages.length} message(s)`);
            }
            
            for (const message of messages) {
                await handleMessage(page, subscriptionId, config, message);
            }
        } catch (error) {
            if (!error.message.includes('closed')) {
                console.error(`Error polling:`, error.message);
            } else {
                clearInterval(pollInterval);
                activeBots.delete(subscriptionId);
            }
        }
    }, 2000);
}

// ====================
// YOUTUBE AUTOMATION (from your extension)
// ====================

const youtubeSelectors = {
    youtubeButton: 'button .youtube-btn',
    searchInput: 'input.ant-input[type="text"][placeholder="Search"]',
    searchButton: 'span.ant-input-suffix .ant-input-search-icon',
    firstVideo: 'ul.ant-list-items li.ant-list-item:first-child div.content-wrapper',
    youtubePanel: 'video',
    videoPlayer: 'video',
    closeButton: '.ant-row-flex-middle'
};

async function executeYouTubePlay(page, query) {
    console.log(`🎵 Starting YouTube automation for: ${query}`);
    
    try {
        // Step 1: Open Applications tab
        console.log('Step 1: Opening Applications tab...');
        const appsOpened = await openApplicationsTab(page);
        if (!appsOpened) {
            console.error('Failed to open Applications tab');
            return false;
        }
        
        // Step 2: Open YouTube in applications
        console.log('Step 2: Opening YouTube...');
        const ytOpened = await openYouTubeInApplications(page);
        if (!ytOpened) {
            console.error('Failed to open YouTube');
            return false;
        }
        
        // Step 3: Search for the query
        console.log(`Step 3: Searching for "${query}"...`);
        const searched = await searchYouTube(page, query);
        if (!searched) {
            console.error('Failed to search');
            return false;
        }
        
        // Step 4: Play first video
        console.log('Step 4: Playing first video...');
        const played = await selectAndPlayFirstVideo(page);
        if (!played) {
            console.error('Failed to play video');
            return false;
        }
        
        console.log('✅ YouTube automation completed successfully!');
        return true;
    } catch (error) {
        console.error('Error in YouTube automation:', error.message);
        return false;
    }
}

async function openApplicationsTab(page) {
    try {
        // Find Applications tab - Playwright compatible
        // Look for div with role="tabpanel" that contains text "Application"
        const appsTab = await page.locator('div[role="tabpanel"] div.blind:has-text("Application")').first();
        
        if (!(await appsTab.isVisible().catch(() => false))) {
            console.error('Applications tab not found');
            return false;
        }
        
        // Check if YouTube button already visible
        const ytBtn = page.locator(youtubeSelectors.youtubeButton);
        if (await ytBtn.isVisible().catch(() => false)) {
            console.log('Applications tab already open');
            return true;
        }
        
        // Click Applications tab
        await appsTab.click();
        console.log('Clicked Applications tab');
        
        // Wait for YouTube button to appear
        try {
            await page.waitForSelector(youtubeSelectors.youtubeButton, { timeout: 2000 });
            console.log('Applications panel opened');
            return true;
        } catch (e) {
            console.error('Timeout: YouTube button did not appear');
            return false;
        }
    } catch (error) {
        console.error('Error opening Applications tab:', error.message);
        return false;
    }
}


async function openYouTubeInApplications(page) {
    try {
        const ytButton = await page.$(youtubeSelectors.youtubeButton);
        
        if (!ytButton) {
            console.error('YouTube button not found');
            return false;
        }
        
        // Check if already open
        const searchInput = await page.$(youtubeSelectors.searchInput);
        if (searchInput && await searchInput.isVisible()) {
            console.log('YouTube panel already open');
            return true;
        }
        
        // Click YouTube button
        await ytButton.click();
        console.log('Clicked YouTube button');
        
        // Wait for search input to appear
        await page.waitForSelector(youtubeSelectors.searchInput, { timeout: 2000 });
        console.log('YouTube panel opened');
        return true;
    } catch (error) {
        console.error('Error opening YouTube:', error.message);
        return false;
    }
}

async function searchYouTube(page, query) {
    try {
        const searchInput = await page.$(youtubeSelectors.searchInput);
        
        if (!searchInput) {
            console.error('Search input not found');
            return false;
        }
        
        // Focus and clear input
        await searchInput.click();
        await page.waitForTimeout(100);
        await searchInput.fill('');
        await page.waitForTimeout(100);
        
        // Type query
        await searchInput.fill(query);
        console.log(`Query entered: ${query}`);
        
        await page.waitForTimeout(300);
        
        // Try clicking search button first
        try {
            const searchBtn = await page.$(youtubeSelectors.searchButton);
            if (searchBtn) {
                await searchBtn.click();
                console.log('Clicked search button');
                return true;
            }
        } catch (e) {
            // Fallback to Enter key
        }
        
        // Fallback: Press Enter
        await searchInput.press('Enter');
        console.log('Pressed Enter key');
        return true;
    } catch (error) {
        console.error('Error searching YouTube:', error.message);
        return false;
    }
}

async function selectAndPlayFirstVideo(page) {
    try {
        console.log('Waiting for video results...');
        
        // Wait for first video to appear
        await page.waitForSelector(youtubeSelectors.firstVideo, { timeout: 5000 });
        
        // Wait a bit for search results to fully load
        console.log('Waiting 2 seconds for results to load...');
        await page.waitForTimeout(2000);
        
        const firstVideo = await page.$(youtubeSelectors.firstVideo);
        
        if (!firstVideo) {
            console.error('First video not found');
            return false;
        }
        
        // Click first video
        await firstVideo.click();
        console.log('Clicked first video');
        
        await page.waitForTimeout(500);
        console.log('Video should be playing');
        return true;
    } catch (error) {
        console.error('Error playing video:', error.message);
        return false;
    }
}

async function stopYouTube(page) {
    try {
        console.log('Stopping YouTube...');
        
        // Try to find and click close/stop button
        const stopBtn = await page.$('button:has-text("Stop")');
        if (stopBtn) {
            await stopBtn.click();
            console.log('Clicked stop button');
            return true;
        }
        
        // Fallback: Click Applications tab to close
        const appsTab = await page.$('div[role="tabpanel"] div.blind');
        if (appsTab) {
            await appsTab.click();
            console.log('Closed via Applications tab');
            return true;
        }
        
        return false;
    } catch (error) {
        console.error('Error stopping YouTube:', error.message);
        return false;
    }
}


async function handleMessage(page, subscriptionId, config, message) {
    const bot = activeBots.get(subscriptionId);
    if (!bot) return;
    
    console.log(`[${subscriptionId}] ${message.username}: ${message.content}`);
    
    bot.chatHistory.push(message);
    if (bot.chatHistory.length > 100) bot.chatHistory.shift();
    
    if (!botLogic.shouldBotRespond(message.content, message.username)) return;
    
    const contentLower = message.content.toLowerCase();
    
    // Handle music commands
    if (contentLower.includes('play') && !contentLower.includes('game')) {
        // Extract song name
        const playMatch = message.content.match(/play\s+(.+)/i);
        if (playMatch && playMatch[1]) {
            const query = playMatch[1].trim();
            console.log(`🎵 Music command: play "${query}"`);
            
            await sendMessageInRoom(page, `🎵 Playing "${query}"...`);
            
            const success = await executeYouTubePlay(page, query);
            
            if (success) {
                await sendMessageInRoom(page, `✅ Now playing: ${query}`);
            } else {
                await sendMessageInRoom(page, `❌ Sorry, couldn't play that song`);
            }
            return;
        }
    }
    
    // Stop command
    if (contentLower.match(/stop|close youtube|exit/i)) {
        console.log('🛑 Stop command');
        await sendMessageInRoom(page, '⏹️ Stopping music...');
        await stopYouTube(page);
        return;
    }
    
    // Regular AI response
    try {
        const geminiKey = decrypt(config.geminiKey);
        const aiReply = await botLogic.getGeminiReply(
            message.username,
            message.content,
            bot.chatHistory,
            geminiKey
        );
        
        if (aiReply) {
            await sendMessageInRoom(page, aiReply);
            bot.chatHistory.push({ username: 'AvatarSpiritBot', content: aiReply });
        }
    } catch (error) {
        console.error('Error generating reply:', error.message);
    }
}


async function sendMessageInRoom(page, text) {
    try {
        // EXACT selectors from your working extension
        const chatInput = await page.$('.input-send-box textarea');
        
        if (!chatInput) {
            console.error('Chat input not found');
            return;
        }
        
        // Clear and type message
        await chatInput.fill(text);
        
        // Wait a bit for input to register
        await page.waitForTimeout(100);
        
        // Click send button (EXACT selector from your extension)
        const sendButton = await page.$('.input-send-box button[type="button"]');
        
        if (sendButton) {
            await sendButton.click();
            console.log('✓ Message sent:', text.substring(0, 50));
            await page.waitForTimeout(1500); // Anti-spam delay
        } else {
            console.error('Send button not found');
        }
    } catch (error) {
        console.error('Error sending message:', error.message);
    }
}


async function removeBot(subscriptionId) {
    const bot = activeBots.get(subscriptionId);
    if (bot) {
        console.log(`🚪 Removing bot: ${subscriptionId}`);
        try {
            await bot.page.close();
            await bot.context.close(); // Close the entire browser context
        } catch (e) {
            console.error('Error closing bot:', e.message);
        }
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
    console.error('Failed to initialize:', error);
    process.exit(1);
});

// Graceful shutdown
process.on('SIGINT', async () => {
    console.log('\n🛑 Shutting down...');
    for (const [id, bot] of activeBots.entries()) {
        await removeBot(id);
    }
    if (globalContext) await globalContext.close();
    if (globalBrowser) await globalBrowser.close();
    console.log('✅ Shutdown complete');
    process.exit(0);
});


