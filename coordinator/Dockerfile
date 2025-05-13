# Base image
FROM node:20-alpine

# Create app directory
WORKDIR /usr/src/app

# Copy package files for dependency installation
COPY package*.json ./

# Install dependencies
RUN npm ci --only=production

# Copy the rest of the application code
COPY . .

# Build TypeScript code
RUN npm run build

# Expose the port the app runs on
EXPOSE 8000

# Run as non-root user for security
USER node

# Command to run the application
CMD ["node", "dist/server.js"]