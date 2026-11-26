FROM node:24-bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 python3-venv \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY backend/package.json backend/package-lock.json ./backend/

WORKDIR /app/backend
RUN npm ci --omit=dev

WORKDIR /app
COPY backend/ ./backend/
COPY ai-service/ ./ai-service/

RUN python3 -m venv /opt/venv \
    && /opt/venv/bin/pip install --no-cache-dir --upgrade pip \
    && /opt/venv/bin/pip install --no-cache-dir -r /app/ai-service/requirements.txt

ENV PYTHON_EXECUTABLE=/opt/venv/bin/python

RUN mkdir -p /app/storage/processed

WORKDIR /app/backend

CMD ["npm", "start"]
