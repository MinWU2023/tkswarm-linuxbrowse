FROM node:20-bookworm-slim

# 内核策略：跟随 bookworm 的 chromium 大版本；升级镜像前先在 staging 跑 smoke:all。
# 可用 TKSWARM_CHROME_PATH 覆盖；生产勿在宿主机随意 apt upgrade chromium 后不测。
# 字体：西文 + CJK + 常用 emoji，减少坐席目标市场渲染/指纹差异
RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    xvfb \
    x11vnc \
    ffmpeg \
    fonts-liberation \
    fonts-noto-cjk \
    fonts-noto-color-emoji \
    fonts-dejavu-core \
    fonts-freefont-ttf \
    ca-certificates \
    && chromium --version || true \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev || npm install --omit=dev --ignore-scripts

COPY . .

ENV TKSWARM_BROWSER_HOST=0.0.0.0 \
    TKSWARM_BROWSER_PORT=54345 \
    TKSWARM_BROWSER_DATA=/data \
    TKSWARM_CHROME_PATH=/usr/bin/chromium \
    TKSWARM_CHROME_NO_SANDBOX=1 \
    TKSWARM_BROWSER_XVFB=1 \
    TKSWARM_BROWSER_MAX_CONCURRENT=40

VOLUME ["/data"]
EXPOSE 54345

CMD ["node", "src/server/main.js"]
