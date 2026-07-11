FROM node:22-alpine3.20

WORKDIR /app

# Install Chromium and all required system dependencies for Puppeteer
RUN apk update && apk add --no-cache \
    chromium \
    nss \
    freetype \
    harfbuzz \
    ca-certificates \
    ttf-freefont \
    font-noto \
    font-noto-emoji \
    fontconfig \
    dbus \
    udev \
    curl \
    && fc-cache -fv

COPY package*.json ./

RUN npm ci --omit=dev

COPY . .

ENV PORT=7860
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true

EXPOSE 7860

CMD ["node", "index.js"]
