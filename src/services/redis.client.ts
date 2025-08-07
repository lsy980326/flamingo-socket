import { Redis } from "ioredis";
import dotenv from "dotenv";
import logger from "../config/logger";

dotenv.config();

// AWS ElastiCache for Redis의 엔드포인트를 .env 파일에 추가해야 합니다.
// 예: REDIS_URL=redis://my-redis-cluster.xxxxx.ng.0001.apn2.cache.amazonaws.com:6379
const redisClient = new Redis(process.env.REDIS_URL!, {
  // Redis 연결 옵션 (필요 시 추가)
  lazyConnect: true, // 필요할 때만 연결
});

redisClient.on("connect", () => {
  logger.info("✅ Redis connected");
});

redisClient.on("error", (err) => {
  logger.error("Redis connection error:", err);
});

// 명시적으로 연결 시작
redisClient.connect().catch(logger.error);

export default redisClient;
