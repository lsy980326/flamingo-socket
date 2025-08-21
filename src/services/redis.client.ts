import { Redis } from "ioredis";
import dotenv from "dotenv";
import logger from "../config/logger";

dotenv.config();

const redisOptions = {
  host: process.env.REDIS_HOST || "127.0.0.1",
  port: Number(process.env.REDIS_PORT) || 6379,
  tls: {}, //로컬에서는 주석 운영에서는 활성화
  retryStrategy(times: number) {
    const delay = Math.min(times * 100, 3000); // 재시도 간격 조정
    return delay;
  },
  maxRetriesPerRequest: 3,
};

// 클라이언트 생성 (이 시점부터 자동 연결 시도)
const redisClient = new Redis(redisOptions);
export const pubClient = new Redis(redisOptions);
export const subClient = new Redis(redisOptions);

// 에러 핸들러
redisClient.on("error", (err) =>
  logger.error("Redis (Main Client) Error:", err)
);
pubClient.on("error", (err) => logger.error("Redis (Pub Client) Error:", err));
subClient.on("error", (err) => logger.error("Redis (Sub Client) Error:", err));

// 연결 성공 로그
redisClient.on("connect", () =>
  logger.info("✅ Redis (Main Client) connected")
);
pubClient.on("connect", () => logger.info("✅ Redis (Pub Client) connected"));
subClient.on("connect", () => logger.info("✅ Redis (Sub Client) connected"));

export default redisClient;
