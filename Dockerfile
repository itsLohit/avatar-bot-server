FROM mcr.microsoft.com/playwright:v1.48.0-focal

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install

# Install Playwright browsers
RUN npx playwright install

# Copy app code
COPY . .

# Expose port
EXPOSE 3000

# Start app
CMD ["node", "server.js"]
