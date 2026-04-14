FROM node:22-alpine

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .

ENTRYPOINT ["npx", "tsx", "src/index.ts"]
CMD ["sync"]
