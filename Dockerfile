FROM node:24-slim
WORKDIR /app
COPY package.json ./
COPY web/package.json web/package-lock.json* ./web/
RUN cd web && npm install --no-audit --no-fund
COPY . .
RUN cd web && npx vite build
ENV HOST=0.0.0.0 PORT=8787
EXPOSE 8787
VOLUME /app/data
CMD ["node", "--disable-warning=ExperimentalWarning", "server/index.ts"]
