import { debounce, DebouncedFunc } from "lodash";
import { LayerModel } from "../models/layer.model";
import redisClient from "./redis.client";
import logger from "../config/logger";

// MongoDB에 저장하는 실제 함수
const saveToMongo = async (layerId: string) => {
  const key = `yjs-doc:${layerId}`;
  try {
    // 1. Redis에서 최신 데이터 가져오기
    const docUpdateBuffer = await redisClient.getBuffer(key);

    if (docUpdateBuffer) {
      // 2. MongoDB의 해당 레이어 'data' 필드 업데이트
      await LayerModel.findByIdAndUpdate(layerId, {
        $set: { data: docUpdateBuffer },
      });
      logger.info(`[Persistence] Layer ${layerId} data saved to MongoDB.`);
    }
  } catch (error) {
    logger.error(
      `[Persistence] Failed to save layer ${layerId} to MongoDB:`,
      error
    );
  }
};

// Debounce된 함수들을 저장할 Map
// key: layerId, value: debounce된 saveToMongo 함수
const debouncedSavers = new Map<string, DebouncedFunc<() => Promise<void>>>();

export const debouncedSaveToMongo = (layerId: string) => {
  if (!debouncedSavers.has(layerId)) {
    // 이 layerId에 대한 debounce 함수가 없으면 새로 생성
    // 마지막 호출 후 5000ms (5초)가 지나면 saveToMongo 함수를 실행
    const newDebouncedSaver = debounce(() => saveToMongo(layerId), 5000, {
      leading: false, // 처음 호출 시 즉시 실행하지 않음
      trailing: true, // 그룹의 마지막 호출 후 실행
    });
    debouncedSavers.set(layerId, newDebouncedSaver);
  }

  // 해당 layerId의 debounce 함수를 호출
  debouncedSavers.get(layerId)!();
};

/**
 * 서버 종료 등 비상 상황 시, 현재 Debounce 대기 중인 모든 작업을 즉시 실행
 */
export const flushAllPendingSaves = () => {
  logger.info("[Persistence] Flushing all pending saves to MongoDB...");
  debouncedSavers.forEach((saver) => saver.flush());
};
